// Page thumbnail grid used by Remove pages, Extract pages and Organize PDF.
import { ICONS } from '../icons.js';
import { filesBar } from '../tool.js';
import { esc, h, makeSortable, moveItem } from '../ui.js';
import { FILE_COLORS, parsePages, rangeString, rotatedImgStyle } from './common.js';

export function create(ctx) {
  const { tool, state } = ctx;
  const mode = tool.pageMode; // remove | select | organize
  let marked = new Set();     // remove/select: page indexes
  let layout = [];            // organize: [{key, page, rotation, blank}]
  let separate = false;
  let input = null;

  const file = () => ctx.ready()[0];

  function syncLayout() {
    // Keep pages of files that still exist, add pages of new files at the end.
    const ready = ctx.ready().filter((f) => f.pages);
    const keys = new Set(ready.map((f) => f.key));
    layout = layout.filter((p) => p.blank || keys.has(p.key));
    for (const f of ready) {
      if (!layout.some((p) => p.key === f.key)) {
        for (let i = 0; i < f.pages; i++) layout.push({ key: f.key, page: i, rotation: 0 });
      }
    }
  }

  function tile({ f, page, rotation = 0, blank = false, index }) {
    const t = h('div', { class: 'page-tile', 'data-index': index, draggable: mode === 'organize' ? 'true' : null });
    const pimg = h('div', { class: 'pimg' });
    if (blank) pimg.append(h('div', { class: 'blank' }));
    else pimg.append(h('img', { src: ctx.thumbUrl(f, page, 220), loading: 'lazy', draggable: 'false', style: rotatedImgStyle(rotation) }));
    t.append(pimg, h('div', { class: 'num' }, blank ? 'Blank page' : `${page + 1}`));
    return t;
  }

  function renderSimple(area) {
    const f = file();
    if (!f) return;
    const grid = h('div', { class: 'page-grid' });
    for (let i = 0; i < f.pages; i++) {
      const t = tile({ f, page: i, index: i });
      const on = marked.has(i);
      if (mode === 'remove') t.classList.toggle('removed', on);
      else {
        t.classList.toggle('selected', on);
        t.append(h('span', { class: 'check', html: on ? ICONS.check : '' }));
      }
      t.addEventListener('click', () => {
        if (marked.has(i)) marked.delete(i); else marked.add(i);
        if (input) input.value = rangeString([...marked]);
        renderSimple(area);
        updateInfo();
      });
      grid.append(t);
    }
    area.innerHTML = '';
    const label = `<b>${marked.size}</b> of ${f.pages} pages ${mode === 'remove' ? 'marked for removal' : 'selected'} · ${esc(f.name)}`;
    area.append(filesBar({ label }),
      h('p', { class: 'grid-hint' }, mode === 'remove' ? 'Click pages to mark them for removal.' : 'Click pages to select them.'), grid);
  }

  function renderOrganize(area) {
    syncLayout();
    const byKey = Object.fromEntries(state.files.map((f) => [f.key, f]));
    const colorOf = Object.fromEntries(ctx.ready().map((f, i) => [f.key, FILE_COLORS[i % FILE_COLORS.length]]));
    area.innerHTML = '';
    area.append(filesBar({ label: `<b>${layout.length}</b> pages from ${ctx.ready().length} file${ctx.ready().length === 1 ? '' : 's'}` }));
    area.append(h('p', { class: 'grid-hint' }, 'Drag pages to reorder. Hover a page to rotate, duplicate, insert a blank page or delete it.'));
    const grid = h('div', { class: 'page-grid' });
    layout.forEach((p, idx) => {
      const t = tile({ f: byKey[p.key], page: p.page, rotation: p.rotation, blank: p.blank, index: idx });
      if (!p.blank && ctx.ready().length > 1) t.append(h('span', { class: 'file-dot', style: { background: colorOf[p.key] }, title: byKey[p.key] && byKey[p.key].name }));
      const tools = h('div', { class: 'tools' },
        h('button', { type: 'button', title: 'Rotate', html: ICONS.rotR, onclick: (e) => { e.stopPropagation(); p.rotation = (p.rotation + 90) % 360; renderOrganize(area); } }),
        h('button', { type: 'button', title: 'Insert blank page after', html: ICONS.blank, onclick: (e) => { e.stopPropagation(); layout.splice(idx + 1, 0, { blank: true, rotation: 0 }); renderOrganize(area); } }),
        h('button', { type: 'button', title: 'Duplicate', html: ICONS.copy, onclick: (e) => { e.stopPropagation(); layout.splice(idx + 1, 0, { ...p }); renderOrganize(area); } }),
        h('button', { type: 'button', title: 'Delete', html: ICONS.trash, onclick: (e) => { e.stopPropagation(); layout.splice(idx, 1); renderOrganize(area); } }));
      t.append(tools);
      grid.append(t);
    });
    makeSortable(grid, '.page-tile', (from, to) => { moveItem(layout, from, to); renderOrganize(area); });
    area.append(grid);
    updateInfo();
  }

  let info = null;
  function updateInfo() {
    if (!info) return;
    const f = file();
    if (mode === 'organize') info.textContent = `${layout.length} page(s) in the new document.`;
    else if (f) {
      info.textContent = mode === 'remove'
        ? `${marked.size} of ${f.pages} pages will be removed. The new PDF will have ${f.pages - marked.size} page(s).`
        : `${marked.size} page(s) selected.`;
    }
  }

  return {
    render(area) {
      if (mode === 'organize') renderOrganize(area); else renderSimple(area);
    },
    onFiles() {
      if (mode !== 'organize') marked = new Set();
    },
    sidebar(body) {
      info = h('div', { class: 'info-box' });
      body.append(info);
      if (mode === 'organize') {
        body.append(h('div', { class: 'opt' }, h('label', { class: 'lbl' }, 'Sort pages'),
          h('div', { class: 'row' },
            h('button', { type: 'button', class: 'btn', html: `${ICONS.reset} Reset`, onclick: () => { layout = []; ctx.refresh(); } }),
            h('button', { type: 'button', class: 'btn', html: `${ICONS.reverse} Reverse`, onclick: () => { layout.reverse(); ctx.refresh(); } }))),
        h('div', { class: 'opt' }, h('button', { type: 'button', class: 'btn', style: 'width:100%;justify-content:center', html: `${ICONS.blank} Add blank page at the end`,
          onclick: () => { layout.push({ blank: true, rotation: 0 }); ctx.refresh(); } })),
        h('div', { class: 'opt' }, h('button', { type: 'button', class: 'btn', style: 'width:100%;justify-content:center', html: `${ICONS.plus} Add more PDF files`, onclick: () => ctx.openPicker() })));
      } else {
        input = h('input', { type: 'text', placeholder: 'e.g. 1,3,5-8', value: rangeString([...marked]),
          oninput: () => { const f = file(); if (f) { marked = parsePages(input.value, f.pages); ctx.refresh(); updateInfo(); } } });
        body.append(h('div', { class: 'opt' }, h('label', { class: 'lbl' }, mode === 'remove' ? 'Pages to remove' : 'Pages to extract'), input,
          h('div', { class: 'help' }, 'Click pages on the left or type page numbers and ranges.')));
        if (mode === 'select') {
          body.append(h('div', { class: 'opt' }, h('label', { class: 'check-row' },
            h('input', { type: 'checkbox', checked: separate, onchange: (e) => { separate = e.target.checked; } }),
            h('span', {}, 'Save every selected page as a separate PDF'))));
          body.append(h('div', { class: 'opt' }, h('button', { type: 'button', class: 'btn small', onclick: () => {
            const f = file(); if (!f) return;
            marked = new Set([...Array(f.pages).keys()]); input.value = rangeString([...marked]); ctx.refresh(); updateInfo();
          } }, 'Select all'), ' ', h('button', { type: 'button', class: 'btn small', onclick: () => { marked = new Set(); input.value = ''; ctx.refresh(); updateInfo(); } }, 'Clear')));
        }
      }
      updateInfo();
    },
    validate() {
      if (mode === 'organize') return layout.length ? null : 'There are no pages left.';
      const f = file();
      if (!marked.size) return mode === 'remove' ? 'Select the pages you want to remove.' : 'Select the pages you want to extract.';
      if (mode === 'remove' && f && marked.size >= f.pages) return 'You cannot remove every page.';
      return null;
    },
    payload() {
      const ready = ctx.ready();
      if (mode === 'organize') {
        const index = Object.fromEntries(ready.map((f, i) => [f.key, i]));
        return {
          files: ready.map((f) => ({ id: f.id })),
          options: { pages: layout.map((p) => (p.blank ? { page: null, blank: true, rotation: p.rotation } : { file: index[p.key], page: p.page, rotation: p.rotation })) },
        };
      }
      return { files: [{ id: ready[0].id }], options: { pages: rangeString([...marked]), separate } };
    },
  };
}
