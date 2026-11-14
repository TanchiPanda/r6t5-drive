import { db } from '../db.js';
import { nowIso } from '../lib/format.js';

const WINDOW_MS = 7 * 86400000;

export function recordTraffic(email, kind, bytes) {
  db.prepare('INSERT INTO traffic (email, kind, bytes, at) VALUES (?, ?, ?, ?)')
    .run(email, kind, Number(bytes) || 0, nowIso());
}

export function trafficUsed7d(email, kind) {
  const since = new Date(Date.now() - WINDOW_MS).toISOString();
  const row = db.prepare(
    `SELECT COALESCE(SUM(bytes), 0) AS n FROM traffic WHERE email = ? AND kind = ? AND at >= ?`
  ).get(email, kind, since);
  return Number(row.n || 0);
}

export function trafficInWindow(kind) {
  const since = new Date(Date.now() - WINDOW_MS).toISOString();
  const row = db.prepare(
    `SELECT COALESCE(SUM(bytes), 0) AS n FROM traffic WHERE kind = ? AND at >= ?`
  ).get(kind, since);
  return Number(row.n || 0);
}

export function trafficToday(kind) {
  const today = new Date().toISOString().slice(0, 10);
  const row = db.prepare(
    `SELECT COALESCE(SUM(bytes), 0) AS n FROM traffic WHERE kind = ? AND substr(at,1,10) = ?`
  ).get(kind, today);
  return Number(row.n || 0);
}

/** 近 14 天按天聚合上传数与上传字节 */
export function uploadSeries(days = 14) {
  const labels = [];
  const uploads = [];
  const trafficBytes = [];
  const rows = db.prepare(
    `SELECT substr(at,1,10) AS day, COUNT(*) AS n, COALESCE(SUM(bytes),0) AS b
     FROM traffic WHERE kind = 'upload' AND at >= ? GROUP BY day`
  ).all(new Date(Date.now() - days * 86400000).toISOString());
  const byDay = new Map(rows.map((r) => [r.day, r]));
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(Date.now() - i * 86400000);
    const key = d.toISOString().slice(0, 10);
    labels.push(key.slice(5));
    const r = byDay.get(key);
    uploads.push(r ? Number(r.n) : 0);
    trafficBytes.push(r ? Number(r.b) : 0);
  }
  return { days: labels, uploads, trafficBytes };
}
