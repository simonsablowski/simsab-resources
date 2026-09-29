#!/usr/bin/env node
/**
 * Generates a PDF for every resource page and printable template, and stores
 * it next to the page:
 *
 *   public/<course>/<slug>.html  ->  public/<course>/pdf/<slug>.pdf
 *
 * PDFs are only (re)generated when the page or the stylesheets have changed
 * since the last run (tracked in pdf-manifest.json), so running this before
 * every deploy is cheap. The PDFs are committed and deployed as static files.
 *
 * Usage:
 *   npm run pdf                         generate new or changed PDFs
 *   npm run pdf -- --force              regenerate all PDFs
 *   npm run pdf -- --only <slug>        regenerate one resource
 *   npm run pdf -- --shared-dir <path>  where to find the course site's public/
 *                                       folder (default: ../simsab-courses/public)
 *
 * The pages load the shared stylesheet and fonts from https://courses.simsab.net.
 * If the course site folder exists next to this project, those files are read
 * from disk instead, so the PDFs match your local version of the design and
 * no network access is needed. Otherwise they are loaded from the live site.
 *
 * Requires Playwright's Chromium: npx playwright install chromium
 */

import { createServer } from 'node:http';
import { readFileSync, writeFileSync, existsSync, mkdirSync, statSync, readdirSync } from 'node:fs';
import { join, dirname, extname, relative, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { chromium } from 'playwright';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC = join(ROOT, 'public');
const MANIFEST = join(ROOT, 'pdf-manifest.json');
const SITE = 'https://resources.simsab.net';
const SHARED_ORIGIN = 'https://courses.simsab.net';

const args = process.argv.slice(2);
const arg = (name) => {
  const i = args.indexOf(name);
  return i === -1 ? null : args[i + 1];
};
const FORCE = args.includes('--force');
const ONLY = arg('--only');
const sharedArg = arg('--shared-dir');
const SHARED_DIR = sharedArg
  ? join(process.cwd(), sharedArg)
  : join(ROOT, '..', 'simsab-courses', 'public');
const useLocalShared = existsSync(join(SHARED_DIR, 'css', 'styles.css'));

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript',
  '.json': 'application/json', '.webp': 'image/webp', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.pdf': 'application/pdf',
};

function walk(dir) {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    return statSync(full).isDirectory() ? walk(full) : [full];
  });
}

/** Resolve a URL path the way Cloudflare Pages does (extensionless .html, index.html). */
function resolve(root, path) {
  const base = join(root, decodeURIComponent(path));
  const candidates = path.endsWith('/') ? [join(base, 'index.html')] : [base, base + '.html', join(base, 'index.html')];
  return candidates.find((c) => existsSync(c) && statSync(c).isFile()) || null;
}

const hash = (...parts) => createHash('sha256').update(parts.join('\u0000')).digest('hex').slice(0, 16);

/* ------------------------------------------------------------ find pages */

const pages = walk(PUBLIC)
  .filter((f) => f.endsWith('.html'))
  // Resource pages and printable templates.
  .filter((f) => /<meta\s+name="(resource:number|template:collection)"/.test(readFileSync(f, 'utf8')))
  .map((file) => {
    const rel = relative(PUBLIC, file).split('\\').join('/');
    const urlPath = '/' + rel.replace(/\.html$/, '');
    const slug = basename(file, '.html');
    return { file, urlPath, slug, pdf: join(dirname(file), 'pdf', `${slug}.pdf`) };
  })
  .filter((p) => !ONLY || p.slug === ONLY);

if (!pages.length) {
  console.log(ONLY ? `No resource page called "${ONLY}".` : 'No resource pages found.');
  process.exit(ONLY ? 1 : 0);
}

const manifest = existsSync(MANIFEST) ? JSON.parse(readFileSync(MANIFEST, 'utf8')) : {};
const styleInputs = ['resources.css', 'templates.css'].map((f) => readFileSync(join(PUBLIC, 'css', f), 'utf8'));
if (useLocalShared) styleInputs.push(readFileSync(join(SHARED_DIR, 'css', 'styles.css'), 'utf8'));

const todo = pages.filter((p) => {
  p.hash = hash(readFileSync(p.file, 'utf8'), ...styleInputs);
  return FORCE || !existsSync(p.pdf) || manifest[p.urlPath] !== p.hash;
});

if (!todo.length) {
  console.log(`All ${pages.length} PDFs are up to date. Use --force to regenerate.`);
  process.exit(0);
}

/* ---------------------------------------------------------- local server */

const server = createServer((req, res) => {
  const path = new URL(req.url, 'http://localhost').pathname;
  const file = resolve(PUBLIC, path);
  if (!file) { res.writeHead(404).end('Not found'); return; }
  res.writeHead(200, { 'Content-Type': TYPES[extname(file)] || 'application/octet-stream' });
  res.end(readFileSync(file));
});
await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
const origin = `http://127.0.0.1:${server.address().port}`;

/* -------------------------------------------------------------- printing */

console.log(`Shared styles: ${useLocalShared ? SHARED_DIR : SHARED_ORIGIN + ' (live site)'}`);

const browser = await chromium.launch();
const context = await browser.newContext();

if (useLocalShared) {
  await context.route(`${SHARED_ORIGIN}/**`, (route) => {
    const path = new URL(route.request().url()).pathname;
    const file = resolve(SHARED_DIR, path);
    if (!file) return route.fulfill({ status: 404, body: 'Not found' });
    return route.fulfill({
      status: 200,
      body: readFileSync(file),
      headers: { 'Content-Type': TYPES[extname(file)] || 'application/octet-stream', 'Access-Control-Allow-Origin': '*' },
    });
  });
}

const footer = `
  <div style="width:100%; padding:0 18mm 14mm; font-family: Nunito, Helvetica, Arial, sans-serif; font-size:7.5pt; color:#5c5c5c; display:flex; justify-content:space-between;">
    <span>© Simon Sablowski &amp; Giuseppe De Simone · resources.simsab.net</span>
    <span><span class="pageNumber"></span>/<span class="totalPages"></span></span>
  </div>`;

let failed = 0;
for (const p of todo) {
  const page = await context.newPage();
  try {
    await page.goto(origin + p.urlPath, { waitUntil: 'networkidle' });
    await page.evaluate(async ({ site, urlPath }) => {
      await document.fonts.ready;
      // Links in the PDF should point to the live site, not the local server.
      document.querySelectorAll('a[href]').forEach((a) => {
        const u = new URL(a.getAttribute('href'), location.href);
        if (u.origin === location.origin) a.href = site + u.pathname + u.search + u.hash;
      });
      // Load all images now (lazy images outside the viewport would be blank).
      const imgs = Array.from(document.images);
      imgs.forEach((img) => { img.loading = 'eager'; });
      await Promise.all(imgs.map((img) => (img.complete ? null : new Promise((ok) => { img.onload = img.onerror = ok; }))));
      // Pointer to the online version at the end of the document
      // (not on templates, which must stay on one page).
      if (document.body.classList.contains('template-page')) return;
      const note = document.createElement('p');
      note.className = 'print-only print-source';
      note.textContent = `Online version with links to related resources: ${site}${urlPath}`;
      document.querySelector('main').appendChild(note);
    }, { site: SITE, urlPath: p.urlPath });
    await page.emulateMedia({ media: 'print' });

    mkdirSync(dirname(p.pdf), { recursive: true });
    await page.pdf({
      path: p.pdf,
      printBackground: true,
      preferCSSPageSize: true,
      displayHeaderFooter: true,
      headerTemplate: '<span></span>',
      footerTemplate: footer,
      tagged: true,
      outline: true,
    });
    manifest[p.urlPath] = p.hash;
    console.log(`  ✓ ${relative(ROOT, p.pdf)}`);
  } catch (err) {
    failed++;
    console.error(`  ✗ ${p.urlPath}: ${err.message}`);
  } finally {
    await page.close();
  }
}

await browser.close();
server.close();

const sorted = Object.fromEntries(Object.entries(manifest).sort(([a], [b]) => a.localeCompare(b)));
writeFileSync(MANIFEST, JSON.stringify(sorted, null, 2) + '\n');
console.log(`${todo.length - failed} PDF(s) written, ${pages.length - todo.length} up to date${failed ? `, ${failed} failed` : ''}.`);
process.exit(failed ? 1 : 0);
