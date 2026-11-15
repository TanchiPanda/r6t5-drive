import { Router } from 'express';
import fs from 'node:fs';
import {
  DEFAULT_FALLBACKS, readPublicBranding, resolveBrandingFile,
} from '../services/branding.js';

/* ---------- 公开 JSON：GET /api/branding（免登录） ---------- */
export const brandingApiRouter = Router();

brandingApiRouter.get('/', (req, res) => {
  res.json(readPublicBranding());
});

/* ---------- /branding/* 静态文件与短链（免登录，须在静态中间件之前挂载） ---------- */
export const brandingAssetRouter = Router();

const CONTENT_TYPES = {
  svg: 'image/svg+xml',
  png: 'image/png',
  ico: 'image/x-icon',
};

function currentConfig() {
  return readPublicBranding();
}

// 短链：/branding/favicon、/branding/logo-light、/branding/logo-dark
const SHORT_LINKS = {
  favicon: ['faviconUrl', DEFAULT_FALLBACKS.favicon],
  'logo-light': ['logoLightUrl', DEFAULT_FALLBACKS.logoLight],
  'logo-dark': ['logoDarkUrl', DEFAULT_FALLBACKS.logoDark],
};

for (const [name, [field, fallback]] of Object.entries(SHORT_LINKS)) {
  brandingAssetRouter.get(`/${name}`, (req, res) => {
    const cfg = currentConfig();
    const target = cfg[field] || fallback;
    res.redirect(302, target);
  });
}

// 实际文件：/branding/:name（禁止路径穿越）
brandingAssetRouter.get('/:name', (req, res, next) => {
  const abs = resolveBrandingFile(req.params.name);
  if (!abs) return next();
  const ext = abs.split('.').pop().toLowerCase();
  res.type(CONTENT_TYPES[ext] || 'application/octet-stream');
  fs.createReadStream(abs).pipe(res);
});

/* ---------- PWA manifest：GET /manifest.webmanifest（免登录） ---------- */
// 颜色取 tokens.css 深色主色（--acc / --bg），见 public/assets/tokens.css
const MANIFEST_THEME_COLOR = '#4a9e6e';
const MANIFEST_BACKGROUND_COLOR = '#0e1512';

export function manifestHandler(req, res) {
  const cfg = currentConfig();
  const name = cfg.siteName || 'R6T5 Drive';
  const icon192 = cfg.icon192Url || cfg.iconLargeUrl || DEFAULT_FALLBACKS.icon192;
  const icon512 = cfg.iconLargeUrl || cfg.icon192Url || DEFAULT_FALLBACKS.iconLarge;
  const manifest = {
    name,
    short_name: name,
    start_url: '/',
    display: 'standalone',
    background_color: MANIFEST_BACKGROUND_COLOR,
    theme_color: MANIFEST_THEME_COLOR,
    icons: [
      { src: icon192, sizes: '192x192', type: extType(icon192), purpose: 'any' },
      { src: icon512, sizes: '512x512', type: extType(icon512), purpose: 'any' },
    ],
  };
  res.setHeader('Content-Type', 'application/manifest+json; charset=utf-8');
  res.json(manifest);
}

function extType(url) {
  const ext = String(url || '').split('.').pop().toLowerCase();
  if (ext === 'png') return 'image/png';
  if (ext === 'ico') return 'image/x-icon';
  return 'image/svg+xml';
}
