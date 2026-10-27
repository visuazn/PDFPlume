// Properties & bookmarks: edit the document information and build the
// outline (table of contents) shown in every PDF viewer's sidebar.
import { ICONS } from '../icons.js';
import { esc, h, makeSortable, moveItem, toast } from '../ui.js';

const FIELDS = [
  ['title', 'Title', 'Shown in the viewer’s title bar and in search results'],
  ['author', 'Author', ''],
  ['subject', 'Subject', ''],
  ['keywords', 'Keywords', 'Separate keywords with commas'],
  ['creator', 'Created with', 'The app the document was made in'],
  ['producer', 'PDF producer', ''],
];

export function create(ctx) {
  const st = { fileId: null, meta: {}, toc: [], suggested: [], pages: 1, dirty: false, current: 0, openOutline: true };
  let list = null;
  let preview = null;
  let countEl = null;
  const file = () => ctx.ready()[0];

  async function load(f) {
    if (st.fileId === f.id) return;
    const data = await ctx.api.get(`/api/files/${f.id}/outline`);
    Object.assign(st, { fileId: f.id, meta: data.metadata, toc: data.toc.map((t) => ({ ...t })), suggested: data.suggested, pages: data.pages, dirty: false, current: 0 });
  }

  function changed() { st.dirty = true; if (countEl) countEl.innerHTML = countText(); }
  const countText = () => `<b>${st.toc.length}</b> bookmark${st.toc.length === 1 ? '' : 's'}`;

  function normalize() {
    let prev = 0;
    for (const t of st.toc) { t.level = Math.max(1, Math.min(t.level, prev + 1)); prev = t.level; }
  }

  function showPage(page) {
    if (!preview || !st.fileId) return;
    const p = Math.max(1, Math.min(st.pages, page || 1));
    preview.querySelector('img').src = ctx.api.thumb(st.fileId, p - 1, 500);
    preview.querySelector('.cap').textContent = `Page ${p} of ${st.pages}`;
  }

  function row(t, i) {
    const title = h('input', { type: 'text', class: 'bm-title', 'aria-label': 'Bookmark title', placeholder: 'Bookmark title' });
    title.value = t.title;
    title.addEventListener('input', () => { t.title = title.value; changed(); });
    title.addEventListener('keydown', (e) => {
      if (e.key === 'Tab' && e.altKey) { e.preventDefault(); indent(i, e.shiftKey ? -1 : 1); }
      if (e.key === 'Enter') { e.preventDefault(); add(i + 1, { level: t.level, page: t.page }); }
    });
    const page = h('input', { type: 'number', class: 'bm-page', min: 1, max: st.pages, 'aria-label': 'Page number' });
    page.value = t.page;
    page.addEventListener('input', () => { t.page = Math.max(1, Math.min(st.pages, Number(page.value) || 1)); showPage(t.page); changed(); });
    const r = h('div', { class: `bm-row${i === st.current ? ' current' : ''}`, draggable: 'true', style: { '--lvl': t.level - 1 } },
      h('span', { class: 'grip', title: 'Drag to reorder', 'aria-hidden': 'true' }, '⋮⋮'),
      title,
      h('span', { class: 'bm-p' }, 'p.', page),
      h('div', { class: 'bm-actions' },
        h('button', { type: 'button', class: 'icon-btn', title: 'Move out (Alt+Shift+Tab)', 'aria-label': 'Move out', disabled: t.level <= 1, onclick: () => indent(i, -1), html: ICONS.chevL }),
        h('button', { type: 'button', class: 'icon-btn', title: 'Move in (Alt+Tab)', 'aria-label': 'Move in', disabled: i === 0 || t.level > st.toc[i - 1].level, onclick: () => indent(i, 1), html: ICONS.chevR }),
        h('button', { type: 'button', class: 'icon-btn', title: 'Delete', 'aria-label': `Delete ${t.title}`, onclick: () => remove(i), html: ICONS.trash })));
    r.addEventListener('focusin', () => {
      st.current = i;
      list.querySelectorAll('.bm-row.current').forEach((x) => x.classList.remove('current'));
      r.classList.add('current');
      showPage(t.page);
    });
    return r;
  }

  function renderList(focus = null) {
    if (!list) return;
    list.innerHTML = '';
    if (!st.toc.length) {
      list.append(h('div', { class: 'empty-note' }, 'No bookmarks yet. Add one, or start from the headings found in the document.'));
    } else {
      st.toc.forEach((t, i) => list.append(row(t, i)));
    }
    if (countEl) countEl.innerHTML = countText();
    if (focus != null) list.querySelectorAll('.bm-title')[focus]?.focus();
  }

  function indent(i, d) {
    const t = st.toc[i];
    const max = i === 0 ? 1 : st.toc[i - 1].level + 1;
    const lvl = Math.max(1, Math.min(max, t.level + d));
    if (lvl === t.level) return;
    // Children move with their parent.
    let j = i + 1;
    while (j < st.toc.length && st.toc[j].level > t.level) { st.toc[j].level += lvl - t.level; j++; }
    t.level = lvl;
    normalize();
    changed();
    renderList(i);
  }

  function add(at = st.toc.length, base = null) {
    const ref = base || st.toc[at - 1] || { level: 1, page: 1 };
    st.toc.splice(at, 0, { level: ref.level, title: '', page: ref.page || 1 });
    st.current = at;
    changed();
    renderList(at);
  }

  function remove(i) {
    const t = st.toc[i];
    let j = i + 1;
    while (j < st.toc.length && st.toc[j].level > t.level) { st.toc[j].level -= 1; j++; }
    st.toc.splice(i, 1);
    normalize();
    st.current = Math.min(i, st.toc.length - 1);
    changed();
    renderList();
  }

  function useSuggested() {
    if (st.toc.length && !confirm('Replace the current bookmarks with the detected headings?')) return;
    st.toc = st.suggested.map((t) => ({ ...t }));
    changed();
    renderList();
    toast(`${st.toc.length} bookmarks created from headings`);
  }

  return {
    async render(area) {
      const f = file();
      if (!f) { area.innerHTML = '<p class="grid-hint" style="padding:40px">Uploading…</p>'; return; }
      if (area.querySelector('.bm-wrap') && st.fileId === f.id) return;
      const fresh = st.fileId !== f.id;
      try { await load(f); } catch (e) { area.innerHTML = ''; area.append(h('div', { class: 'callout warn', html: `${ICONS.alert}<span>${esc(e.message)}</span>` })); return; }
      if (fresh) ctx.refreshSidebar();
      area.innerHTML = '';
      countEl = h('span', { class: 'count', html: countText() });
      const bar = h('div', { class: 'canvas-bar' }, countEl,
        h('button', { type: 'button', class: 'btn sm', id: 'bm-add', onclick: () => add(), html: `${ICONS.plus} Add bookmark` }),
        st.suggested.length ? h('button', { type: 'button', class: 'btn sm', id: 'bm-suggest', onclick: useSuggested, html: `${ICONS.sparkle} Use ${st.suggested.length} detected heading${st.suggested.length > 1 ? 's' : ''}` }) : null,
        st.toc.length ? h('button', { type: 'button', class: 'btn sm ghost', onclick: () => { st.toc = []; changed(); renderList(); } }, 'Remove all') : null);
      list = h('div', { class: 'bm-list' });
      preview = h('div', { class: 'bm-preview' }, h('img', { alt: '' }), h('div', { class: 'cap' }));
      area.append(bar, h('div', { class: 'bm-wrap' }, h('div', {}, list,
        h('p', { class: 'grid-hint', style: 'margin-top:12px' }, 'Enter adds a bookmark below · Alt+Tab / Alt+Shift+Tab nests and un-nests · drag ⋮⋮ to reorder')), preview));
      makeSortable(list, '.bm-row', (from, to) => {
        moveItem(st.toc, from, to);
        normalize();
        changed();
        renderList(to);
      }, { axis: 'y' });
      renderList();
      showPage(st.toc[0]?.page || 1);
    },
    sidebar(body) {
      if (!st.fileId) { body.append(h('p', { class: 'muted', style: 'font-size:13px;margin:0' }, 'Add a PDF to edit its properties.')); return; }
      body.append(h('div', { class: 'opt-title', style: 'margin-bottom:12px' }, 'Document properties'));
      for (const [key, name, help] of FIELDS) {
        const input = h(key === 'subject' ? 'textarea' : 'input', { type: 'text', id: `meta-${key}`, rows: key === 'subject' ? 2 : null });
        input.value = st.meta[key] || '';
        input.addEventListener('input', () => { st.meta[key] = input.value; });
        body.append(h('div', { class: 'opt' }, h('label', { class: 'lbl', for: `meta-${key}` }, name), input, help ? h('div', { class: 'help' }, help) : null));
      }
      body.append(h('div', { class: 'opt' }, h('label', { class: 'check-row' },
        h('input', { type: 'checkbox', checked: st.openOutline, onchange: (e) => { st.openOutline = e.target.checked; } }),
        'Show the bookmarks panel when the PDF opens')));
    },
    onFiles() { st.fileId = null; },
    validate() {
      if (st.toc.some((t) => !t.title.trim())) return 'Give every bookmark a title (or delete the empty ones).';
      return null;
    },
    payload() {
      return {
        files: [{ id: file().id }],
        options: { metadata: st.meta, toc: st.dirty ? st.toc : null, open_outline: st.openOutline },
      };
    },
  };
}
