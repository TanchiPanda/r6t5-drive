// R6T5 Drive · 全新安装状态截图 + 前端断言（自测用，不依赖演示数据）
// 用法：PUPPETEER_DIR=<含 puppeteer-core 的目录> BASE=http://127.0.0.1:8099 ADMIN_PASSWORD=test123 node tools/capture.mjs
// 前置：全新数据库（data/ 为空）+ DEV_AUTH=1（仅本地自测用，用于在没有 Supabase 实例时拿到用户会话）

import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const base = process.env.PUPPETEER_DIR;
let puppeteer;
try {
  const candidates = base
    ? [base, path.join(base, 'puppeteer-core'), path.join(base, 'node_modules', 'puppeteer-core')]
    : ['puppeteer-core'];
  let lastErr;
  for (const c of candidates) { try { puppeteer = require(c); break; } catch (e) { lastErr = e; } }
  if (!puppeteer) throw lastErr;
} catch {
  console.error('缺少 puppeteer-core：npm i puppeteer-core，或设 PUPPETEER_DIR 指向安装目录');
  process.exit(2);
}

const BASE = process.env.BASE || 'http://127.0.0.1:8099';
const OUT = process.env.OUT || 'docs/screenshots';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'test123';
const CHROME = process.env.CHROME_PATH || '/usr/local/bin/chromium';
const host = new URL(BASE).hostname;

fs.mkdirSync(OUT, { recursive: true });
const problems = [];

async function loginCookie(kind, email) {
  const url = kind === 'admin' ? '/api/admin/login' : '/api/auth/dev-login';
  const body = kind === 'admin' ? { password: ADMIN_PASSWORD } : { email };
  const res = await fetch(BASE + url, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), redirect: 'manual',
  });
  const list = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
  const pair = list.map(c => c.split(';')[0]).find(Boolean);
  if (!res.ok || !pair) throw new Error(`${kind} 登录失败：${res.status}`);
  const i = pair.indexOf('=');
  return { name: pair.slice(0, i), value: pair.slice(i + 1) };
}

async function main() {
  const browser = await puppeteer.launch({
    executablePath: CHROME,
    args: ['--no-sandbox', '--disable-gpu', '--hide-scrollbars', '--lang=zh-CN'],
    defaultViewport: { width: 1440, height: 900 },
  });

  // 每个角色一个独立上下文，避免管理员 cookie 串到普通用户页面
  const newPage = async (cookie) => {
    const ctx = typeof browser.createBrowserContext === 'function'
      ? await browser.createBrowserContext()
      : await browser.createIncognitoBrowserContext();
    const page = await ctx.newPage();
    page.on('console', m => { if (m.type() === 'error') problems.push('[console] ' + m.text().slice(0, 160)); });
    page.on('pageerror', e => problems.push('[pageerror] ' + e.message.slice(0, 160)));
    if (cookie) await page.setCookie({ name: cookie.name, value: cookie.value, domain: host, path: '/' });
    return page;
  };

  const shot = async (page, name, url, opts = {}) => {
    if (opts.viewport) await page.setViewport(opts.viewport);
    await page.goto(BASE + url, { waitUntil: 'networkidle2', timeout: 30000 });
    await new Promise(r => setTimeout(r, opts.wait || 600));
    if (opts.before) await opts.before(page);
    await page.screenshot({ path: path.join(OUT, name + '.png'), fullPage: true });
    const of = await page.evaluate(() => ({ doc: document.documentElement.scrollWidth, win: window.innerWidth }));
    if (of.doc > of.win + 2) problems.push(`[overflow] ${name} doc=${of.doc} win=${of.win}`);
    console.log('  ✓', name);
  };

  // ---- 1. 全新启动：登录页只有一条引导，且是 Supabase ----
  const anon = await newPage();
  await anon.goto(BASE + '/login', { waitUntil: 'networkidle2' });
  await new Promise(r => setTimeout(r, 600));
  const notes = await anon.evaluate(() => {
    const list = [...document.querySelectorAll('.note')].filter(n => n.offsetParent !== null);
    return { count: list.length, text: list.map(n => n.innerText.replace(/\s+/g, ' ').trim()).join(' | ') };
  });
  if (notes.count !== 1) problems.push(`[login] 首屏引导条应只显示 1 条，实际 ${notes.count}`);
  if (!notes.text.includes('Supabase')) problems.push('[login] 首条引导未指向 Supabase：' + notes.text);
  await anon.screenshot({ path: path.join(OUT, '01-login-empty.png'), fullPage: true });
  console.log('  ✓ 01-login-empty | ' + notes.text.slice(0, 60));

  // 未配置时登录接口必须是 412，不能假装登录成功
  const r = await fetch(BASE + '/api/auth/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'a@b.c', password: 'x' }),
  });
  const b = await r.json().catch(() => ({}));
  if (r.status !== 412 || b?.error?.code !== 'supabase_not_configured') {
    problems.push(`[login] 未配置 Supabase 时登录应 412 supabase_not_configured，实际 ${r.status}/${b?.error?.code}`);
  }
  await shot(anon, '02-admin-login', '/admin/login');

  // 无管理员会话访问管理页 → 403（不是 302、不是白屏）
  const r403 = await fetch(BASE + '/admin/home.html', { redirect: 'manual' });
  if (r403.status !== 403) problems.push(`[guard] 匿名访问 /admin/home.html 应 403，实际 ${r403.status}`);
  const html403 = await r403.text();
  if (!/管理/.test(html403)) problems.push('[guard] 403 页面缺少中文提示');
  await anon.close();

  // ---- 2. 管理端（管理员密码独立于 Supabase，全新库也能进）----
  const adminCookie = await loginCookie('admin');
  const adm = await newPage(adminCookie);
  await shot(adm, '03-admin-home', '/admin/home.html', {
    wait: 1200,
    before: async p => {
      const txt = await p.evaluate(() => document.body.innerText);
      if (!/Supabase/.test(txt)) problems.push('[admin-home] 概览页未提示待配置 Supabase');
    },
  });
  await shot(adm, '04-admin-users', '/admin/users.html', { wait: 900 });
  await shot(adm, '05-admin-storage', '/admin/storage.html', { wait: 800 });
  await shot(adm, '06-admin-storage-disclosure', '/admin/storage.html?open=modal-add', {
    wait: 900,
    viewport: { width: 1440, height: 1200 },
    before: async p => {
      const state = await p.evaluate(() => {
        const m = document.querySelector('.modal-mask');
        const body = document.querySelector('.modal');
        if (body) body.scrollTop = body.scrollHeight; // 让告知条款与确认勾选完整入镜
        const btn = [...document.querySelectorAll('.modal button')].find(x => /创建|添加|保存/.test(x.innerText));
        const ack = [...document.querySelectorAll('.modal input[type=checkbox]')].pop();
        return { open: !!(m && m.classList.contains('open')), disabled: btn ? btn.disabled : null, ackChecked: ack ? ack.checked : null };
      });
      if (state.ackChecked !== false) problems.push('[storage] 披露确认勾选框应默认不勾选');
      if (!state.open) problems.push('[storage] 添加策略弹窗打不开');
      if (state.disabled !== true) problems.push(`[storage] 未勾选披露确认时提交按钮应禁用，实际 ${state.disabled}`);
    },
  });
  await shot(adm, '07-admin-groups', '/admin/groups.html', { wait: 800 });
  await shot(adm, '08-admin-settings', '/admin/settings.html', { wait: 800 });
  await adm.close();

  // ---- 3. 普通用户访问管理页 → 403（真实会话，非匿名）----
  const userCookie = await loginCookie('user', 'demo-user@example.com');
  const usr = await newPage(userCookie);
  await shot(usr, '09-admin-403', '/admin/home.html');
  await usr.close();

  await browser.close();
  console.log('\n断言结果：');
  if (!problems.length) console.log('  全部通过');
  else { problems.forEach(p => console.log('  - ' + p)); process.exitCode = 1; }
}

main().catch(e => { console.error('capture 失败：', e); process.exit(1); });
