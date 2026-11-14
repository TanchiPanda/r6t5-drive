// 自研 ZIP 读写（零外部依赖，仅使用 node:zlib / node:fs / node:stream）。
// 协议：APPNOTE 6.3.x；支持 store(0) / deflate(8)，UTF-8 文件名（flag bit 11），
// 数据描述符（bit 3）流式写；不支持 ZIP64（单包/单条目 > 4 GiB 按上限拒绝）。
//
// 写路径：ZipWriter 逐条把上游文件流经 deflate/passthrough 泵到输出流，
//         仅在内存中保留中央目录记录（文件名 + 元数据），文件内容不落地、不整包缓冲。
// 读路径：ZipReader 先定位 EOCD → 中央目录 → 逐条 Local File Header，
//         单条目用 createInflateRaw 流式解压并校验 CRC32。

import fs from 'node:fs';
import zlib from 'node:zlib';
import { pipeline } from 'node:stream/promises';
import { Transform, Readable } from 'node:stream';
import { zipInvalid, zipTooLarge, zipTooManyEntries, zipSlipBlocked, quotaFile } from './errors.js';

// ---- 上限（与接口契约一致）----
export const MAX_ENTRIES = 10_000;
export const MAX_TOTAL_BYTES = 5n * 1024n * 1024n * 1024n; // 5 GiB
const ZIP32_LIMIT = 0xffffffff;

export const METHOD_STORE = 0;
export const METHOD_DEFLATE = 8;

const FLAG_UTF8 = 0x0800;   // bit 11：文件名 UTF-8
const FLAG_DATA_DESC = 0x0008; // bit 3：使用数据描述符

const SIG_LOCAL = 0x04034b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_EOCD = 0x06054b50;
const SIG_DATA_DESC = 0x08074b50;

// ---- CRC32（查表法）----
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(buf, prev = 0) {
  let c = (prev ^ 0xffffffff) >>> 0;
  for (let i = 0; i < buf.length; i += 1) {
    c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function dosDateTime(d = new Date()) {
  const time = (d.getHours() << 11) | (d.getMinutes() << 5) | (Math.floor(d.getSeconds() / 2) & 0x1f);
  const date = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  return { time: time & 0xffff, date: date & 0xffff };
}

function u16(n) { const b = Buffer.alloc(2); b.writeUInt16LE(n >>> 0, 0); return b; }
function u32(n) { const b = Buffer.alloc(4); b.writeUInt32LE(n >>> 0, 0); return b; }

// ---- 流式计数 / CRC 变换 ----
class CountTransform extends Transform {
  constructor() { super(); this.bytes = 0; }
  _transform(chunk, _enc, cb) { this.bytes += chunk.length; cb(null, chunk); }
}

class PassthroughTransform extends Transform {
  _transform(chunk, _enc, cb) { cb(null, chunk); }
}

class CrcTransform extends Transform {
  constructor() { super(); this.crc = 0; }
  _transform(chunk, _enc, cb) { this.crc = crc32(chunk, this.crc); cb(null, chunk); }
}

// ====================================================================
// 写：ZipWriter
// ====================================================================
export class ZipWriter {
  /**
   * @param {NodeJS.WritableStream} out 输出流（HTTP res 或文件写流）
   * @param {{level?:number, method?:number}} opts
   */
  constructor(out, { level = 6, method = METHOD_DEFLATE } = {}) {
    this.out = out;
    this.level = level;
    this.defaultMethod = method;
    this.entries = [];       // 中央目录记录（内存中仅存元数据）
    this.offset = 0;         // 当前已写字节偏移
    this.finished = false;
    this.aborted = false;
    this._sources = [];      // 进行中的上游流，中断时销毁
  }

  _trackSource(stream) {
    this._sources.push(stream);
    stream.on('close', () => {
      this._sources = this._sources.filter((s) => s !== stream);
    });
    return stream;
  }

  /** 中断：销毁所有进行中的上游流，停止读取 */
  abort() {
    this.aborted = true;
    for (const s of this._sources) {
      try { s.destroy(); } catch { /* noop */ }
    }
    this._sources = [];
  }

  async _write(buf) {
    if (this.aborted) throw zipInvalid('写入已被中断', { stage: 'writer' });
    await new Promise((resolve, reject) => {
      if (this.out.write(buf)) return resolve();
      this.out.once('drain', resolve);
      this.out.once('error', reject);
    });
    this.offset += buf.length;
  }

  /**
   * 追加一个文件条目。
   * @param {string} name ZIP 内相对路径（UTF-8）
   * @param {NodeJS.ReadableStream} source 文件内容流
   * @param {{method?:number, isDir?:boolean}} opts
   */
  async addFile(name, source, { method = this.defaultMethod, isDir = false } = {}) {
    if (this.finished) throw zipInvalid('ZipWriter 已 finish', { stage: 'addFile' });
    if (this.entries.length >= MAX_ENTRIES) {
      throw zipTooManyEntries({ entries: this.entries.length + 1, limit: MAX_ENTRIES });
    }
    const nameBuf = Buffer.from(name, 'utf8');
    const { time, date } = dosDateTime();
    const flags = FLAG_UTF8 | FLAG_DATA_DESC;
    const localOffset = this.offset;

    // Local File Header（CRC / 尺寸先填 0，靠数据描述符回写）
    const header = Buffer.concat([
      u32(SIG_LOCAL), u16(20), u16(flags), u16(method),
      u16(time), u16(date), u32(0), u32(0), u32(0),
      u16(nameBuf.length), u16(0), nameBuf,
    ]);
    await this._write(header);

    let crc = 0;
    let compSize = 0;
    let uncompSize = 0;

    if (!isDir) {
      const crcStream = new CrcTransform();
      const countUncomp = new CountTransform();
      const countComp = new CountTransform();
      const compress = method === METHOD_DEFLATE
        ? zlib.createDeflateRaw({ level: this.level })
        : new PassthroughTransform();

      // 内层管道不接管外层 out（避免 pipeline 在每条目结束时关掉输出流）；
      // 压缩后数据手动 pipe 到 out，{ end: false } 保持流开放。
      this._trackSource(source);
      countComp.pipe(this.out, { end: false });
      try {
        await pipeline(source, countUncomp, crcStream, compress, countComp);
      } finally {
        countComp.unpipe(this.out);
      }

      crc = crcStream.crc;
      uncompSize = countUncomp.bytes;
      compSize = countComp.bytes;
      this.offset += compSize; // 流式直写 out 的字节需手动计入偏移
    }

    // ZIP32 上限校验（不支持 ZIP64）
    if (uncompSize > ZIP32_LIMIT || compSize > ZIP32_LIMIT) {
      throw zipTooLarge({ entry: name, uncompressedSize: uncompSize, compressedSize: compSize, limitBytes: ZIP32_LIMIT });
    }

    // 数据描述符
    const descriptor = Buffer.concat([
      u32(SIG_DATA_DESC), u32(crc), u32(compSize), u32(uncompSize),
    ]);
    await this._write(descriptor);

    this.entries.push({
      name, nameBuf, method, crc, compSize, uncompSize, localOffset,
      isDir, flags, time, date,
    });
  }

  /** 写完所有条目：中央目录 + EOCD */
  async finish() {
    if (this.finished) return;
    this.finished = true;

    const cdStart = this.offset;
    const centralChunks = [];
    for (const e of this.entries) {
      const externalAttrs = e.isDir ? (0o40755 << 16) : (0o644 << 16);
      const rec = Buffer.concat([
        u32(SIG_CENTRAL), u16(20), u16(20), u16(e.flags), u16(e.method),
        u16(e.time), u16(e.date), u32(e.crc), u32(e.compSize), u32(e.uncompSize),
        u16(e.nameBuf.length), u16(0), u16(0), u16(0), u16(0),
        u32(externalAttrs), u32(e.localOffset), e.nameBuf,
      ]);
      centralChunks.push(rec);
    }
    const cdBuf = Buffer.concat(centralChunks);
    await this._write(cdBuf);
    const cdSize = cdBuf.length;

    const eocd = Buffer.concat([
      u32(SIG_EOCD), u16(0), u16(0),
      u16(this.entries.length), u16(this.entries.length),
      u32(cdSize), u32(cdStart), u16(0),
    ]);
    await this._write(eocd);
  }
}

// ====================================================================
// 读：ZipReader（基于本地 fd 定位，条目内容流式解压）
// ====================================================================
function readBuf(fd, start, length) {
  const buf = Buffer.alloc(length);
  const n = fs.readSync(fd, buf, 0, length, start);
  if (n !== length) throw zipInvalid('读取 ZIP 字节不完整', { start, length, read: n });
  return buf;
}

export class ZipReader {
  constructor(fd, size, filePath) {
    this.fd = fd;
    this.size = size;
    this.filePath = filePath;
    this.entries = [];
  }

  static open(filePath) {
    const fd = fs.openSync(filePath, 'r');
    let size;
    try { size = fs.fstatSync(fd).size; } catch (e) { fs.closeSync(fd); throw e; }
    return new ZipReader(fd, size, filePath);
  }

  close() {
    try { fs.closeSync(this.fd); } catch { /* noop */ }
  }

  /** 解析 EOCD + 中央目录，返回条目元数据数组 */
  readEntries() {
    if (this.entries.length) return this.entries;
    if (this.size < 22) throw zipInvalid('文件过小，不是有效的 ZIP', { size: this.size });

    // EOCD 最多带 65535 字节注释；从尾部 65557 字节内回扫签名
    const scanLen = Math.min(this.size, 65557);
    const tail = readBuf(this.fd, this.size - scanLen, scanLen);
    let eocdOff = -1;
    for (let i = tail.length - 22; i >= 0; i -= 1) {
      if (tail.readUInt32LE(i) === SIG_EOCD) { eocdOff = this.size - scanLen + i; break; }
    }
    if (eocdOff < 0) throw zipInvalid('未找到 ZIP 中央目录结束记录（EOCD），文件可能已截断');

    const cdEntries = tail.readUInt16LE(eocdOff + 10);
    const cdSize = tail.readUInt32LE(eocdOff + 12);
    const cdOffset = tail.readUInt32LE(eocdOff + 16);
    if (cdEntries === 0) throw zipInvalid('ZIP 内没有任何条目');
    if (cdOffset + cdSize > this.size) throw zipInvalid('中央目录越界，文件已损坏');

    const cd = readBuf(this.fd, cdOffset, cdSize);
    let p = 0;
    for (let i = 0; i < cdEntries; i += 1) {
      if (p + 46 > cd.length) throw zipInvalid('中央目录记录不完整', { index: i });
      if (cd.readUInt32LE(p) !== SIG_CENTRAL) throw zipInvalid('中央目录签名错误', { index: i, offset: p });
      const flags = cd.readUInt16LE(p + 8);
      const method = cd.readUInt16LE(p + 10);
      const crc = cd.readUInt32LE(p + 16);
      const compSize = cd.readUInt32LE(p + 20);
      const uncompSize = cd.readUInt32LE(p + 24);
      const nameLen = cd.readUInt16LE(p + 28);
      const extraLen = cd.readUInt16LE(p + 30);
      const commentLen = cd.readUInt16LE(p + 32);
      const externalAttrs = cd.readUInt32LE(p + 38);
      const localOffset = cd.readUInt32LE(p + 42);
      const nameBuf = cd.slice(p + 46, p + 46 + nameLen);
      const name = (flags & FLAG_UTF8) ? nameBuf.toString('utf8') : nameBuf.toString('latin1');
      p += 46 + nameLen + extraLen + commentLen;

      this.entries.push({
        name, method, crc, compSize, uncompSize, externalAttrs, localOffset,
        isDir: name.endsWith('/'),
      });
    }
    return this.entries;
  }

  /** 定位某条目 Local File Header 的数据起始偏移 */
  _dataStart(entry) {
    const lh = readBuf(this.fd, entry.localOffset, 30);
    if (lh.readUInt32LE(0) !== SIG_LOCAL) throw zipInvalid('本地文件头签名错误', { entry: entry.name });
    const nameLen = lh.readUInt16LE(26);
    const extraLen = lh.readUInt16LE(28);
    return entry.localOffset + 30 + nameLen + extraLen;
  }

  /**
   * 流式读取条目内容（store/deflate），返回 { stream, verify }。
   * verify() 在流结束后校验 CRC32。
   */
  openEntry(entry) {
    // 目录条目 / 空条目：无数据段，返回空流
    if (!entry.compSize) {
      return { stream: Readable.from([]), verify() {} };
    }
    const start = this._dataStart(entry);
    const end = start + entry.compSize;
    if (end > this.size) throw zipInvalid('条目数据越界，文件已损坏', { entry: entry.name });
    const raw = fs.createReadStream(this.filePath, { fd: this.fd, start, end: end - 1, autoClose: false });
    let stream = raw;
    if (entry.method === METHOD_DEFLATE) {
      stream = raw.pipe(zlib.createInflateRaw());
    } else if (entry.method !== METHOD_STORE) {
      throw zipInvalid('不支持的压缩方法', { entry: entry.name, method: entry.method });
    }
    const crcState = { crc: 0, bytes: 0 };
    const crcTap = new Transform({
      transform(chunk, _e, cb) {
        crcState.crc = crc32(chunk, crcState.crc);
        crcState.bytes += chunk.length;
        cb(null, chunk);
      },
    });
    stream = stream.pipe(crcTap);
    return {
      stream,
      verify() {
        if (crcState.crc !== entry.crc) {
          throw zipInvalid('CRC32 校验失败，内容已损坏', { entry: entry.name, expect: entry.crc, actual: crcState.crc });
        }
        if (crcState.bytes !== entry.uncompSize) {
          throw zipInvalid('解压字节数与中央目录不一致', { entry: entry.name, expect: entry.uncompSize, actual: crcState.bytes });
        }
      },
    };
  }

  /** 把条目解压到目标文件（流式 + CRC 校验） */
  async extractToFile(entry, destFile) {
    const { stream, verify } = this.openEntry(entry);
    const out = fs.createWriteStream(destFile);
    await pipeline(stream, out);
    verify();
  }
}

// ====================================================================
// 安全校验：zip slip / 绝对路径 / 反斜杠 / 符号链接 / 空名
// ====================================================================
const S_IFLNK = 0o120000;
const S_IFMT = 0o170000;

/** 校验条目名是否落在目标目录之内；返回 { ok, reason } */
export function checkSafeEntryName(name) {
  if (typeof name !== 'string' || name.length === 0) {
    return { ok: false, reason: 'empty_name' };
  }
  if (name.includes('\\')) return { ok: false, reason: 'backslash_path' };
  if (name.startsWith('/')) return { ok: false, reason: 'absolute_path' };
  if (/^[A-Za-z]:/.test(name)) return { ok: false, reason: 'windows_drive' };
  const segs = name.split('/');
  for (const seg of segs) {
    if (seg === '..') return { ok: false, reason: 'parent_segment' };
    if (seg === '') return { ok: false, reason: 'empty_segment' };
  }
  return { ok: true };
}

/** external attrs 高 16 位为 Unix mode；判断是否符号链接条目 */
export function isSymlinkEntry(externalAttrs) {
  const mode = (externalAttrs >>> 16) & 0xffff;
  return (mode & S_IFMT) === S_IFLNK;
}

/** 统一的解压前安全/上限校验，命中即抛对应 helper（整个解压中止） */
export function assertExtractSafe(entries, quota) {
  if (entries.length > MAX_ENTRIES) {
    throw zipTooManyEntries({ entries: entries.length, limit: MAX_ENTRIES });
  }
  let total = 0;
  for (const e of entries) {
    const safe = checkSafeEntryName(e.name);
    if (!safe.ok) throw zipSlipBlocked({ entry: e.name, reason: safe.reason });
    if (isSymlinkEntry(e.externalAttrs)) {
      throw zipSlipBlocked({ entry: e.name, reason: 'symlink_entry' });
    }
    if (e.uncompSize > ZIP32_LIMIT) {
      throw zipTooLarge({ entry: e.name, uncompressedSize: e.uncompSize, limitBytes: ZIP32_LIMIT });
    }
    if (quota && e.uncompSize > quota.maxFileSizeBytes) {
      throw quotaFile({ limitBytes: quota.maxFileSizeBytes, sizeBytes: e.uncompSize, entry: e.name });
    }
    total += e.uncompSize;
    if (BigInt(total) > MAX_TOTAL_BYTES) {
      throw zipTooLarge({ totalBytes: total, limitBytes: Number(MAX_TOTAL_BYTES) });
    }
  }
  return total;
}
