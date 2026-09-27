/**
 * Library index: search and filters.
 *
 * The resource cards are already in the page (written by scripts/build.mjs),
 * so the page works without JavaScript. This script shows and hides cards,
 * and adds full-text search using /data/search-index.json.
 *
 * The current search and filters are kept in the address bar
 * (?q=...&module=...&topic=...&collection=...), so a filtered view can be linked.
 */
(function () {
  const form = document.getElementById('library-search');
  const input = document.getElementById('q');
  const list = document.getElementById('resource-list');
  if (!form || !input || !list) return;

  const cards = Array.from(list.querySelectorAll('.resource-card'));
  const chips = Array.from(form.querySelectorAll('.chip'));
  const countEl = document.getElementById('results-count');
  const noResults = document.getElementById('no-results');
  const resetBtn = document.getElementById('reset-filters');

  const state = { q: '', collection: new Set(), module: new Set(), topic: new Set() };
  let index = null; // url -> resource record from search-index.json

  /* ---------------------------------------------------------------- text */

  const normalise = (s) => String(s || '')
    .toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[’']/g, '');

  const tokens = (q) => normalise(q).split(/[^a-z0-9]+/).filter((t) => t.length > 1);

  const escapeHtml = (s) => String(s ?? '')
    .replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;').replaceAll("'", '&#039;');

  const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

  /** Wrap query words in <mark>. Works on the original text; matches at word starts. */
  function highlight(text, words) {
    let out = escapeHtml(text);
    if (!words.length) return out;
    const re = new RegExp(`\\b(${words.map(escapeRe).join('|')})`, 'gi');
    return out.replace(re, '<mark>$1</mark>');
  }

  /** A short extract around the first query word. */
  function snippet(text, words, size = 160) {
    const n = normalise(text);
    // Prefer the place where the whole query appears as typed.
    let at = words.length > 1 ? n.indexOf(words.join(' ')) : -1;
    if (at === -1) for (const w of words) {
      const i = n.search(new RegExp(`\\b${escapeRe(w)}`));
      if (i !== -1 && (at === -1 || i < at)) at = i;
    }
    if (at === -1) return text.slice(0, size) + (text.length > size ? '…' : '');
    const start = Math.max(0, at - 50);
    const end = Math.min(text.length, start + size);
    return (start > 0 ? '…' : '') + text.slice(start, end).trim() + (end < text.length ? '…' : '');
  }

  const count = (hay, w) => (hay.match(new RegExp(`\\b${escapeRe(w)}`, 'g')) || []).length;

  /**
   * Score a resource for the query. Every word must appear somewhere
   * (title, summary, tags, concepts, headings or text); otherwise null.
   */
  function score(r, words) {
    const title = normalise(r.title);
    const summary = normalise(r.summary);
    const tags = normalise(r.tags.join(' '));
    const concepts = normalise(r.concepts.map((c) => c.name).join(' '));
    let total = 0;
    const sectionHits = new Map();

    for (const w of words) {
      let found = 0;
      found += count(title, w) * 12;
      found += count(concepts, w) * 6;
      found += count(tags, w) * 5;
      found += count(summary, w) * 3;
      for (const s of r.sections) {
        const inHeading = count(normalise(s.heading), w);
        const inText = count(normalise(s.text), w);
        if (inHeading || inText) {
          sectionHits.set(s, (sectionHits.get(s) || 0) + inHeading * 4 + Math.min(inText, 5));
          found += inHeading * 4 + Math.min(inText, 5);
        }
      }
      if (!found) return null;
      total += found;
    }

    if (words.length > 1) {
      const phraseText = words.join(' ');
      for (const s of r.sections) {
        if (normalise(s.heading + ' ' + s.text).includes(phraseText)) {
          sectionHits.set(s, (sectionHits.get(s) || 0) + 20);
        }
      }
    }

    // Phrase bonus: the whole query appears as typed.
    const phrase = words.join(' ');
    if (words.length > 1) {
      const all = [title, summary, concepts, ...r.sections.map((s) => normalise(s.heading + ' ' + s.text))].join(' ');
      if (all.includes(phrase)) total += 15;
    }

    const sections = [...sectionHits.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([s]) => s);
    return { total, sections };
  }

  /* ------------------------------------------------------------- render */

  function matchesFilters(card) {
    const tags = (card.dataset.tags || '').split('|');
    if (state.collection.size && !state.collection.has(card.dataset.collection)) return false;
    if (state.module.size && !state.module.has(card.dataset.module)) return false;
    if (state.topic.size && !tags.some((t) => state.topic.has(t))) return false;
    return true;
  }

  function render() {
    const words = tokens(state.q);
    const searching = words.length > 0;
    const ranked = [];

    for (const card of cards) {
      const matchList = card.querySelector('.matches');
      let visible = matchesFilters(card);
      let result = null;

      if (visible && searching) {
        const r = index && index.get(card.dataset.url);
        if (r) {
          result = score(r, words);
        } else {
          // Index not loaded (yet): fall back to the text on the card.
          const hay = normalise(card.textContent);
          result = words.every((w) => hay.includes(w)) ? { total: 1, sections: [] } : null;
        }
        visible = !!result;
      }

      card.hidden = !visible;
      if (matchList) {
        if (visible && result && result.sections.length) {
          matchList.innerHTML = result.sections.map((s) => `
            <li>
              <a href="${escapeHtml(card.dataset.url)}#${escapeHtml(s.id)}">${highlight(s.heading, words)}</a>
              <span class="snippet">${highlight(snippet(s.text, words), words)}</span>
            </li>`).join('');
          matchList.hidden = false;
        } else {
          matchList.innerHTML = '';
          matchList.hidden = true;
        }
      }
      if (visible) ranked.push({ card, total: result ? result.total : 0 });
    }

    // Best matches first while searching; original order otherwise.
    const order = searching
      ? ranked.sort((a, b) => b.total - a.total).map((x) => x.card)
      : cards;
    order.forEach((card) => list.appendChild(card));
    if (searching) cards.filter((c) => c.hidden).forEach((c) => list.appendChild(c));

    const shown = ranked.length;
    const filtered = searching || state.collection.size || state.module.size || state.topic.size;
    countEl.textContent = filtered
      ? `${shown} of ${cards.length} resources`
      : `${cards.length} resources`;
    noResults.hidden = shown !== 0;
    resetBtn.hidden = !filtered;
  }

  /* -------------------------------------------------------------- state */

  function writeUrl() {
    const params = new URLSearchParams();
    if (state.q.trim()) params.set('q', state.q.trim());
    for (const key of ['collection', 'module', 'topic']) {
      if (state[key].size) params.set(key, [...state[key]].join(','));
    }
    const qs = params.toString();
    history.replaceState(null, '', qs ? `?${qs}` : location.pathname);
  }

  function readUrl() {
    const params = new URLSearchParams(location.search);
    state.q = params.get('q') || '';
    input.value = state.q;
    for (const key of ['collection', 'module', 'topic']) {
      state[key] = new Set((params.get(key) || '').split(',').filter(Boolean));
    }
    chips.forEach((chip) => {
      const on = state[chip.dataset.filter].has(chip.dataset.value);
      chip.setAttribute('aria-pressed', on ? 'true' : 'false');
    });
  }

  chips.forEach((chip) => {
    chip.addEventListener('click', () => {
      const set = state[chip.dataset.filter];
      const value = chip.dataset.value;
      if (set.has(value)) set.delete(value); else set.add(value);
      chip.setAttribute('aria-pressed', set.has(value) ? 'true' : 'false');
      writeUrl();
      render();
    });
  });

  let timer = null;
  input.addEventListener('input', () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      state.q = input.value;
      writeUrl();
      render();
    }, 120);
  });

  resetBtn.addEventListener('click', () => {
    state.q = '';
    input.value = '';
    state.collection.clear(); state.module.clear(); state.topic.clear();
    chips.forEach((chip) => chip.setAttribute('aria-pressed', 'false'));
    writeUrl();
    render();
    input.focus();
  });

  readUrl();
  render();

  fetch('/data/search-index.json')
    .then((res) => {
      if (!res.ok) throw new Error(`search index: ${res.status}`);
      return res.json();
    })
    .then((data) => {
      index = new Map(data.resources.map((r) => [r.url, r]));
      render();
    })
    .catch((err) => console.error('Could not load the search index:', err));
})();
