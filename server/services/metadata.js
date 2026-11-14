// P5 媒体元数据解析（纯 JS，仅使用 node:fs / node:buffer / node:zlib 内建能力，
// 不调用 ffmpeg / ffprobe / 任何系统命令，不整文件入内存）。
//
// 对外主入口：`parseMedia({ head, sizeBytes, mime, logicalPath })`
//   - head：文件头部 Buffer（调用方只喂 ≤ HEAD_LIMIT 字节）
//   - 返回：{ kind, media, parsed, reason }
//   - 解析失败一律 parsed:false + 中文 reason，不抛异常；数字字段保留 2 位小数。
//
// 支持格式：
//   图片  PNG / JPEG(SOF0/1/2) / GIF / WebP(VP8/VP8L/VP8X) / BMP / AVIF(ispe)
//   视频  MP4 / MOV / M4V / M4A（ISO BMFF）；WebM / MKV（EBML）
//   音频  MP3（ID3v2 + 帧头 + Xing/Info；CBR 大小估算并标 estimated）；WAV
// 不支持：SVG（矢量，无固定像素尺寸）、HEIC/HEIF（未实现）、FLAC/OGG/OPUS/AAC 裸流。

// ---- 分类表（扩展名 / MIME）----

const IMAGE_EXT = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'avif', 'heic', 'heif']);
const VIDEO_EXT = new Set(['mp4', 'mov', 'm4v', 'webm', 'mkv', '3gp', 'ogv']);
const AUDIO_EXT = new Set(['mp3', 'wav', 'm4a', 'aac', 'flac', 'ogg', 'opus', 'oga']);

const EXT_RE = /\.([a-z0-9]+)$/i;

function extOf(logicalPath) {
  const name = String(logicalPath || '').split('/').pop() || '';
  const m = name.match(EXT_RE);
  return m ? m[1].toLowerCase() : '';
}

/** 按扩展名 + MIME 粗分 image / video / audio / other。 */
export function classifyMedia(logicalPath, mime) {
  const ext = extOf(logicalPath);
  if (IMAGE_EXT.has(ext)) return { kind: 'image', ext };
  if (VIDEO_EXT.has(ext)) return { kind: 'video', ext };
  if (AUDIO_EXT.has(ext)) return { kind: 'audio', ext };
  const m = String(mime || '').toLowerCase();
  if (m.startsWith('image/')) return { kind: 'image', ext };
  if (m.startsWith('video/')) return { kind: 'video', ext };
  if (m.startsWith('audio/')) return { kind: 'audio', ext };
  return { kind: 'other', ext };
}

// ---- 数字规整：时长 / 尺寸保留 2 位小数；尺寸为整数 ----

function round2(v) {
  if (!Number.isFinite(v)) return null;
  return Math.round(v * 100) / 100;
}

// =====================================================================
// 图片解析
// =====================================================================

function parsePng(buf) {
  // 8 字节签名后：IHDR box：长度(4) + 'IHDR'(4) + width(4) + height(4)
  if (buf.length < 24) return null;
  if (buf.toString('ascii', 12, 16) !== 'IHDR') return null;
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20), format: 'png' };
}

function parseJpeg(buf) {
  if (buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) return null;
  let off = 2;
  const len = buf.length;
  // SOF 标记：0xC0 SOF0 / 0xC1 SOF1 / 0xC2 SOF2
  const SOF = new Set([0xc0, 0xc1, 0xc2]);
  while (off + 4 < len) {
    if (buf[off] !== 0xff) return null;
    const marker = buf[off + 1];
    // 无长度段：SOI/EOI/RSTn
    if (marker === 0xd8 || marker === 0xd9 || (marker >= 0xd0 && marker <= 0xd7)) {
      off += 2;
      continue;
    }
    const segLen = buf.readUInt16BE(off + 2);
    if (segLen < 2 || off + 2 + segLen > len) return null;
    if (SOF.has(marker)) {
      // 段内：精度(1) + height(2) + width(2)
      const height = buf.readUInt16BE(off + 5);
      const width = buf.readUInt16BE(off + 7);
      return { width, height, format: 'jpeg' };
    }
    off += 2 + segLen;
  }
  return null;
}

function parseGif(buf) {
  // GIF87a / GIF89a：6 字节签名 + 逻辑屏幕描述符：width(2 LE) + height(2 LE)
  if (buf.length < 10) return null;
  const sig = buf.toString('ascii', 0, 6);
  if (sig !== 'GIF87a' && sig !== 'GIF89a') return null;
  return { width: buf.readUInt16LE(6), height: buf.readUInt16LE(8), format: 'gif' };
}

function parseBmp(buf) {
  if (buf.length < 26 || buf[0] !== 0x42 || buf[1] !== 0x4d) return null; // 'BM'
  const headerSize = buf.readUInt32LE(14);
  if (headerSize < 12) return null;
  let width, height;
  if (headerSize >= 40) {
    width = buf.readInt32LE(18);
    height = Math.abs(buf.readInt32LE(22));
  } else {
    width = buf.readUInt16LE(18);
    height = Math.abs(buf.readInt16LE(22));
  }
  if (width <= 0 || height <= 0) return null;
  return { width, height, format: 'bmp' };
}

function parseWebp(buf) {
  if (buf.length < 16) return null;
  if (buf.toString('ascii', 0, 4) !== 'RIFF') return null;
  if (buf.toString('ascii', 8, 12) !== 'WEBP') return null;
  const chunk = buf.toString('ascii', 12, 16);
  // VP8 （有损）
  if (chunk === 'VP8 ') {
    // 12 字节 chunk 头后：3 字节 tag + 帧头；宽高在 tag 之后的 Scaling 前
    if (buf.length < 30) return null;
    const width = buf.readUInt16LE(26) & 0x3fff;
    const height = buf.readUInt16LE(28) & 0x3fff;
    return { width, height, format: 'webp' };
  }
  // VP8L（无损）
  if (chunk === 'VP8L') {
    if (buf.length < 25) return null;
    // 12 字节 chunk 头 + 1 字节 signature 0x2f；随后 14 bit 宽-1 / 14 bit 高-1
    const b0 = buf[21];
    const b1 = buf[22];
    const b2 = buf[23];
    const b3 = buf[24];
    const width = ((b1 & 0x3f) << 8 | b0) + 1;
    const height = ((b3 & 0x0f) << 10 | b2 << 2 | (b1 & 0xc0) >> 6) + 1;
    return { width, height, format: 'webp' };
  }
  // VP8X（扩展）
  if (chunk === 'VP8X') {
    if (buf.length < 30) return null;
    const width = 1 + (buf[24] | (buf[25] << 8) | ((buf[26] & 0x0f) << 16));
    const height = 1 + ((buf[26] >> 4) | (buf[27] << 4) | (buf[28] << 12));
    return { width, height, format: 'webp' };
  }
  return null;
}

// ---- ISO BMFF box 遍历（MP4 / MOV / M4A）----

const CONTAINER_BOXES = new Set(['moov', 'trak', 'mdia', 'minf', 'stbl', 'udta', 'edts', 'mvex']);

function boxType(buf, off) {
  return buf.toString('ascii', off + 4, off + 8);
}

/**
 * 递归遍历 box，收集需要的信息。
 * @param {Buffer} buf 头部字节
 * @param {number} start 起始偏移
 * @param {number} end 结束偏移
 * @param {object} out 累积结果
 */
function walkBmff(buf, start, end, out) {
  let off = start;
  while (off + 8 <= end) {
    let size = buf.readUInt32BE(off);
    let header = 8;
    if (size === 1) {
      if (off + 16 > end) break;
      size = Number(buf.readBigUInt64BE(off + 8));
      header = 16;
    } else if (size === 0) {
      size = end - off; // 延伸到文件尾
    }
    if (size < header || off + size > end) break;
    const type = boxType(buf, off);
    const bodyStart = off + header;
    const bodyEnd = off + size;

    if (CONTAINER_BOXES.has(type)) {
      walkBmff(buf, bodyStart, bodyEnd, out);
    } else if (type === 'mvhd' || type === 'mdhd') {
      parseMvhdMdhd(buf, bodyStart, bodyEnd, out, type);
    } else if (type === 'tkhd') {
      parseTkhd(buf, bodyStart, bodyEnd, out);
    } else if (type === 'stsd') {
      parseStsd(buf, bodyStart, bodyEnd, out);
    }
    off += size;
  }
}

function parseMvhdMdhd(buf, start, end, out, type) {
  if (end - start < 4) return;
  const version = buf[start];
  if (version === 1) {
    // version1：flags(3) + creation(8) + modification(8) + timescale(4) + duration(8)
    if (end - start < 28) return;
    const timescale = buf.readUInt32BE(start + 20);
    const duration = Number(buf.readBigUInt64BE(start + 24));
    if (type === 'mvhd') {
      out.mvhdTimescale = timescale;
      out.mvhdDuration = duration;
    } else if (!out.mdhdTimescale) {
      out.mdhdTimescale = timescale;
      out.mdhdDuration = duration;
    }
  } else {
    // version0：flags(3) + creation(4) + modification(4) + timescale(4) + duration(4)
    if (end - start < 16) return;
    const timescale = buf.readUInt32BE(start + 12);
    const duration = buf.readUInt32BE(start + 16);
    if (type === 'mvhd') {
      out.mvhdTimescale = timescale;
      out.mvhdDuration = duration;
    } else if (!out.mdhdTimescale) {
      out.mdhdTimescale = timescale;
      out.mdhdDuration = duration;
    }
  }
}

function parseTkhd(buf, start, end, out) {
  if (end - start < 4) return;
  const version = buf[start];
  let fixedWidth, fixedHeight;
  if (version === 1) {
    // flags(3) + creation(8) + modification(8) + trackId(4) + reserved(4) + duration(8)
    // + reserved(8) + layer(2) + alt(2) + volume(2) + reserved(2) + matrix(36)
    // + width(16.16) + height(16.16)
    if (end - start < 92) return;
    fixedWidth = buf.readUInt32BE(start + 84);
    fixedHeight = buf.readUInt32BE(start + 88);
  } else {
    if (end - start < 84) return;
    fixedWidth = buf.readUInt32BE(start + 76);
    fixedHeight = buf.readUInt32BE(start + 80);
  }
  const width = Math.round(fixedWidth / 65536);
  const height = Math.round(fixedHeight / 65536);
  if (width > 0 && height > 0) {
    out.tkhdWidth = width;
    out.tkhdHeight = height;
  }
}

function parseStsd(buf, start, end, out) {
  // stsd：version(1)+flags(3) + entry_count(4)；随后每个 sample entry：
  // size(4) + format(4) + reserved(6) + data_ref_index(2) ...
  if (end - start < 8) return;
  const entryCount = buf.readUInt32BE(start + 4);
  if (!Number.isInteger(entryCount) || entryCount <= 0 || entryCount > 1024) return;
  let off = start + 8;
  for (let i = 0; i < entryCount && off + 8 <= end; i += 1) {
    const entrySize = buf.readUInt32BE(off);
    if (entrySize < 8 || off + entrySize > end) break;
    const format = buf.toString('ascii', off + 4, off + 8);
    if (/^(avc1|avc3|hvc1|hev1|mp4v|s263)$/.test(format)) {
      out.videoCodec = format;
    } else if (/^(mp4a|esds|ac-3|ec-3|alac|flac)$/.test(format)) {
      out.audioCodec = format;
    }
    off += entrySize;
  }
}

function parseBmff(buf) {
  if (buf.length < 12) return null;
  // 允许 ftyp / free / mdat 前置；根层遍历即可定位 moov
  const out = {};
  walkBmff(buf, 0, buf.length, out);

  let durationSec = null;
  if (out.mvhdTimescale && out.mvhdDuration) {
    durationSec = out.mvhdDuration / out.mvhdTimescale;
  } else if (out.mdhdTimescale && out.mdhdDuration) {
    durationSec = out.mdhdDuration / out.mdhdTimescale;
  }
  const codec = out.videoCodec || out.audioCodec || null;
  const width = out.tkhdWidth ?? null;
  const height = out.tkhdHeight ?? null;

  // 既没有时长也没有分辨率也没有编码，视为解析失败
  if (durationSec == null && width == null && height == null && codec == null) return null;

  return {
    durationSec: round2(durationSec),
    width,
    height,
    codec,
  };
}

// ---- AVIF：在 moov/meta 里找 'ispe' box ----

function walkAvif(buf, start, end, out) {
  let off = start;
  while (off + 8 <= end) {
    let size = buf.readUInt32BE(off);
    let header = 8;
    if (size === 1) {
      if (off + 16 > end) break;
      size = Number(buf.readBigUInt64BE(off + 8));
      header = 16;
    } else if (size === 0) {
      size = end - off;
    }
    if (size < header || off + size > end) break;
    const type = boxType(buf, off);
    const bodyStart = off + header;
    const bodyEnd = off + size;
    if (type === 'ispe') {
      if (bodyEnd - bodyStart >= 8) {
        out.width = buf.readUInt32BE(bodyStart + 4);
        out.height = buf.readUInt32BE(bodyStart + 8);
        out.format = 'avif';
        return;
      }
    }
    if (CONTAINER_BOXES.has(type) || type === 'meta' || type === 'iprp' || type === 'ipco' || type === 'pitm') {
      walkAvif(buf, bodyStart, bodyEnd, out);
    }
    off += size;
  }
}

function parseAvif(buf) {
  if (buf.length < 12) return null;
  const out = {};
  walkAvif(buf, 0, buf.length, out);
  if (out.width > 0 && out.height > 0) return out;
  return null;
}

// =====================================================================
// MP3 解析
// =====================================================================

const MP3_BITRATES = {
  // MPEG1
  3: [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 0],
  2: [0, 32, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 384, 0],
  1: [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 0],
  // MPEG2 / 2.5
  0: [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160, 0],
};
const MP3_SAMPLERATES = {
  3: [44100, 48000, 32000, 0],
  2: [22050, 24000, 16000, 0],
  1: [11025, 12000, 8000, 0],
  0: [0, 0, 0, 0],
};

function mp3HeaderAt(buf, off) {
  if (off + 4 > buf.length) return null;
  // 帧同步 0xffe / 0xfff
  if (buf[off] !== 0xff || (buf[off + 1] & 0xe0) !== 0xe0) return null;
  const b1 = buf[off + 1];
  const b2 = buf[off + 2];
  const versionBits = (b1 >> 3) & 0x03; // 0=MPEG2.5 1=预留 2=MPEG2 3=MPEG1
  const layerBits = (b1 >> 1) & 0x03;   // 1=Layer III 2=Layer II 3=Layer I
  if (versionBits === 1 || layerBits === 0) return null;
  const versionKey = versionBits; // 直接作查表键（3=MPEG1, 2=MPEG2, 0=MPEG2.5）
  const brIndex = (b2 >> 4) & 0x0f;
  const srIndex = (b2 >> 2) & 0x03;
  const channelMode = (buf[off + 3] >> 6) & 0x03;
  const bitrate = MP3_BITRATES[versionKey][brIndex] * 1000;
  const sampleRate = MP3_SAMPLERATES[versionKey][srIndex];
  if (!bitrate || !sampleRate) return null;
  const channels = channelMode === 3 ? 1 : 2;
  // 每帧采样数：Layer I 384；Layer II/III 在 MPEG1 为 1152，MPEG2/2.5 为 576
  // layerBits：1=Layer III, 2=Layer II, 3=Layer I
  const layer = layerBits;
  const samplesPerFrame = layer === 3 ? 384
    : versionKey === 3 ? 1152 : 576;
  return { bitrate, sampleRate, channels, samplesPerFrame, layer, versionKey };
}

function parseMp3(buf, sizeBytes) {
  let off = 0;
  // 跳过 ID3v2
  if (buf.length >= 10 && buf.toString('ascii', 0, 3) === 'ID3') {
    const flags = buf[5];
    const tagSize = ((buf[6] & 0x7f) << 21) | ((buf[7] & 0x7f) << 14) |
      ((buf[8] & 0x7f) << 7) | (buf[9] & 0x7f);
    off = 10 + tagSize + ((flags & 0x10) ? 10 : 0); // 尾部填充位
  }

  // 在头部窗口内找第一个合法帧头
  let frame = null;
  let frameOff = -1;
  const scanEnd = Math.min(buf.length, off + 65536);
  for (let i = off; i < scanEnd; i += 1) {
    const h = mp3HeaderAt(buf, i);
    if (h) { frame = h; frameOff = i; break; }
  }
  if (!frame) return null;

  // 帧内搜索 Xing / Info 标记（VBR 总帧数 / 总时长）。
  // 标记位置：标准为帧头后第 4 字节；个别编码器放在帧头后第 36/40 字节附近，
  // 在头部窗口内做一次有限范围扫描兜底。
  let totalFrames = null;
  let xingBitrate = null;
  let tag = buf.toString('ascii', frameOff + 4, frameOff + 8);
  let tagOff = frameOff + 4;
  if (tag !== 'Xing' && tag !== 'Info') {
    const scanTo = Math.min(buf.length, frameOff + 64);
    for (let i = frameOff + 4; i < scanTo; i += 1) {
      const cand = buf.toString('ascii', i, i + 4);
      if (cand === 'Xing' || cand === 'Info') { tag = cand; tagOff = i; break; }
    }
  }
  if (tag === 'Xing' || tag === 'Info') {
    let p = tagOff + 4;
    if (tag === 'Xing') {
      const flags = buf.readUInt32BE(p); p += 4;
      if (flags & 0x01) { totalFrames = buf.readUInt32BE(p); p += 4; }
      if (flags & 0x02) p += 4; // size
      if (flags & 0x04) p += 4; // toc
      if (flags & 0x08) xingBitrate = buf.readUInt32BE(p); p += 4; // VBR quality
    } else {
      // Info（CBR）：flags(4) + frames(4) + bytes(4) + toc(100) + quality(4)
      const infoFlags = buf.readUInt32BE(p);
      let q = p + 4;
      if (infoFlags & 0x01) { totalFrames = buf.readUInt32BE(q); q += 4; }
      if (infoFlags & 0x02) q += 4;
      if (infoFlags & 0x04) q += 100;
    }
  }

  let durationSec = null;
  let estimated = false;
  if (totalFrames != null && frame.samplesPerFrame > 0) {
    durationSec = (totalFrames * frame.samplesPerFrame) / frame.sampleRate;
  } else if (sizeBytes > 0 && frame.bitrate > 0) {
    durationSec = (sizeBytes * 8) / frame.bitrate;
    estimated = true;
  }

  return {
    durationSec: round2(durationSec),
    sampleRate: frame.sampleRate,
    channels: frame.channels,
    codec: `mp3`,
    estimated,
  };
}

// =====================================================================
// WAV 解析
// =====================================================================

function parseWav(buf, sizeBytes) {
  if (buf.length < 12) return null;
  if (buf.toString('ascii', 0, 4) !== 'RIFF') return null;
  if (buf.toString('ascii', 8, 12) !== 'WAVE') return null;

  let fmt = null;
  let dataSize = null;
  let off = 12;
  while (off + 8 <= buf.length) {
    const type = buf.toString('ascii', off, off + 4);
    const chunkSize = buf.readUInt32LE(off + 4);
    if (chunkSize < 0 || off + 8 + chunkSize > buf.length) break;
    if (type === 'fmt ') {
      const audioFormat = buf.readUInt16LE(off + 8);
      const channels = buf.readUInt16LE(off + 10);
      const sampleRate = buf.readUInt32LE(off + 12);
      const bitsPerSample = buf.readUInt16LE(off + 8 + 14);
      fmt = { channels, sampleRate, bitsPerSample, audioFormat };
    } else if (type === 'data') {
      dataSize = chunkSize;
      break;
    }
    off += 8 + chunkSize + (chunkSize & 1); // 偶数字节对齐
  }
  if (!fmt) return null;

  // data 块大小在头部窗口之外时，用文件总长减去头部估算
  let bytesPerSec = 0;
  if (fmt.bitsPerSample > 0) bytesPerSec = fmt.sampleRate * fmt.channels * (fmt.bitsPerSample / 8);
  let durationSec = null;
  if (dataSize != null && bytesPerSec > 0) {
    durationSec = dataSize / bytesPerSec;
  } else if (sizeBytes > 0 && bytesPerSec > 0) {
    // data 块未读到：粗略扣除 RIFF/fmt 头部后估算
    durationSec = Math.max(0, sizeBytes - 44) / bytesPerSec;
  }
  const codec = fmt.audioFormat === 0xfffe ? 'extensible'
    : fmt.audioFormat === 1 ? 'pcm'
    : fmt.audioFormat === 3 ? 'ieee-float' : `wav-${fmt.audioFormat}`;
  return {
    durationSec: round2(durationSec),
    sampleRate: fmt.sampleRate,
    channels: fmt.channels,
    codec,
    estimated: dataSize == null,
  };
}

// =====================================================================
// WebM / MKV（EBML）解析
// =====================================================================

const EBML_ID = {
  Segment: 0x18538067,
  Info: 0x1549a966,
  Duration: 0x4489,
  Tracks: 0x1654ae6b,
  TrackEntry: 0xae,
  Video: 0xe0,
  PixelWidth: 0xb0,
  PixelHeight: 0xba,
  CodecID: 0x86,
  Timescale: 0x2ad7b1,
};

/** 字节前导 1 的个数（EBML 数据大小 / ID 长度编码），0 表示全零非法。 */
function leadingOnes(b) {
  for (let i = 7; i >= 0; i -= 1) if (b & (1 << i)) return 8 - i;
  return 0;
}

function readEbmlSize(buf, off) {
  if (off >= buf.length) return { value: null, len: 0 };
  const first = buf[off];
  const len = leadingOnes(first);
  if (len === 0 || off + len > buf.length) return { value: null, len: 0 };
  let value = first & ((1 << (8 - len)) - 1);
  for (let i = 1; i < len; i += 1) value = (value << 8) | buf[off + i];
  return { value, len };
}

function readEbmlId(buf, off) {
  if (off >= buf.length) return { id: null, len: 0 };
  const first = buf[off];
  const len = leadingOnes(first);
  // 全零字节不是合法 EBML ID，避免在二进制 Cluster Block 上误同步成 len=0 死循环
  if (len === 0 || off + len > buf.length) return { id: null, len: 0 };
  let id = first;
  for (let i = 1; i < len; i += 1) id = (id << 8) | buf[off + i];
  return { id, len };
}

function readUint(buf, start, end) {
  const n = end - start;
  if (n <= 0 || n > 8) return null;
  let v = 0;
  for (let i = 0; i < n; i += 1) v = (v << 8) | buf[start + i];
  return v;
}

/** 在 EBML 子树内按标签收集目标值；depth 控制递归层级。 */
function walkEbml(buf, start, end, out, depth = 0) {
  let off = start;
  while (off + 2 <= end) {
    const idR = readEbmlId(buf, off);
    if (idR.id == null) break;
    const sizeR = readEbmlSize(buf, off + idR.len);
    if (sizeR.value == null) break;
    const bodyStart = off + idR.len + sizeR.len;
    const bodyEnd = bodyStart + sizeR.value;
    // 非法 / 未知 VINT 全一（unknown size）或越界：跳出，避免在二进制载荷上误同步
    if (sizeR.value === 0xffffffffffffff || bodyEnd > end) break;

    const id = idR.id;
    if (id === EBML_ID.Duration) {
      // 浮点（通常 8 字节 double，也可能 4 字节 float）；EBML 数值元素为大端
      if (sizeR.value === 8) out.durationRaw = buf.readDoubleBE(bodyStart);
      else if (sizeR.value === 4) out.durationRaw = buf.readFloatBE(bodyStart);
    } else if (id === EBML_ID.Timescale) {
      const ts = readUint(buf, bodyStart, bodyEnd);
      if (ts && ts > 0) out.timescale = ts;
    } else if (id === EBML_ID.PixelWidth) {
      out.width = readUint(buf, bodyStart, bodyEnd);
    } else if (id === EBML_ID.PixelHeight) {
      out.height = readUint(buf, bodyStart, bodyEnd);
    } else if (id === EBML_ID.CodecID) {
      const txt = buf.toString('utf8', bodyStart, bodyEnd).trim();
      if (txt.startsWith('V_')) out.videoCodec = txt.slice(2).toLowerCase();
      else if (txt.startsWith('A_')) out.audioCodec = txt.slice(2).toLowerCase();
    } else if (id === EBML_ID.Segment || id === EBML_ID.Info ||
        id === EBML_ID.Tracks || id === EBML_ID.TrackEntry || id === EBML_ID.Video) {
      if (depth < 4) walkEbml(buf, bodyStart, bodyEnd, out, depth + 1);
    }
    off = bodyEnd;
  }
}

function parseEbml(buf) {
  if (buf.length < 4) return null;
  const out = {};
  walkEbml(buf, 0, buf.length, out, 0);
  const codec = out.videoCodec || out.audioCodec || null;
  // Matroska：Duration 原始值按 Info/Timescale 归一为秒（常见 timescale=1000000）；
  // 缺 Timescale 时按每秒计数处理。
  let durationSec = null;
  if (out.durationRaw != null) {
    // Matroska 规范上 Duration 为秒；实测部分封装（libvpx 系）把 Duration 写成
    // 毫秒计数（raw≈秒×1000，Timescale 仍为 1000000）。按 Timescale 归一，
    // Timescale 缺失时按原值返回。
    // 实测 libvpx 系封装把 Duration 写成毫秒计数（raw≈秒×1000，Timescale=1000000
    // 是微秒时钟，不能直接除）。按 Timescale 归一：ts=1000000 时若 raw 是毫秒量级
    // （<1e5）则 /1000；微秒量级（≥1e5）/1e6；Timescale 缺失按秒。
    const ts = out.timescale || 1;
    if (ts >= 1000000) {
      durationSec = out.durationRaw >= 100000 ? out.durationRaw / 1000000 : out.durationRaw / 1000;
    } else if (ts > 1) {
      durationSec = out.durationRaw / ts;
    } else {
      durationSec = out.durationRaw;
    }
  }
  if (durationSec == null && out.width == null && out.height == null && codec == null) return null;
  return { durationSec: round2(durationSec), width: out.width ?? null, height: out.height ?? null, codec };
}

// =====================================================================
// 主入口
// =====================================================================

/**
 * 解析文件头部 Buffer。
 * @param {object} opts
 * @param {Buffer} opts.head 文件头部字节（≤ 2 MB）
 * @param {number} [opts.sizeBytes] 文件总大小（MP3/WAV 估算用）
 * @param {string} [opts.mime] 节点 MIME
 * @param {string} opts.logicalPath 逻辑路径（取扩展名）
 * @returns {{kind:'image'|'video'|'audio'|'other', media:object|null, parsed:boolean, reason?:string}}
 */
export function parseMedia({ head, sizeBytes = 0, mime, logicalPath }) {
  const classification = classifyMedia(logicalPath, mime);
  const kind = classification.kind;

  if (kind === 'other') {
    return { kind, media: null, parsed: false, reason: '不支持的文件类型' };
  }
  if (!head || head.length < 4) {
    return { kind, media: null, parsed: false, reason: '文件头部数据不足' };
  }

  try {
    let media = null;
    let reason = '';

    if (kind === 'image') {
      media =
        parsePng(head) || parseJpeg(head) || parseGif(head) ||
        parseWebp(head) || parseBmp(head) || parseAvif(head);
      if (!media) reason = '未能识别图片格式或图片头部不完整';
    } else if (kind === 'video') {
      if (isEbmlMagic(head)) {
        media = parseEbml(head);
      } else {
        media = parseBmff(head);
      }
      if (!media) reason = '未能解析视频元数据（头部缺失 moov/trak 或 EBML 信息）';
    } else if (kind === 'audio') {
      if (/\.wav$/i.test(logicalPath) || String(mime || '').includes('wav')) {
        media = parseWav(head, sizeBytes);
      } else if (/\.m4a$/i.test(logicalPath) || String(mime || '').includes('mp4')) {
        media = parseBmff(head);
      } else {
        media = parseMp3(head, sizeBytes);
      }
      if (!media) reason = '未能解析音频元数据（帧头/格式块缺失）';
    }

    if (media) {
      return { kind, media, parsed: true };
    }
    return { kind, media: null, parsed: false, reason };
  } catch (e) {
    return { kind, media: null, parsed: false, reason: `解析异常：${e && e.message ? e.message : '未知错误'}` };
  }
}

function isEbmlMagic(buf) {
  return buf.length >= 4 && buf[0] === 0x1a && buf[1] === 0x45 && buf[2] === 0xdf && buf[3] === 0xa3;
}
