// Helpers shared by the workspace widgets.
import { ICONS } from '../icons.js';
import { h } from '../ui.js';

export const FILE_COLORS = ['#5b5bd6', '#2a9d61', '#c97a00', '#d6409f', '#0a8fb3', '#8e4ec6', '#e5484d', '#5b6577'];

/** [0,1,2,4] -> "1-3,5" */
export function rangeString(indexes) {
  const s = [...new Set(indexes)].sort((a, b) => a - b);
  const out = [];
  for (let i = 0; i < s.length; i++) {
    let j = i;
    while (j + 1 < s.length && s[j + 1] === s[j] + 1) j++;
    out.push(j > i ? `${s[i] + 1}-${s[j] + 1}` : `${s[i] + 1}`);
    i = j;
  }
  return out.join(',');
}

/** "1-3,5" -> Set{0,1,2,4}; ignores invalid parts. */
export function parsePages(text, count) {
  const set = new Set();
  for (const part of String(text || '').split(/[,;\s]+/)) {
    if (!part) continue;
    const m = part.match(/^(\d*)\s*-\s*(\d*)$/);
    let a; let b;
    if (m) { a = m[1] ? +m[1] : 1; b = m[2] ? +m[2] : count; } else if (/^\d+$/.test(part)) { a = b = +part; } else continue;
    if (a > b) [a, b] = [b, a];
    for (let p = Math.max(1, a); p <= Math.min(count, b); p++) set.add(p - 1);
  }
  return set;
}

export function rotatedImgStyle(rotation) {
  const r = ((rotation % 360) + 360) % 360;
  return `transform: rotate(${r}deg)${r % 180 ? ' scale(.72)' : ''}`;
}

/**
 * Page and zoom controls for a scrolling document viewer (pages are ``.vpage``
 * elements inside ``scroll()``). ``zoom()`` / ``setZoom(z)`` read and change the
 * viewer's zoom factor; 1 means "fit the width". ``attach()`` floats the controls
 * over the bottom of the viewer.
 */
export function viewerControls({ scroll, zoom, setZoom, min = 0.4, max = 3 }) {
  const pages = () => [...(scroll()?.querySelectorAll('.vpage') || [])];
  const pageInput = h('input', { type: 'number', min: 1, class: 'vc-page', 'aria-label': 'Page' });
  const total = h('span', { class: 'vc-total' });
  const level = h('button', { type: 'button', class: 'vc-level', title: 'Reset zoom to fit the width (0)' });
  const pager = h('span', { class: 'vc-group vc-pager' },
    h('button', { type: 'button', class: 'vc-btn', title: 'Previous page', 'aria-label': 'Previous page', html: ICONS.chevL, onclick: () => go(current() - 1) }),
    pageInput, total,
    h('button', { type: 'button', class: 'vc-btn', title: 'Next page', 'aria-label': 'Next page', html: ICONS.chevR, onclick: () => go(current() + 1) }));
  const zoomer = h('span', { class: 'vc-group' },
    h('button', { type: 'button', class: 'vc-btn', title: 'Zoom out (−)', 'aria-label': 'Zoom out', html: ICONS.zoomOut, onclick: () => apply(zoom() / 1.2) }),
    level,
    h('button', { type: 'button', class: 'vc-btn', title: 'Zoom in (+)', 'aria-label': 'Zoom in', html: ICONS.zoomIn, onclick: () => apply(zoom() * 1.2) }));
  const el = h('span', { class: 'viewer-controls' }, pager, zoomer);

  function current() {
    const box = scroll();
    if (!box) return 0;
    const top = box.getBoundingClientRect().top;
    let best = 0;
    let bestVisible = -1;
    pages().forEach((pg, i) => {
      const r = pg.getBoundingClientRect();
      const visible = Math.min(r.bottom, top + box.clientHeight) - Math.max(r.top, top);
      if (visible > bestVisible) { bestVisible = visible; best = i; }
    });
    return best;
  }
  function go(i) {
    const list = pages();
    const target = list[Math.max(0, Math.min(list.length - 1, i))];
    if (target) scroll().scrollTo({ top: target.offsetTop - 16, behavior: 'smooth' });
  }
  function apply(z) {
    const box = scroll();
    const keep = box ? box.scrollTop / Math.max(1, box.scrollHeight) : 0;
    setZoom(Math.max(min, Math.min(max, z)));
    if (box) box.scrollTop = keep * box.scrollHeight;
    update();
  }
  function update() {
    const n = pages().length;
    level.textContent = `${Math.round(zoom() * 100)}%`;
    pager.classList.toggle('hidden', n < 2);
    total.textContent = `/ ${n}`;
    pageInput.max = n;
    if (document.activeElement !== pageInput) pageInput.value = current() + 1;
  }
  level.addEventListener('click', () => apply(1));
  pageInput.addEventListener('change', () => go((Number(pageInput.value) || 1) - 1));
  pageInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') pageInput.blur(); });

  let bound = null;
  let ticking = false;
  /** Call after the viewer is (re)built, to follow its scrolling and shortcuts. */
  function attach() {
    const box = scroll();
    if (box && el.parentElement !== box.parentElement) box.parentElement.append(el);
    if (box && box !== bound) {
      bound = box;
      box.addEventListener('scroll', () => {
        if (ticking) return;
        ticking = true;
        requestAnimationFrame(() => { ticking = false; update(); });
      }, { passive: true });
      box.addEventListener('wheel', (e) => {
        if (!(e.ctrlKey || e.metaKey)) return;
        e.preventDefault();
        apply(zoom() * (e.deltaY < 0 ? 1.1 : 1 / 1.1));
      }, { passive: false });
    }
    update();
  }
  document.addEventListener('keydown', (e) => {
    if (!bound || !bound.isConnected) return;
    const a = document.activeElement;
    if (a && (/INPUT|TEXTAREA|SELECT/.test(a.tagName) || a.isContentEditable)) return;
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.key === '+' || e.key === '=') { e.preventDefault(); apply(zoom() * 1.2); }
    else if (e.key === '-') { e.preventDefault(); apply(zoom() / 1.2); }
    else if (e.key === '0') { e.preventDefault(); apply(1); }
  });
  return { el, attach, update };
}
