// Split PDF: custom / fixed ranges, extract pages, split by size.
import { ICONS } from '../icons.js';
import { h } from '../ui.js';
import { FILE_COLORS, parsePages, rangeString } from './common.js';

export function create(ctx) {
  const s = {
    tab: 'range', rangeMode: 'custom', ranges: [{ from: 1, to: 1 }], merge: false, every: 1,
    pagesMode: 'all', pages: '', mergePages: true, maxMb: 1,
  };
  const file = () => ctx.ready()[0];
  const count = () => (file() ? file().pages : 0);

  function groups() {
    const n = count();
    if (!n) return [];
    if (s.tab === 'range' && s.rangeMode === 'custom') {
      return s.ranges.map((r) => {
        const a = Math.max(1, Math.min(n, +r.from || 1));
        const b = Math.max(a, Math.min(n, +r.to || n));
        return Array.from({ length: b - a + 1 }, (_, i) => a - 1 + i);
      });
    }
    if (s.tab === 'range') {
      const size = Math.max(1, +s.every || 1);
      const out = [];
      for (let i = 0; i < n; i += size) out.push(Array.from({ length: Math.min(size, n - i) }, (_, k) => i + k));
      return out;
    }
    if (s.tab === 'pages' && s.pagesMode === 'all') return Array.from({ length: n }, (_, i) => [i]);
    if (s.tab === 'pages') {
      const sel = [...parsePages(s.pages, n)].sort((a, b) => a - b);
      return s.mergePages ? [sel] : sel.map((p) => [p]);
    }
    return [];
  }

  function render(area) {
    const f = file();
    area.innerHTML = '';
    if (!f) return;
    const owner = {};
    groups().forEach((g, gi) => g.forEach((p) => { owner[p] = gi; }));
    const grid = h('div', { class: 'page-grid' });
    for (let i = 0; i < f.pages; i++) {
      const t = h('div', { class: 'page-tile' }, h('div', { class: 'pimg' }, h('img', { src: ctx.thumbUrl(f, i, 220), loading: 'lazy', draggable: 'false' })),
        h('div', { class: 'num' }, i + 1));
      const g = owner[i];
      const selectable = s.tab === 'pages' && s.pagesMode === 'select';
      if (g != null && s.tab !== 'size') {
        const color = FILE_COLORS[g % FILE_COLORS.length];
        t.style.borderColor = selectable ? 'var(--accent)' : color;
        if (!selectable) t.append(h('span', { class: 'range-tag', style: { background: color } }, s.tab === 'range' ? `Range ${g + 1}` : `File ${g + 1}`));
      } else if (s.tab !== 'size') t.style.opacity = '.5';
      if (selectable) {
        const on = g != null;
        t.classList.toggle('selected', on);
        t.append(h('span', { class: 'check', html: on ? ICONS.check : '' }));
        t.addEventListener('click', () => {
          const set = parsePages(s.pages, f.pages);
          if (set.has(i)) set.delete(i); else set.add(i);
          s.pages = rangeString([...set]);
          ctx.refreshSidebar();
          render(area);
        });
      }
      grid.append(t);
    }
    area.append(grid);
  }

  function sidebar(body) {
    const n = count();
    const tabs = h('div', { class: 'tabs' });
    for (const [v, l, ic] of [['range', 'Range', 'split'], ['pages', 'Pages', 'organize'], ['size', 'Size', 'compress']]) {
      tabs.append(h('button', { type: 'button', class: s.tab === v ? 'active' : '', onclick: () => { s.tab = v; update(); },
        html: `<svg viewBox="0 0 48 48" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round">${
          ic === 'split' ? '<path d="M24 10v28M10 24h8M30 24h8"/>' : ic === 'organize' ? '<rect x="10" y="10" width="11" height="11"/><rect x="27" y="10" width="11" height="11"/><rect x="10" y="27" width="11" height="11"/><rect x="27" y="27" width="11" height="11"/>' : '<path d="M24 8v12M18 14l6 6 6-6M24 40V28M18 34l6-6 6 6"/>'}</svg><span>${l}</span>` }));
    }
    body.append(tabs);
    const seg = (key, choices) => {
      const el = h('div', { class: 'seg' });
      for (const [v, l] of choices) el.append(h('button', { type: 'button', class: s[key] === v ? 'active' : '', onclick: () => { s[key] = v; update(); } }, l));
      return h('div', { class: 'opt' }, h('label', { class: 'lbl' }, key === 'rangeMode' ? 'Range mode' : 'Extract mode'), el);
    };
    if (s.tab === 'range') {
      body.append(seg('rangeMode', [['custom', 'Custom ranges'], ['fixed', 'Fixed ranges']]));
      if (s.rangeMode === 'custom') {
        const list = h('div', { class: 'ranges' });
        s.ranges.forEach((r, i) => {
          const num = (key) => h('input', { type: 'number', min: 1, max: n, value: r[key], oninput: (e) => { r[key] = +e.target.value; ctx.refresh(); } });
          list.append(h('div', { class: 'range-item' },
            h('div', { class: 'rt' }, h('i', { style: { background: FILE_COLORS[i % FILE_COLORS.length] } }), `Range ${i + 1}`),
            s.ranges.length > 1 ? h('button', { type: 'button', class: 'del', html: ICONS.x, style: 'width:22px', onclick: () => { s.ranges.splice(i, 1); update(); } }) : null,
            h('div', { class: 'row' }, h('span', { class: 'lbl-inline' }, 'from page'), num('from'), h('span', { class: 'lbl-inline' }, 'to'), num('to'))));
        });
        body.append(list,
          h('div', { class: 'opt' }, h('button', { type: 'button', class: 'btn', style: 'width:100%;justify-content:center', html: `${ICONS.plus} Add Range`,
            onclick: () => { const total = count(); const last = s.ranges[s.ranges.length - 1]; const from = Math.max(1, Math.min(total, (last ? +last.to : 0) + 1)); s.ranges.push({ from, to: total }); update(); } })),
          h('div', { class: 'opt' }, h('label', { class: 'check-row' }, h('input', { type: 'checkbox', checked: s.merge, onchange: (e) => { s.merge = e.target.checked; } }),
            h('span', {}, 'Combine all ranges into one PDF'))));
      } else {
        const files = Math.ceil(n / Math.max(1, +s.every || 1));
        body.append(h('div', { class: 'opt' }, h('label', { class: 'lbl' }, 'Pages per file'),
          h('input', { type: 'number', min: 1, max: n, value: s.every, oninput: (e) => { s.every = +e.target.value; ctx.refresh(); infoEl.textContent = `Creates ${Math.ceil(n / Math.max(1, s.every || 1))} files of up to ${s.every} page(s) each.`; } })));
        const infoEl = h('div', { class: 'info-box' }, `Creates ${files} files of up to ${s.every} page(s) each.`);
        body.append(infoEl);
      }
    } else if (s.tab === 'pages') {
      body.append(seg('pagesMode', [['all', 'Extract all pages'], ['select', 'Select pages']]));
      if (s.pagesMode === 'all') {
        body.append(h('div', { class: 'info-box' }, `Creates ${n} single-page PDFs, one for each page.`));
      } else {
        body.append(h('div', { class: 'opt' }, h('label', { class: 'lbl' }, 'Pages to extract'),
          h('input', { type: 'text', placeholder: 'e.g. 1,5-8', value: s.pages, oninput: (e) => { s.pages = e.target.value; ctx.refresh(); } }),
          h('div', { class: 'help' }, 'Click the pages or type numbers and ranges.')),
        h('div', { class: 'opt' }, h('label', { class: 'check-row' }, h('input', { type: 'checkbox', checked: s.mergePages, onchange: (e) => { s.mergePages = e.target.checked; ctx.refresh(); } }),
          h('span', {}, 'Put the selected pages in one PDF'))));
      }
    } else {
      body.append(h('div', { class: 'opt' }, h('label', { class: 'lbl' }, 'Maximum file size (MB)'),
        h('input', { type: 'number', min: 0.05, step: 0.1, value: s.maxMb, oninput: (e) => { s.maxMb = +e.target.value; } }),
        h('div', { class: 'help' }, `Original size: ${(file() ? file().size / 1048576 : 0).toFixed(2)} MB. Pages are grouped so that each file stays below this size.`)));
    }
  }

  function update() { ctx.refreshSidebar(); ctx.refresh(); }

  return {
    render,
    sidebar,
    onFiles() { const n = count(); if (n) s.ranges = [{ from: 1, to: n }]; },
    validate() {
      if (s.tab === 'pages' && s.pagesMode === 'select' && !parsePages(s.pages, count()).size) return 'Select the pages you want to extract.';
      return null;
    },
    payload() {
      const id = file().id;
      let options;
      if (s.tab === 'range' && s.rangeMode === 'custom') options = { mode: 'ranges', ranges: s.ranges, merge: s.merge };
      else if (s.tab === 'range') options = { mode: 'fixed', every: s.every };
      else if (s.tab === 'pages' && s.pagesMode === 'all') options = { mode: 'all' };
      else if (s.tab === 'pages') options = { mode: 'select', pages: s.pages, merge: s.mergePages };
      else options = { mode: 'size', max_mb: s.maxMb };
      return { files: [{ id }], options };
    },
  };
}
