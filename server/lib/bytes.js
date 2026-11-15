// P7：空间单位换算（1024 进制，B → EB）。
// 所有跨限额计算走 BigInt；禁止先 Number() 再乘，避免 > 2^53 时静默截断。
// JSON 出参一律用十进制字符串（toByteString），比较时再转回 BigInt。

import { badRequest, quotaLimitExceeded } from './errors.js';

/** 全部 1024 进制单位（索引即 2 的幂次 / 10）。 */
export const UNITS = ['B', 'KB', 'MB', 'GB', 'TB', 'PB', 'EB'];

/** SQLite INTEGER 上限（int64 有符号），约 8 EB。 */
export const MAX_SQLITE_INT = 9223372036854775807n;

const UNIT_INDEX = Object.fromEntries(UNITS.map((u, i) => [u.toUpperCase(), i]));

/** 1 单位 = 1024^exp 字节；返回 BigInt。 */
function unitMultiplier(unit) {
  const idx = UNIT_INDEX[String(unit || 'B').toUpperCase()];
  if (idx == null) throw badRequest('invalid_input', `不支持的单位：${String(unit)}`, { field: 'unit' });
  let m = 1n;
  for (let i = 0; i < idx; i += 1) m *= 1024n;
  return m;
}

/**
 * 十进制字符串拆分：{ int: BigInt 整数部分, frac: BigInt 小数部分, fracDigits: 小数位数 }。
 * 不经过 Number()，避免浮点误差。
 */
function splitDecimal(value) {
  const s = String(value).trim();
  if (!/^[+-]?\d+(\.\d+)?$/.test(s)) throw badRequest('invalid_input', '字节数值格式无效', { field: 'value' });
  const negative = s.startsWith('-');
  const body = s.replace(/^[+-]/, '');
  const [intPart, fracPart = ''] = body.split('.');
  const int = BigInt(intPart || '0');
  const frac = fracPart ? BigInt(fracPart) : 0n;
  return { negative, int, frac, fracDigits: fracPart.length };
}

/**
 * 把 { value, unit } 或纯字节值换算成字节 BigInt。
 * value 可为数字或十进制字符串（允许小数，如 "1.5"、"0.25"）。
 * 非法值 / 负数 / 0 抛 400 invalid_input；返回 BigInt。
 *
 * 实现：整数部分 × 单位乘数；小数部分按位数乘乘数后除以 10^digits（BigInt 整除，
 * 小数末位不足 1 字节时向下取整）。
 */
export function parseSizeToBytes(value, unit) {
  if (value == null || value === '') throw badRequest('invalid_input', '字节数值不能为空', { field: 'value' });
  const { negative, int, frac, fracDigits } = splitDecimal(value);
  if (negative) throw badRequest('invalid_input', '字节数值不能为负数', { field: 'value' });

  const mult = unitMultiplier(unit);
  let bytes = int * mult;
  if (fracDigits > 0) {
    const denom = 10n ** BigInt(fracDigits);
    bytes += (frac * mult) / denom;
  }
  if (bytes <= 0n) throw badRequest('invalid_input', '字节数值必须大于 0', { field: 'value' });
  return bytes;
}

/** 校验字节数在 SQLite INTEGER 上限内；超限抛 400 invalid_input。 */
export function assertMaxSqliteInt(bytes, field = 'limitBytes') {
  const b = toBigInt(bytes);
  if (b > MAX_SQLITE_INT) {
    throw quotaLimitExceeded({
      field,
      max: MAX_SQLITE_INT.toString(),
    });
  }
  return b;
}

/** 兼容 Number / BigInt / 十进制字符串 → BigInt；非法值抛错。 */
export function toBigInt(bytes) {
  if (typeof bytes === 'bigint') return bytes;
  if (bytes == null) return 0n;
  const s = String(bytes).trim();
  if (!/^-?\d+$/.test(s)) throw badRequest('invalid_input', '字节数值必须是整数', { field: 'bytes' });
  return BigInt(s);
}

/** 十进制字符串（供 JSON，避免 Number 精度丢失）。 */
export function toByteString(bytes) {
  return toBigInt(bytes).toString();
}

/**
 * 人类可读格式：1.5 TB / 200 MB / 0 B。
 * 支持 BigInt / 数字 / 十进制字符串。选取能让值 ≥ 1 的最高单位；不足 1 KB 显示 B。
 * 小数部分用十进制字符串（×100 / 1024^idx）精确计算，不经过 Number 浮点。
 */
export function formatSize(bytes) {
  let b = toBigInt(bytes);
  const neg = b < 0n;
  if (neg) b = -b;
  if (b === 0n) return '0 B';

  let idx = 0;
  let mult = 1n; // 1024^idx
  while (idx < UNITS.length - 1 && b >= mult * 1024n) {
    mult *= 1024n;
    idx += 1;
  }
  if (idx === 0) return `${neg ? '-' : ''}${b.toString()} B`;

  let whole = b / mult;
  const frac = b - whole * mult; // 0..mult-1
  // 两位小数：frac*100/mult，四舍五入；只保留一位小数（去掉第二位及其进位）
  let scaled = (frac * 100n) / mult;
  if ((frac * 200n) / mult >= 100n) scaled += 1n;
  if (scaled >= 100n) { whole += 1n; scaled = 0n; }
  let fracStr = scaled.toString().padStart(2, '0');
  // 第一位为有效小数；第二位仅用于进位判定
  fracStr = fracStr[0] === '0' ? '' : fracStr[0];
  const text = fracStr ? `${whole.toString()}.${fracStr} ${UNITS[idx]}` : `${whole.toString()} ${UNITS[idx]}`;
  return neg ? `-${text}` : text;
}
