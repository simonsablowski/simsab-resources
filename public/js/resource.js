/**
 * Resource pages: "On this page" behaviour.
 * - Collapses the contents list on narrow screens, where it sits above the text.
 * - Marks the section currently being read.
 */
(function () {
  const toc = document.querySelector('.toc');
  if (!toc) return;

  const narrow = window.matchMedia('(max-width: 960px)');
  const syncOpen = () => { toc.open = !narrow.matches; };
  syncOpen();
  narrow.addEventListener('change', syncOpen);

  // Close the list after choosing a section on narrow screens.
  toc.addEventListener('click', (event) => {
    if (event.target.closest('a[href^="#"]') && narrow.matches) toc.open = false;
  });

  const links = new Map();
  toc.querySelectorAll('a[href^="#"]').forEach((a) => {
    links.set(decodeURIComponent(a.getAttribute('href').slice(1)), a);
  });

  const headings = Array.from(links.keys())
    .map((id) => document.getElementById(id))
    .filter(Boolean);

  if (!('IntersectionObserver' in window) || headings.length === 0) return;

  let current = null;
  const setCurrent = (id) => {
    if (id === current) return;
    if (current && links.get(current)) links.get(current).removeAttribute('aria-current');
    current = id;
    if (links.get(id)) links.get(id).setAttribute('aria-current', 'true');
  };

  const visible = new Set();
  const observer = new IntersectionObserver((entries) => {
    entries.forEach((entry) => {
      if (entry.isIntersecting) visible.add(entry.target.id);
      else visible.delete(entry.target.id);
    });
    const first = headings.find((h) => visible.has(h.id));
    if (first) setCurrent(first.id);
  }, { rootMargin: '0px 0px -60% 0px' });

  headings.forEach((h) => observer.observe(h));
})();
