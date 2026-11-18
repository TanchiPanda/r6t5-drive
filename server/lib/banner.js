import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

const ART = String.raw`
 ____     __     _____   ____    ____    ____    ___  __     __  _____
|  _ \   / /_   |_   _| | ___|  |  _ \  |  _ \  |_ _| \ \   / / | ____|
| |_) | | '_ \    | |   |___ \  | | | | | |_) |  | |   \ \ / /  |  _|
|  _ <  | (_) |   | |    ___) | | |_| | |  _ <   | |    \ V /   | |___
|_| \_\  \___/    |_|   |____/  |____/  |_| \_\ |___|    \_/    |_____|
`;

export function readVersion() {
  if (process.env.APP_VERSION) return process.env.APP_VERSION.trim();
  try {
    const v = fs.readFileSync(path.join(ROOT, 'VERSION'), 'utf8').trim();
    if (v) return v;
  } catch { /* 无 VERSION 文件时回落到 package.json */ }
  try {
    return JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version || 'dev';
  } catch {
    return 'dev';
  }
}

export function banner(version = readVersion(), { url } = {}) {
  const rule = '='.repeat(56);
  const lines = [
    '',
    ART.replace(/^\n/, '').replace(/\n$/, ''),
    '',
    `                Ver ${version}`,
    rule,
  ];
  if (url) lines.push(`  ${url}`, rule);
  return lines.join('\n');
}

export function printBanner(opts = {}) {
  const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
  const text = banner(readVersion(), opts);
  if (!useColor) { console.log(text); return text; }
  const parts = text.split('\n');
  const painted = parts.map((line) => {
    if (line.startsWith('=')) return `\x1b[2m${line}\x1b[0m`;
    if (line.includes(`Ver `)) return `\x1b[32m${line}\x1b[0m`;
    if (/^\s*[_|]/.test(line)) return `\x1b[36m${line}\x1b[0m`;
    return line;
  }).join('\n');
  console.log(painted);
  return text;
}
