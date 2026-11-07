#!/usr/bin/env node
/**
 * Build step for the resource library. No dependencies, Node 18+.
 *
 * The HTML resource pages in public/<collection>/ are the source of truth. This
 * script reads them and:
 *
 *   1. writes public/data/search-index.json (used by the search on the index page),
 *   2. regenerates the resource cards, filters and concept index on
 *      public/index.html and public/<collection>/index.html (between the
 *      <!-- build:... --> markers; everything outside the markers is left alone),
 *   3. keeps the icon links and the Open Graph / Twitter card tags (preview
 *      image) of every page in sync,
 *   4. checks every internal link and #anchor, and stops with an error if one
 *      points nowhere or a page lacks its og:image tag.
 *
 * A page counts as a resource page when it has <meta name="resource:number">.
 * Resources hidden in library.config.json are left out of steps 1 and 2.
 *
 * Usage: node scripts/build.mjs          (build and check)
 *        node scripts/build.mjs --check  (check only, write nothing)
 */

import { readFileSync, writeFileSync, readdirSync, statSync, existsSync, mkdirSync } from 'node:fs';
import { join, relative, dirname, posix } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { isHidden } from './config.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC = join(ROOT, 'public');
const CHECK_ONLY = process.argv.includes('--check');

/* ------------------------------------------------------------------ helpers */

function walk(dir) {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    return statSync(full).isDirectory() ? walk(full) : [full];
  });
}

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', '#039': "'", apos: "'", nbsp: ' ' };
const decode = (s) => s
  .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
  .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
  .replace(/&(amp|lt|gt|quot|apos|nbsp);/g, (_, e) => ENTITIES[e]);
const stripTags = (s) => decode(s.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
const escapeHtml = (s) => String(s)
  .replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');

function meta(html, name) {
  const re = new RegExp(`<meta\\s+name="${name}"\\s+content="([^"]*)"`, 'i');
  const m = html.match(re);
  return m ? decode(m[1]) : '';
}

/** URL path of a file in public/, the way Cloudflare Pages serves it. */
function urlPath(file) {
  let p = '/' + relative(PUBLIC, file).split('\\').join('/');
  if (p.endsWith('/index.html')) return p.slice(0, -'index.html'.length);
  if (p.endsWith('.html')) return p.slice(0, -'.html'.length);
  return p;
}

/** Find the file in public/ that a URL path resolves to, or null. */
function resolveUrl(path) {
  const clean = decodeURIComponent(path.split('?')[0]);
  const base = join(PUBLIC, clean);
  const candidates = clean.endsWith('/')
    ? [join(base, 'index.html')]
    : [base, base + '.html', join(base, 'index.html')];
  return candidates.find((c) => existsSync(c) && statSync(c).isFile()) || null;
}

function idsIn(html) {
  return new Set([...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]));
}

function replaceBetween(html, name, content, file) {
  const re = new RegExp(`(<!-- build:${name} -->)([\\s\\S]*?)(\\s*<!-- /build:${name} -->)`);
  if (!re.test(html)) throw new Error(`${relative(ROOT, file)}: marker <!-- build:${name} --> not found`);
  return html.replace(re, (_, open, _old, close) => `${open}\n${content}${close}`);
}

/* ---------------------------------------------------------- read resources */

const htmlFiles = walk(PUBLIC).filter((f) => f.endsWith('.html'));
const allResources = [];

for (const file of htmlFiles) {
  const html = readFileSync(file, 'utf8');
  if (!meta(html, 'resource:number')) continue;

  const url = urlPath(file);
  const h1 = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/);
  const main = (html.match(/<main[^>]*>([\s\S]*?)<\/main>/) || [, ''])[1]
    // related resources and pager are navigation, not content
    .replace(/<section class="(related|pager-section)"[\s\S]*?<\/section>/g, '');

  const sections = [];
  const parts = main.split(/(?=<h2\b)/);
  for (const part of parts) {
    const h = part.match(/<h2[^>]*id="([^"]+)"[^>]*>([\s\S]*?)<\/h2>/);
    if (!h) continue;
    const text = stripTags(part.slice(part.indexOf('</h2>') + 5));
    sections.push({ id: h[1], heading: stripTags(h[2]), text });
  }

  const concepts = [...html.matchAll(/<(\w+)[^>]*\sid="([^"]+)"[^>]*\sdata-concept="([^"]+)"/g)]
    .map((m) => ({ name: decode(m[3]), id: m[2] }));

  allResources.push({
    collection: meta(html, 'resource:collection'),
    collectionTitle: meta(html, 'resource:collection-title'),
    number: meta(html, 'resource:number'),
    module: Number(meta(html, 'resource:module')) || null,
    moduleTitle: meta(html, 'resource:module-title'),
    title: h1 ? stripTags(h1[1]) : url,
    url,
    pdf: posix.join(posix.dirname(url), 'pdf', posix.basename(url) + '.pdf'),
    summary: meta(html, 'description'),
    tags: meta(html, 'resource:tags').split(',').map((t) => t.trim()).filter(Boolean),
    readingTime: Number(meta(html, 'resource:reading-time')) || null,
    concepts,
    sections,
  });
}

const resources = allResources.filter((r) => !isHidden(r));
const hiddenCount = allResources.length - resources.length;

resources.sort((a, b) => a.collection.localeCompare(b.collection) || a.number.localeCompare(b.number));

const collections = [...new Map(resources.map((r) => [r.collection, { slug: r.collection, title: r.collectionTitle, url: `/${r.collection}/` }])).values()];


const SITE = 'https://resources.simsab.net';

// A short hash of the favicon (and of the preview image template) is appended
// to the URLs, so that tools which cache icons and images by URL fetch the new
// version after a design change.
const versionOf = (...files) => createHash('sha256')
  .update(files.map((f) => readFileSync(join(ROOT, f), 'utf8')).join('|')).digest('hex').slice(0, 8);
const ICON_VERSION = versionOf('public/favicon.svg');
const OG_VERSION = versionOf('public/favicon.svg', 'templates/og.html');

const ICON_TAGS = [
  `<link rel="icon" href="/favicon.svg?v=${ICON_VERSION}" type="image/svg+xml">`,
  `<link rel="icon" href="/favicon-32x32.png?v=${ICON_VERSION}" type="image/png" sizes="32x32">`,
  `<link rel="icon" href="/favicon.ico?v=${ICON_VERSION}" sizes="any">`,
  `<link rel="apple-touch-icon" href="/apple-touch-icon.png?v=${ICON_VERSION}">`,
  `<link rel="manifest" href="/site.webmanifest">`,
];

const ICON_LINE = /^[ \t]*<link rel="(?:icon|apple-touch-icon|manifest)"[^>]*>\r?\n/gm;
const OG_LINE = /^[ \t]*<meta (?:property="og:(?:image|image:width|image:height|url)"|name="twitter:card")[^>]*>\r?\n/gm;

if (CHECK_ONLY) {
  checkLinks();
  process.exit(0);
}

/* ------------------------------------------------------------ search index */

mkdirSync(join(PUBLIC, 'data'), { recursive: true });
writeFileSync(
  join(PUBLIC, 'data', 'search-index.json'),
  JSON.stringify({ collections, resources }, null, 1) + '\n',
);
console.log(`Wrote data/search-index.json (${resources.length} resources${hiddenCount ? `, ${hiddenCount} hidden` : ''})`);

/* ----------------------------------------------------------- page snippets */

const I = (n) => ' '.repeat(n);

// Modules are numbered within a course, so a module is identified by
// collection and number together. Only the module title is shown.
const moduleKey = (r) => `${r.collection}:${r.module}`;

function card(r, { showCollection }) {
  const kicker = r.module ? r.moduleTitle : r.collectionTitle;
  const meta = [
    showCollection ? escapeHtml(r.collectionTitle) : '',
    r.readingTime ? `${r.readingTime} min read` : '',
  ].filter(Boolean).join(' · ');
  return [
    `${I(10)}<article class="course-card resource-card" data-collection="${escapeHtml(r.collection)}" data-module="${r.module ? escapeHtml(moduleKey(r)) : ''}" data-tags="${escapeHtml(r.tags.join('|'))}" data-url="${escapeHtml(r.url)}">`,
    `${I(12)}<span class="course-tag">${escapeHtml(kicker)}</span>`,
    `${I(12)}<h3><a href="${escapeHtml(r.url)}">${escapeHtml(r.title)}</a></h3>`,
    `${I(12)}<p class="card-meta">${meta}</p>`,
    `${I(12)}<p>${escapeHtml(r.summary)}</p>`,
    `${I(12)}<ul class="matches" hidden></ul>`,
    `${I(12)}<ul class="card-tags">${r.tags.map((t) => `<li>${escapeHtml(t)}</li>`).join('')}</ul>`,
    `${I(12)}<a class="btn" href="${escapeHtml(r.url)}">Read resource</a>`,
    `${I(10)}</article>`,
  ].join('\n');
}

function conceptList(list, { showResource = true } = {}) {
  const items = list
    .flatMap((r) => r.concepts.map((c) => ({ ...c, r })))
    .sort((a, b) => a.name.localeCompare(b.name, 'en', { sensitivity: 'base' }));
  return items.map((c) => [
    `${I(12)}<li>`,
    `${I(14)}<a href="${escapeHtml(c.r.url)}#${escapeHtml(c.id)}">${escapeHtml(c.name)}</a>`,
    showResource ? `${I(14)}<span class="concept-source">${escapeHtml(c.r.title)}</span>` : '',
    `${I(12)}</li>`,
  ].filter(Boolean).join('\n')).join('\n');
}

function chips(name, values) {
  return values.map(([value, label]) =>
    `${I(14)}<button type="button" class="chip" data-filter="${name}" data-value="${escapeHtml(value)}" aria-pressed="false">${escapeHtml(label)}</button>`,
  ).join('\n');
}

/* --------------------------------------------------------- library index */

{
  const file = join(PUBLIC, 'index.html');
  let html = readFileSync(file, 'utf8');
  const multi = collections.length > 1;

  // Grouped by collection, in module order within each collection.
  const modules = [...new Map(resources.filter((r) => r.module)
    .sort((a, b) => a.collection.localeCompare(b.collection) || a.module - b.module)
    .map((r) => [moduleKey(r), r.moduleTitle])).entries()];
  const topics = [...new Set(resources.flatMap((r) => r.tags))].sort().map((t) => [t, t]);
  const collectionChips = collections.map((c) => [c.slug, c.title]);

  html = replaceBetween(html, 'filters', [
    `${I(10)}<fieldset class="filter-group"${multi ? '' : ' hidden'}>`,
    `${I(12)}<legend>Collection</legend>`,
    `${I(12)}<div class="chips">`,
    chips('collection', collectionChips),
    `${I(12)}</div>`,
    `${I(10)}</fieldset>`,
    `${I(10)}<fieldset class="filter-group">`,
    `${I(12)}<legend>Module</legend>`,
    `${I(12)}<div class="chips">`,
    chips('module', modules),
    `${I(12)}</div>`,
    `${I(10)}</fieldset>`,
    `${I(10)}<fieldset class="filter-group">`,
    `${I(12)}<legend>Topic</legend>`,
    `${I(12)}<div class="chips">`,
    chips('topic', topics),
    `${I(12)}</div>`,
    `${I(10)}</fieldset>`,
  ].join('\n'), file);

  html = replaceBetween(html, 'resource-cards',
    resources.map((r) => card(r, { showCollection: multi })).join('\n\n'), file);
  html = replaceBetween(html, 'concept-index', conceptList(resources), file);
  writeFileSync(file, html);
  console.log('Updated index.html');
}

/* -------------------------------------------------- collection index pages */

for (const collection of collections) {
  const file = join(PUBLIC, collection.slug, 'index.html');
  if (!existsSync(file)) {
    console.warn(`No collection page at ${relative(ROOT, file)}; skipped`);
    continue;
  }
  let html = readFileSync(file, 'utf8');
  const list = resources.filter((r) => r.collection === collection.slug);
  const byModule = new Map();
  for (const r of list) {
    const key = r.module ? r.moduleTitle : 'Resources';
    if (!byModule.has(key)) byModule.set(key, []);
    byModule.get(key).push(r);
  }
  const groups = [...byModule.entries()].map(([label, rs]) => [
    `${I(10)}<div class="module-group">`,
    `${I(12)}<h2>${escapeHtml(label)}</h2>`,
    `${I(12)}<div class="course-list">`,
    rs.map((r) => card(r, { showCollection: false }).replace(/^ {10}/gm, I(14))).join('\n\n'),
    `${I(12)}</div>`,
    `${I(10)}</div>`,
  ].join('\n')).join('\n\n');

  html = replaceBetween(html, 'module-groups', groups, file);
  html = replaceBetween(html, 'concept-index', conceptList(list), file);
  writeFileSync(file, html);
  console.log(`Updated ${collection.slug}/index.html`);
}

/* ------------------------------------------------- icons and preview images */
// Every page gets the same icon links. Resource pages, collection pages and the
// library index also get the Open Graph and Twitter card tags for the preview
// image rendered by scripts/og.mjs (public/<collection>/og/<slug>.png).

/** The preview image tags a page needs, or null for pages without one (worksheets). */
function ogTags(file, html) {
  const rel = relative(PUBLIC, file).split('\\').join('/');
  const parts = rel.split('/');
  let image;
  if (meta(html, 'resource:number')) {
    image = `/${parts[0]}/og/${parts[parts.length - 1].replace(/\.html$/, '')}.png`;
  } else if (parts.length === 2 && parts[1] === 'index.html') {
    image = `/${parts[0]}/og/index.png`;
  } else if (rel === 'index.html') {
    image = '/og/index.png';
  } else {
    return null;
  }
  return { image, url: SITE + urlPath(file) };
}

function headTags(file, html) {
  const og = ogTags(file, html);
  const lines = {
    icons: ICON_TAGS.map((t) => `  ${t}`).join('\n') + '\n',
    og: og && [
      `  <meta property="og:url" content="${og.url}">`,
      `  <meta property="og:image" content="${SITE + og.image}?v=${OG_VERSION}">`,
      '  <meta property="og:image:width" content="1200">',
      '  <meta property="og:image:height" content="630">',
      '  <meta name="twitter:card" content="summary_large_image">',
    ].join('\n') + '\n',
  };
  let out = html.replace(ICON_LINE, '').replace(OG_LINE, '');
  out = out.replace(/(<meta name="viewport"[^>]*>\r?\n)/, `$1${lines.icons}`);
  if (lines.og) out = out.replace(/(<meta property="og:type"[^>]*>\r?\n)/, `$1${lines.og}`);
  return { html: out, og };
}

function syncHead() {
  let changed = 0;
  for (const file of htmlFiles) {
    const html = readFileSync(file, 'utf8');
    const { html: out } = headTags(file, html);
    if (out !== html) {
      writeFileSync(file, out);
      changed++;
    }
  }
  console.log(`Updated icon and preview image tags in ${changed} pages`);
}

/** Pages whose icon or preview image tags are missing or out of date. */
function headErrors() {
  const errors = [];
  let missingImages = 0;
  for (const file of htmlFiles) {
    const html = readFileSync(file, 'utf8');
    const { html: expected, og } = headTags(file, html);
    const name = relative(ROOT, file);
    if (og && !/<meta property="og:image" content="https:\/\/[^"]+"/.test(html)) {
      errors.push(`missing og:image: ${name}`);
    } else if (expected !== html) {
      errors.push(`icon or preview tags out of date (run npm run build): ${name}`);
    }
    if (og && !existsSync(join(PUBLIC, og.image))) missingImages++;
  }
  if (missingImages) console.warn(`${missingImages} preview image(s) not rendered yet (run npm run og)`);
  return errors;
}

/* -------------------------------------------------------------- link check */
// Runs after the index pages are regenerated, so it checks what will be deployed.

function checkLinks() {
const errors = [];
for (const file of htmlFiles) {
  const html = readFileSync(file, 'utf8');
  const pageUrl = 'https://resources.simsab.net' + urlPath(file);
  for (const m of html.matchAll(/\s(?:href|src)="([^"]+)"/g)) {
    const ref = decode(m[1]);
    if (/^(mailto:|tel:|javascript:|data:)/.test(ref)) continue;
    const target = new URL(ref, pageUrl);
    if (target.origin !== 'https://resources.simsab.net') continue;
    const where = `${relative(ROOT, file)} → ${ref}`;
    const targetFile = resolveUrl(target.pathname);
    // PDFs are generated by scripts/pdf.mjs and may not exist yet.
    if (!targetFile) {
      if (!target.pathname.endsWith('.pdf')) errors.push(`missing page or file: ${where}`);
      continue;
    }
    if (target.hash && targetFile.endsWith('.html')) {
      const id = decodeURIComponent(target.hash.slice(1));
      if (!idsIn(readFileSync(targetFile, 'utf8')).has(id)) errors.push(`missing anchor: ${where}`);
    }
  }
}

const head = headErrors();
if (errors.length) {
  console.error(`\n${errors.length} broken link(s):\n  ` + errors.join('\n  ') + '\n');
}
if (head.length) {
  console.error(`\n${head.length} page(s) with missing or outdated head tags:\n  ` + head.join('\n  ') + '\n');
}
if (errors.length || head.length) process.exit(1);
console.log(`Checked links, icons and preview tags in ${htmlFiles.length} pages: OK`);
}

syncHead();
checkLinks();
