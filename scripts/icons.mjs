#!/usr/bin/env node
/**
 * Generates the favicon set from public/favicon.svg with Playwright:
 *
 *   favicon.ico            16, 32 and 48 px (PNG entries)
 *   favicon-32x32.png
 *   apple-touch-icon.png   180 px, opaque, mark with about 10 percent padding
 *   icon-192.png, icon-512.png
 *   site.webmanifest
 *
 * Usage: node scripts/icons.mjs                 write into public/
 *        node scripts/icons.mjs --out <dir>     write into another folder
 *                                               (for a preview; also writes preview.png)
 *        node scripts/icons.mjs --svg <file>    use another SVG than public/favicon.svg
 *
 * Requires Playwright's Chromium: npx playwright install chromium
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC = join(ROOT, 'public');
const args = process.argv.slice(2);
const outArg = args.indexOf('--out');
const OUT = outArg === -1 ? PUBLIC : resolve(process.cwd(), args[outArg + 1]);
mkdirSync(OUT, { recursive: true });

const svgArg = args.indexOf('--svg');
const svg = readFileSync(svgArg === -1 ? join(PUBLIC, 'favicon.svg') : resolve(process.cwd(), args[svgArg + 1]), 'utf8');
const colour = svg.match(/<rect[^>]*fill="([^"]+)"/)[1];
const mark = svg.match(/<g id="mark"[\s\S]*?<\/g>/)[0];

// Rounded icon as in favicon.svg, transparent corners.
const rounded = svg;
// Solid square for iOS (it rounds the corners itself), mark at 80 percent.
const solid = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">
  <rect width="64" height="64" fill="${colour}"/>
  <g transform="translate(6.4 6.4) scale(0.8)">${mark}</g>
</svg>`;

const browser = await chromium.launch();

async function render(source, size) {
  const page = await browser.newPage({ viewport: { width: size, height: size } });
  await page.setContent(
    `<style>html,body{margin:0;background:transparent}svg{display:block;width:${size}px;height:${size}px}</style>${source}`,
  );
  const png = await page.screenshot({ omitBackground: true, clip: { x: 0, y: 0, width: size, height: size } });
  await page.close();
  return png;
}

const png16 = await render(rounded, 16);
const png32 = await render(rounded, 32);
const png48 = await render(rounded, 48);

// ICO container with PNG entries.
function ico(entries) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(entries.length, 4);
  let offset = 6 + entries.length * 16;
  const dir = entries.map(({ size, data }) => {
    const e = Buffer.alloc(16);
    e.writeUInt8(size, 0);
    e.writeUInt8(size, 1);
    e.writeUInt16LE(1, 4);
    e.writeUInt16LE(32, 6);
    e.writeUInt32LE(data.length, 8);
    e.writeUInt32LE(offset, 12);
    offset += data.length;
    return e;
  });
  return Buffer.concat([header, ...dir, ...entries.map((e) => e.data)]);
}

writeFileSync(join(OUT, 'favicon.ico'), ico([
  { size: 16, data: png16 }, { size: 32, data: png32 }, { size: 48, data: png48 },
]));
writeFileSync(join(OUT, 'favicon-32x32.png'), png32);
writeFileSync(join(OUT, 'apple-touch-icon.png'), await render(solid, 180));
writeFileSync(join(OUT, 'icon-192.png'), await render(rounded, 192));
writeFileSync(join(OUT, 'icon-512.png'), await render(rounded, 512));
writeFileSync(join(OUT, 'site.webmanifest'), JSON.stringify({
  name: 'Resource Library',
  short_name: 'Resources',
  start_url: '/',
  display: 'browser',
  theme_color: colour,
  background_color: colour,
  icons: [
    { src: '/icon-192.png', sizes: '192x192', type: 'image/png' },
    { src: '/icon-512.png', sizes: '512x512', type: 'image/png' },
  ],
}, null, 2) + '\n');

if (outArg !== -1) {
  // Preview sheet: the icon at 16, 32 and 180 px, as is and enlarged, on light and dark.
  const b64 = (buf) => `data:image/png;base64,${buf.toString('base64')}`;
  const apple = await render(solid, 180);
  const cell = (bg, fg) => `<div style="background:${bg};color:${fg};padding:24px;display:flex;gap:40px;align-items:flex-end">
    <figure><img src="${b64(png16)}" width="16" height="16"><figcaption>16 px</figcaption></figure>
    <figure><img src="${b64(png32)}" width="32" height="32"><figcaption>32 px</figcaption></figure>
    <figure><img src="${b64(apple)}" width="180" height="180" style="border-radius:40px"><figcaption>180 px</figcaption></figure>
    <figure><img src="${b64(png16)}" width="128" height="128" style="image-rendering:pixelated"><figcaption>16 px x8</figcaption></figure>
  </div>`;
  const page = await browser.newPage({ viewport: { width: 640, height: 480 } });
  await page.setContent(`<style>body{margin:0;font:12px sans-serif}figure{margin:0;text-align:center}figcaption{margin-top:6px}</style>
    ${cell('#ffffff', '#222')}${cell('#272727', '#eee')}`);
  await page.screenshot({ path: join(OUT, 'preview.png'), fullPage: true });
  await page.close();
}

await browser.close();
console.log(`Wrote icons to ${OUT}`);
