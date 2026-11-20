// 统一运行日志：所有输出走 stdout，供 `docker logs` / `docker compose logs -f` 直接查看。
// 单行结构：<时间> <级别> [<标签>] <说明> key=value ...
// TTY 下着色，重定向到文件时保持纯文本，便于 grep。

import { AsyncLocalStorage } from 'node:async_hooks';

const TTY = !!process.stdout.isTTY;
const paint = (code, text) => (TTY ? `\x1b[${code}m${text}\x1b[0m` : text);

const LEVELS = {
  info: { code: '36', label: 'INFO' },
  warn: { code: '33', label: 'WARN' },
  error: { code: '31', label: 'ERR ' },
  event: { code: '32', label: 'CHG ' },
};

// LOG_LEVEL=warn / error 可压低 noise；默认 info 输出全部变更
const THRESHOLD = (() => {
  const level = String(process.env.LOG_LEVEL || 'info').toLowerCase();
  return level === 'error' ? 2 : level === 'warn' ? 1 : 0;
})();

function safe(value) {
  if (value === null || value === undefined) return '';
  const text = String(value).replace(/\s+/g, ' ').trim();
  if (!text) return '';
  return /[\s"=]/.test(text) ? `"${text.replace(/"/g, "'")}"` : text;
}

export function log(level, tag, message, fields = {}) {
  const meta = LEVELS[level] || LEVELS.info;
  const rank = level === 'error' ? 2 : level === 'warn' ? 1 : 0;
  if (rank < THRESHOLD) return '';
  const time = new Date().toISOString().replace('T', ' ').slice(0, 19);
  const extra = Object.keys(fields)
    .map((key) => [key, safe(fields[key])])
    .filter(([, value]) => value)
    .map(([key, value]) => `${key}=${value}`)
    .join(' ');
  const line = `${paint('90', time)} ${paint(meta.code, meta.label)} ${paint('1', `[${tag}]`)} ${message}${extra ? ` ${extra}` : ''}`;
  if (level === 'error') console.error(line);
  else console.log(line);
  return line;
}

// 变更类日志（登录、设置、上传、删除……）统一用 event 级别，方便 `docker logs | grep CHG` 过滤。
export const logEvent = (tag, message, fields) => log('event', tag, message, fields);
export const logInfo = (tag, message, fields) => log('info', tag, message, fields);
export const logWarn = (tag, message, fields) => log('warn', tag, message, fields);
export const logError = (tag, message, fields) => log('error', tag, message, fields);

// 请求上下文：让深层 service 里的审计打点能标记「本次请求已记录」，
// 避免审计日志和请求级兜底日志重复输出。
const storage = new AsyncLocalStorage();

export function requestContext(req, res, next) {
  storage.run({ req, res, at: Date.now(), logged: false }, next);
}

export function currentContext() {
  return storage.getStore() || null;
}
