#!/usr/bin/env node
/**
 * Copies public/ to .deploy/ without the hidden collections, modules and topics
 * listed in library.config.json. .deploy/ is what gets deployed and previewed,
 * so hidden pages are neither served nor reachable by their URL.
 *
 * The source files in public/ are not changed. Cards in "Related resources"
 * that point to a hidden page are left out of the copy only.
 *
 * Usage: node scripts/stage.mjs
 */

import { readFileSync, writeFileSync, readdirSync, statSync, mkdirSync, rmSync, copyFileSync } from 'node:fs';
import { join, relative, dirname, posix } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isHidden, hiddenCollections } from './config.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC = join(ROOT, 'public');
const OUT = join(ROOT, '.deploy');

function walk(dir) {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    return statSync(full).isDirectory() ? walk(full) : [full];
  });
}

const meta = (html, name) => (html.match(new RegExp(`<meta\\s+name="${name}"\\s+content="([^"]*)"`, 'i')) || [, ''])[1];
const urlOf = (file) => '/' + relative(PUBLIC, file).split('\\').join('/');

const files = walk(PUBLIC);
const skip = new Set();
const hiddenUrls = [];

for (const file of files) {
  const rel = urlOf(file);
  if (hiddenCollections.has(rel.split('/')[1])) {
    skip.add(file);
    if (rel.endsWith('.html')) hiddenUrls.push(rel.slice(0, -'.html'.length));
    continue;
  }
  if (!file.endsWith('.html')) continue;
  const html = readFileSync(file, 'utf8');
  if (!meta(html, 'resource:number')) continue;
  const resource = {
    collection: meta(html, 'resource:collection'),
    module: Number(meta(html, 'resource:module')) || null,
    tags: meta(html, 'resource:tags').split(',').map((t) => t.trim()).filter(Boolean),
  };
  if (!isHidden(resource)) continue;
  const url = rel.slice(0, -'.html'.length);
  hiddenUrls.push(url);
  skip.add(file);
  skip.add(join(dirname(file), 'pdf', posix.basename(url) + '.pdf'));
  skip.add(join(dirname(file), 'og', posix.basename(url) + '.png'));
}

rmSync(OUT, { recursive: true, force: true });
let copied = 0;
for (const file of files) {
  if (skip.has(file)) continue;
  const target = join(OUT, relative(PUBLIC, file));
  mkdirSync(dirname(target), { recursive: true });
  if (file.endsWith('.html')) {
    let html = readFileSync(file, 'utf8');
    // Drop "Related resources" cards that point to a hidden page.
    html = html.replace(/[ \t]*<a class="card" href="([^"#]+)[^"]*">[\s\S]*?<\/a>\r?\n/g,
      (card, href) => (hiddenUrls.includes(href) ? '' : card));
    writeFileSync(target, html);
  } else {
    copyFileSync(file, target);
  }
  copied++;
}

// Nothing deployed may still link to a hidden page.
const leftovers = [];
for (const file of walk(OUT).filter((f) => f.endsWith('.html'))) {
  const html = readFileSync(file, 'utf8');
  for (const url of hiddenUrls) {
    if (html.includes(`href="${url}`)) leftovers.push(`${relative(OUT, file)} → ${url}`);
  }
}
if (leftovers.length) {
  console.error('Links to hidden pages remain:\n  ' + leftovers.join('\n  '));
  process.exit(1);
}

console.log(`Staged ${copied} files in .deploy/ (${hiddenUrls.length} hidden pages left out)`);
