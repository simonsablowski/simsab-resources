#!/usr/bin/env node
/**
 * Renders the Open Graph preview images (1200 x 630 PNG) with Playwright.
 *
 * One image per resource page, collection page and the library index:
 *
 *   public/<collection>/og/<slug>.png     resource
 *   public/<collection>/og/index.png      collection page
 *   public/og/index.png                   library index
 *
 * They are rendered from templates/og.html, which loads the course site's
 * stylesheet (fonts and colours) like the pages do. og-manifest.json records a
 * hash of label, title, description and template for each image, so an image
 * is only rendered again when one of them changes.
 *
 * If the course site folder sits next to this one (../simsab-courses/public),
 * fonts and styles are read from disk. Otherwise they load from courses.simsab.net.
 *
 * Usage: node scripts/og.mjs                      new or changed images
 *        node scripts/og.mjs --force              all images
 *        node scripts/og.mjs --only <slug,...>    only these (a slug, or "index" for the index pages)
 *        node scripts/og.mjs --out <dir>          write into another folder, manifest untouched
 *
 * Requires Playwright's Chromium: npx playwright install chromium
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, statSync, readdirSync } from 'node:fs';
import { join, dirname, extname, relative, resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { chromium } from 'playwright';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC = join(ROOT, 'public');
const MANIFEST = join(ROOT, 'og-manifest.json');
const TEMPLATE = join(ROOT, 'templates', 'og.html');
const SHARED_ORIGIN = 'https://courses.simsab.net';

const args = process.argv.slice(2);
const arg = (name) => {
  const i = args.indexOf(name);
  return i === -1 ? null : args[i + 1];
};
const FORCE = args.includes('--force');
const ONLY = arg('--only') ? arg('--only').split(',') : null;
const outArg = arg('--out');
const OUT = outArg ? resolvePath(process.cwd(), outArg) : PUBLIC;
const sharedArg = arg('--shared-dir');
const SHARED_DIR = sharedArg
  ? resolvePath(process.cwd(), sharedArg)
  : join(ROOT, '..', 'simsab-courses', 'public');
const useLocalShared = existsSync(join(SHARED_DIR, 'css', 'styles.css'));

const TYPES = {
  '.css': 'text/css', '.woff2': 'font/woff2', '.js': 'text/javascript', '.svg': 'image/svg+xml',
};

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', '#039': "'", apos: "'", nbsp: ' ' };
const decode = (s) => s
  .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
  .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
  .replace(/&(amp|lt|gt|quot|apos|nbsp);/g, (_, e) => ENTITIES[e]);
const escapeHtml = (s) => String(s)
  .replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
const hash = (...parts) => createHash('sha256').update(parts.join('\u0000')).digest('hex').slice(0, 16);
const slash = (p) => p.split('\\').join('/');

function walk(dir) {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    return statSync(full).isDirectory() ? walk(full) : [full];
  });
}

function content(html, property) {
  const re = new RegExp(`<meta\\s+(?:property|name)="${property}"\\s+content="([^"]*)"`, 'i');
  const m = html.match(re);
  return m ? decode(m[1]) : '';
}

/* ----------------------------------------------------------------- images */

const files = walk(PUBLIC).filter((f) => f.endsWith('.html'));
const items = [];
const stripSuffix = (t) => t.replace(/\s+[—-]\s+Resource Library.*$/, '').trim();

for (const file of files) {
  const html = readFileSync(file, 'utf8');
  const parts = slash(relative(PUBLIC, file)).split('/');

  if (content(html, 'resource:number')) {
    const slug = parts[parts.length - 1].replace(/\.html$/, '');
    items.push({
      key: slug,
      out: slash(join(parts[0], 'og', `${slug}.png`)),
      label: content(html, 'resource:collection-title'),
      title: content(html, 'og:title'),
      description: content(html, 'og:description'),
    });
  } else if (parts.length === 2 && parts[1] === 'index.html') {
    items.push({
      key: 'index',
      out: slash(join(parts[0], 'og', 'index.png')),
      label: 'Resource library',
      title: stripSuffix(content(html, 'og:title')),
      description: content(html, 'og:description'),
    });
  } else if (parts.length === 1 && parts[0] === 'index.html') {
    items.push({
      key: 'index',
      out: 'og/index.png',
      label: 'Simon Sablowski & Giuseppe De Simone',
      title: 'Resource Library',
      description: content(html, 'og:description'),
    });
  }
}

const template = readFileSync(TEMPLATE, 'utf8');
const faviconSvg = readFileSync(join(PUBLIC, 'favicon.svg'), 'utf8');
// The favicon mark as a small logo: light square with the mark in the primary colour.
const mark = faviconSvg
  .replace(/<rect[^>]*\/>/, '<rect width="64" height="64" rx="14" fill="#ffffff"/>')
  .replace('<g id="mark" fill="#ffffff">', '<g id="mark" fill="#0f5e6e">')
  .replace(/<svg /, '<svg aria-hidden="true" ');

const manifest = existsSync(MANIFEST) ? JSON.parse(readFileSync(MANIFEST, 'utf8')) : {};
for (const item of items) {
  item.hash = hash(item.label, item.title, item.description, template, faviconSvg);
  item.path = join(OUT, item.out);
}

const todo = items
  .filter((i) => !ONLY || ONLY.includes(i.key))
  .filter((i) => FORCE || outArg || !existsSync(i.path) || manifest[i.out] !== i.hash);

if (!todo.length) {
  console.log(`All ${items.length} images are up to date. Use --force to regenerate.`);
  process.exit(0);
}

console.log(`Shared styles: ${useLocalShared ? SHARED_DIR : SHARED_ORIGIN + ' (live site)'}`);

const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1200, height: 630 }, deviceScaleFactor: 1 });

if (useLocalShared) {
  await context.route(`${SHARED_ORIGIN}/**`, (route) => {
    const path = new URL(route.request().url()).pathname;
    const file = resolvePath(SHARED_DIR, '.' + path);
    if (!existsSync(file) || !statSync(file).isFile()) return route.fulfill({ status: 404, body: 'Not found' });
    return route.fulfill({
      status: 200,
      body: readFileSync(file),
      headers: { 'Content-Type': TYPES[extname(file)] || 'application/octet-stream', 'Access-Control-Allow-Origin': '*' },
    });
  });
}

let failed = 0;
for (const item of todo) {
  const page = await context.newPage();
  try {
    const html = template
      .replace('{{label}}', () => escapeHtml(item.label))
      .replace('{{titleClass}}', item.title.length > 42 ? ' long' : '')
      .replace('{{title}}', () => escapeHtml(item.title))
      .replace('{{description}}', () => escapeHtml(item.description))
      .replace('{{mark}}', () => mark);
    await page.setContent(html, { waitUntil: 'networkidle' });
    await page.evaluate(() => document.fonts.ready);
    mkdirSync(dirname(item.path), { recursive: true });
    await page.screenshot({ path: item.path, clip: { x: 0, y: 0, width: 1200, height: 630 } });
    if (!outArg) manifest[item.out] = item.hash;
    console.log(`  ✓ ${slash(relative(outArg ? OUT : ROOT, item.path))}`);
  } catch (err) {
    failed++;
    console.error(`  ✗ ${item.out}: ${err.message}`);
  } finally {
    await page.close();
  }
}

await browser.close();

if (!outArg) {
  const sorted = Object.fromEntries(Object.entries(manifest).sort(([a], [b]) => a.localeCompare(b)));
  writeFileSync(MANIFEST, JSON.stringify(sorted, null, 2) + '\n');
}
console.log(`${todo.length - failed} image(s) written, ${items.length - todo.length} not rendered${failed ? `, ${failed} failed` : ''}.`);
process.exit(failed ? 1 : 0);
