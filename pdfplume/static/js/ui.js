// App shell (sidebar, top bar, command palette, theme) and small UI helpers.
import { ICONS, toolIcon } from './icons.js';
import { CATEGORIES, DEFAULT_PINS, TOOLS, TOOL_MAP } from './tools.js';

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

export function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'html') el.innerHTML = v;
    else if (k === 'style' && typeof v === 'object') {
      for (const [prop, val] of Object.entries(v)) {
        if (prop.startsWith('--')) el.style.setProperty(prop, val); else el.style[prop] = val;
      }
    }
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) {
    if (c == null || c === false) continue;
    el.append(c.nodeType ? c : document.createTextNode(String(c)));
  }
  return el;
}

export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export const isMac = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
export const modKey = isMac ? '⌘' : 'Ctrl';

// ---- persistent preferences (per browser) ------------------------------
export const store = {
  get(key, fallback) {
    try { const v = JSON.parse(localStorage.getItem(`pdfplume.${key}`)); return v ?? fallback; } catch (e) { return fallback; }
  },
  set(key, value) {
    try { localStorage.setItem(`pdfplume.${key}`, JSON.stringify(value)); } catch (e) { /* private mode */ }
  },
};

export function getPins() { return store.get('pins', DEFAULT_PINS).filter((s) => TOOL_MAP[s]); }
export function togglePin(slug) {
  const pins = getPins();
  const next = pins.includes(slug) ? pins.filter((s) => s !== slug) : [...pins, slug];
  store.set('pins', next);
  renderSidebarLists();
  return next.includes(slug);
}

export function getRecent(ttlMinutes = 120) {
  const cutoff = Date.now() - ttlMinutes * 60000;
  return store.get('recent', []).filter((r) => r.t > cutoff && TOOL_MAP[r.tool]);
}
export function addRecent(entry) {
  const list = store.get('recent', []).filter((r) => r.job !== entry.job);
  list.unshift({ ...entry, t: Date.now() });
  store.set('recent', list.slice(0, 20));
}
export function clearRecent() { store.set('recent', []); }

// ---- installable app ------------------------------------------------------
let installPrompt = null;
window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  installPrompt = e;
  const btn = $('#install-btn');
  if (btn) btn.classList.remove('hidden');
});
window.addEventListener('appinstalled', () => { installPrompt = null; $('#install-btn')?.classList.add('hidden'); });
if ('serviceWorker' in navigator && window.isSecureContext) {
  window.addEventListener('load', () => navigator.serviceWorker.register('/sw.js').catch(() => {}));
}
async function installApp() {
  if (!installPrompt) return;
  installPrompt.prompt();
  await installPrompt.userChoice.catch(() => {});
  installPrompt = null;
  $('#install-btn')?.classList.add('hidden');
}

// ---- theme ---------------------------------------------------------------
const THEMES = ['system', 'light', 'dark'];
const media = window.matchMedia('(prefers-color-scheme: dark)');
export function applyTheme() {
  const mode = store.get('theme', 'system');
  const dark = mode === 'dark' || (mode === 'system' && media.matches);
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  const btn = $('#theme-btn');
  if (btn) {
    btn.innerHTML = { system: ICONS.monitor, light: ICONS.sun, dark: ICONS.moon }[mode];
    btn.title = `Theme: ${mode} (click to change)`;
  }
}
media.addEventListener('change', applyTheme);
function cycleTheme() {
  const mode = store.get('theme', 'system');
  store.set('theme', THEMES[(THEMES.indexOf(mode) + 1) % THEMES.length]);
  applyTheme();
}

// ---- shell -------------------------------------------------------------------
let activeSlug = null;

function sbLink(t) {
  return `<a class="sb-link${t.slug === activeSlug ? ' active' : ''}" href="${t.url}" title="${esc(t.desc)}">${toolIcon(t)}<span>${esc(t.name)}</span></a>`;
}

function renderSidebarLists() {
  const box = $('#sb-scroll');
  if (!box) return;
  const collapsed = new Set(store.get('collapsed', []));
  const pins = getPins();
  let html = `<a class="sb-link home-link${activeSlug ? '' : ' active'}" href="/"><span class="hi">${ICONS.home}</span><span>Home</span></a>`;
  html += `<div class="sb-group" data-group="pinned"><div class="sb-title">Pinned</div><div class="sb-items">${
    pins.length ? pins.map((s) => sbLink(TOOL_MAP[s])).join('') : '<div class="sb-empty">Star a tool to pin it here.</div>'}</div></div>`;
  for (const c of CATEGORIES) {
    const items = TOOLS.filter((t) => t.cat === c.id);
    const isCollapsed = collapsed.has(c.id) && !items.some((t) => t.slug === activeSlug);
    html += `<div class="sb-group${isCollapsed ? ' collapsed' : ''}" data-group="${c.id}">
      <button type="button" class="sb-title" aria-expanded="${!isCollapsed}"><i style="background:${c.color}"></i>${esc(c.name)}${ICONS.chev}</button>
      <div class="sb-items">${items.map(sbLink).join('')}</div></div>`;
  }
  box.innerHTML = html;
}

/** Build the app chrome. Returns the element that holds the page content. */
export function renderShell({ active = null, crumbs = [] } = {}) {
  activeSlug = active;
  const app = h('div', { class: 'app', id: 'app-shell' });
  const sidebar = h('aside', { class: 'sidebar', 'aria-label': 'Tools', html: `
    <div class="sb-brand"><a class="brand" href="/"><span class="brand-mark">${ICONS.mark}</span><span>PDFPlume<small>Local PDF toolkit</small></span></a></div>
    <button type="button" class="sb-search" id="sb-search">${ICONS.search}<span>Search tools</span><kbd>${modKey} K</kbd></button>
    <nav class="sb-scroll" id="sb-scroll"></nav>
    <div class="sb-foot"><span class="status-chip" title="Everything runs on this computer"><span class="dot"></span><span>Running locally</span></span>
      <button type="button" class="icon-btn hidden" id="install-btn" title="Install PDFPlume as an app" aria-label="Install PDFPlume as an app">${ICONS.download}</button>
      <button type="button" class="icon-btn" id="theme-btn" aria-label="Change theme"></button></div>` });
  const trail = crumbs.map((c, i) => (i === crumbs.length - 1
    ? `<b>${esc(c.label)}</b>`
    : `<span class="crumb${i ? ' hide-sm' : ''}"><a href="${c.href}">${esc(c.label)}</a>${ICONS.chevR}</span>`)).join('');
  const topbar = h('header', { class: 'topbar', html: `
    <button type="button" class="icon-btn menu-toggle" id="menu-btn" aria-label="Open navigation">${ICONS.menu}</button>
    <div class="crumbs">${trail || '<b>Home</b>'}</div>
    <button type="button" class="btn ghost sm" id="top-search" title="Search tools">${ICONS.search}<span class="kbd">${modKey} K</span></button>` });
  const page = h('div', { class: 'page', id: 'page' });
  const scrim = h('div', { class: 'scrim' });
  app.append(sidebar, h('div', { class: 'main' }, topbar, page), scrim);
  document.body.prepend(app);
  document.body.append(h('div', { class: 'drop-overlay', id: 'drop-overlay' }, h('div', {}, 'Drop files to add them')));

  renderSidebarLists();
  applyTheme();
  $('#theme-btn').addEventListener('click', cycleTheme);
  $('#install-btn').addEventListener('click', installApp);
  if (installPrompt) $('#install-btn').classList.remove('hidden');
  $('#sb-search').addEventListener('click', openPalette);
  $('#top-search').addEventListener('click', openPalette);
  $('#menu-btn').addEventListener('click', () => app.classList.toggle('nav-open'));
  scrim.addEventListener('click', () => app.classList.remove('nav-open'));
  $('#sb-scroll').addEventListener('click', (e) => {
    const title = e.target.closest('button.sb-title');
    if (!title) return;
    const group = title.parentElement;
    group.classList.toggle('collapsed');
    title.setAttribute('aria-expanded', !group.classList.contains('collapsed'));
    store.set('collapsed', $$('.sb-group.collapsed').map((g) => g.dataset.group));
  });
  const activeLink = $('.sb-link.active', sidebar);
  if (activeLink) requestAnimationFrame(() => activeLink.scrollIntoView({ block: 'nearest' }));
  document.addEventListener('keydown', (e) => {
    const typing = /INPUT|TEXTAREA|SELECT/.test(document.activeElement?.tagName || '') || document.activeElement?.isContentEditable;
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); openPalette(); }
    else if (e.key === '/' && !typing) { e.preventDefault(); openPalette(); }
  });
  return page;
}

// ---- command palette ---------------------------------------------------------
function score(t, q) {
  if (!q) return 1;
  const name = t.name.toLowerCase();
  if (name.startsWith(q)) return 100;
  if (name.split(/\s+/).some((w) => w.startsWith(q))) return 80;
  if (name.includes(q)) return 60;
  if (t.keywords.includes(q)) return 40;
  if (`${t.desc} ${t.cat}`.toLowerCase().includes(q)) return 20;
  return 0;
}

let paletteOpen = false;
export function openPalette() {
  if (paletteOpen) return;
  paletteOpen = true;
  const input = h('input', { type: 'text', placeholder: 'What do you want to do?  e.g. merge, compress, sign …', 'aria-label': 'Search tools', autocomplete: 'off' });
  const list = h('div', { class: 'palette-list', role: 'listbox' });
  const back = h('div', { class: 'modal-back palette-back' });
  const box = h('div', { class: 'palette', role: 'dialog', 'aria-modal': 'true' },
    h('div', { class: 'palette-input', html: ICONS.search }, input), list,
    h('div', { class: 'palette-foot', html: '<span><kbd>↑</kbd><kbd>↓</kbd> navigate</span><span><kbd>↵</kbd> open</span><span><kbd>esc</kbd> close</span>' }));
  back.append(box);
  let items = [];
  let index = 0;
  const close = () => { back.remove(); paletteOpen = false; document.removeEventListener('keydown', onKey, true); };
  const go = (t) => { close(); location.href = t.url; };
  const render = () => {
    const q = input.value.trim().toLowerCase();
    items = TOOLS.map((t) => [t, score(t, q)]).filter(([, s]) => s > 0).sort((a, b) => b[1] - a[1]).map(([t]) => t);
    index = Math.min(index, Math.max(0, items.length - 1));
    list.innerHTML = items.length ? '' : '<div class="palette-empty">No matching tool</div>';
    const cats = Object.fromEntries(CATEGORIES.map((c) => [c.id, c.name]));
    items.forEach((t, i) => {
      const row = h('div', { class: `palette-item${i === index ? ' active' : ''}`, role: 'option', html:
        `${toolIcon(t)}<span class="pi-text"><b>${esc(t.name)}</b><small>${esc(t.desc)}</small></span><span class="cat">${esc(cats[t.cat])}</span>` });
      row.addEventListener('mousemove', () => { if (index !== i) { index = i; render(); } });
      row.addEventListener('click', () => go(t));
      list.append(row);
    });
    const act = list.children[index];
    if (act && act.scrollIntoView) act.scrollIntoView({ block: 'nearest' });
  };
  const onKey = (e) => {
    if (e.key === 'Escape') { e.preventDefault(); close(); }
    else if (e.key === 'ArrowDown') { e.preventDefault(); index = Math.min(items.length - 1, index + 1); render(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); index = Math.max(0, index - 1); render(); }
    else if (e.key === 'Enter' && items[index]) { e.preventDefault(); go(items[index]); }
  };
  input.addEventListener('input', () => { index = 0; render(); });
  back.addEventListener('mousedown', (e) => { if (e.target === back) close(); });
  document.addEventListener('keydown', onKey, true);
  document.body.append(back);
  render();
  input.focus();
}

// ---- toasts & modals -------------------------------------------------------
let toastBox = null;
export function toast(msg, type = '') {
  if (!toastBox) { toastBox = h('div', { class: 'toasts', role: 'status', 'aria-live': 'polite' }); document.body.append(toastBox); }
  const t = h('div', { class: `toast ${type}`, html: type === 'error' ? ICONS.alert : ICONS.checkCircle }, msg);
  toastBox.append(t);
  setTimeout(() => t.remove(), type === 'error' ? 6000 : 3200);
}

export function modal({ title, body, foot, wide = false, onClose }) {
  const back = h('div', { class: 'modal-back' });
  const box = h('div', { class: `modal${wide ? ' wide' : ''}`, role: 'dialog', 'aria-modal': 'true' });
  const close = () => { back.remove(); document.removeEventListener('keydown', onKey); if (onClose) onClose(); };
  const onKey = (e) => { if (e.key === 'Escape') close(); };
  const head = h('div', { class: 'modal-head' }, h('h3', {}, title), h('button', { type: 'button', 'aria-label': 'Close', onclick: close, html: '&times;' }));
  const bodyEl = h('div', { class: 'modal-body' });
  if (typeof body === 'string') bodyEl.innerHTML = body; else if (body) bodyEl.append(body);
  box.append(head, bodyEl);
  if (foot) { const f = h('div', { class: 'modal-foot' }); f.append(...foot); box.append(f); }
  back.append(box);
  back.addEventListener('mousedown', (e) => { if (e.target === back) close(); });
  document.addEventListener('keydown', onKey);
  document.body.append(back);
  return { close, body: bodyEl, box };
}

export function promptPassword(fileName, { error } = {}) {
  return new Promise((resolve) => {
    const input = h('input', { type: 'password', placeholder: 'Password', autocomplete: 'off' });
    const body = h('div', {},
      h('p', { style: 'margin:0 0 14px;line-height:1.5;color:var(--text-2)' }, `“${fileName}” is password protected. Enter the password to open it.`),
      error ? h('p', { style: 'color:var(--danger);margin:-6px 0 12px;font-size:13px' }, error) : null,
      input);
    let done = false;
    const finish = (v) => { if (done) return; done = true; m.close(); resolve(v); };
    const ok = h('button', { class: 'btn primary', type: 'button', onclick: () => finish(input.value) }, 'Unlock');
    const cancel = h('button', { class: 'btn', type: 'button', onclick: () => finish(null) }, 'Cancel');
    const m = modal({ title: 'Password required', body, foot: [cancel, ok], onClose: () => finish(null) });
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') finish(input.value); });
    setTimeout(() => input.focus(), 30);
  });
}

export function setTitle(text) { document.title = text ? `${text} · PDFPlume` : 'PDFPlume · Local PDF toolkit'; }

export function relativeTime(t) {
  const s = Math.round((Date.now() - t) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  return `${Math.round(s / 3600)} h ago`;
}

/** Make children of `container` reorderable with drag & drop. */
export function makeSortable(container, itemSelector, onReorder, { axis = 'x' } = {}) {
  let dragEl = null;
  const after = (e, r) => (axis === 'y' ? e.clientY >= r.top + r.height / 2 : e.clientX >= r.left + r.width / 2);
  const clear = () => $$(`${itemSelector}.drop-before, ${itemSelector}.drop-after`, container).forEach((x) => x.classList.remove('drop-before', 'drop-after'));
  container.addEventListener('dragstart', (e) => {
    const item = e.target.closest(itemSelector);
    if (!item) return;
    dragEl = item;
    item.classList.add('dragging');
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', '');
  });
  container.addEventListener('dragend', () => { if (dragEl) dragEl.classList.remove('dragging'); clear(); dragEl = null; });
  container.addEventListener('dragover', (e) => {
    if (!dragEl) return;
    e.preventDefault();
    const over = e.target.closest(itemSelector);
    clear();
    if (!over || over === dragEl) return;
    const r = over.getBoundingClientRect();
    over.classList.add(after(e, r) ? 'drop-after' : 'drop-before');
  });
  container.addEventListener('drop', (e) => {
    if (!dragEl) return;
    e.preventDefault();
    e.stopPropagation();
    const over = e.target.closest(itemSelector);
    if (!over || over === dragEl) return;
    const items = $$(itemSelector, container);
    const from = items.indexOf(dragEl);
    let to = items.indexOf(over);
    const r = over.getBoundingClientRect();
    if (after(e, r)) to += 1;
    if (from < to) to -= 1;
    onReorder(from, to);
  });
}

export function moveItem(arr, from, to) {
  const [x] = arr.splice(from, 1);
  arr.splice(to, 0, x);
  return arr;
}

export function debounce(fn, ms = 300) {
  let t;
  return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}

export function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = src;
  });
}
