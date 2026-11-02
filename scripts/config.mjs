/**
 * Reads library.config.json: which collections, modules and topics are hidden.
 *
 * hidden.collections  collection slugs, for example "product-ownership"
 * hidden.modules      "<collection>:<module number>", for example "product-ownership:2"
 * hidden.topics       topic names; hides every resource that carries the topic
 *
 * Hidden resources stay in public/ as source, but are left out of the index
 * pages, the search index and the deployed site (see scripts/stage.mjs).
 */

import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const FILE = join(ROOT, 'library.config.json');

const config = existsSync(FILE) ? JSON.parse(readFileSync(FILE, 'utf8')) : {};
const hidden = config.hidden || {};

export const hiddenCollections = new Set(hidden.collections || []);
const hiddenModules = new Set(hidden.modules || []);
const hiddenTopics = new Set(hidden.topics || []);

/** True when a resource ({ collection, module, tags }) must not be shown. */
export const isHidden = (r) =>
  hiddenCollections.has(r.collection)
  || (r.module != null && hiddenModules.has(`${r.collection}:${r.module}`))
  || r.tags.some((t) => hiddenTopics.has(t));
