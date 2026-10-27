// Compare PDF: choose two files, then browse the differences.
import { ICONS } from '../icons.js';
import { renderOptions } from '../options.js';
import { esc, h } from '../ui.js';

export function create(ctx) {
  const { state } = ctx;

  // Every file remembers its slot (0 = original, 1 = modified).
  function normalize() {
    for (const f of state.files) {
      if (f.slot == null) f.slot = [0, 1].find((i) => !state.files.some((g) => g.slot === i)) ?? 1;
    }
    state.files.sort((p, q) => p.slot - q.slot);
  }

  function pickFor(slot) {
    ctx.openPicker({
      multiple: false,
      onFiles: (files) => {
        const old = state.files.find((f) => f.slot === slot);
        if (old) {
          state.files.splice(state.files.indexOf(old), 1);
          if (old.id) ctx.api.del(`/api/files/${old.id}`).catch(() => {});
        }
        const before = state.files.length;
        ctx.addFiles([files[0]]);
        // addFiles appends the new entry synchronously.
        if (state.files.length > before) state.files[state.files.length - 1].slot = slot;
        normalize();
        ctx.refresh();
      },
    });
  }

  return {
    startInWork: true,
    keepWork: true,
    render(area) {
      normalize();
      area.innerHTML = '';
      const slots = h('div', { class: 'compare-slots' });
      ['Original file', 'Modified file'].forEach((label, i) => {
        const f = state.files.find((x) => x.slot === i);
        const slot = h('div', { class: `compare-slot${f ? '' : ' empty'}` }, h('h4', {}, label));
        if (f) {
          if (f.id && !f.uploading) slot.append(h('img', { src: ctx.thumbUrl(f, 0, 360), alt: '' }));
          else slot.append(h('div', { class: 'spinner', style: 'width:40px;height:40px;border-width:4px;margin:0' }));
          slot.append(h('div', { style: 'font-weight:600;font-size:14px;word-break:break-all' }, f.name),
            h('div', { class: 'muted', style: 'font-size:13px' }, f.pages ? `${f.pages} pages` : ''),
            h('div', { class: 'row', style: 'flex:none;gap:8px' },
              h('button', { type: 'button', class: 'btn small', onclick: () => pickFor(i) }, 'Change'),
              h('button', { type: 'button', class: 'btn small', html: ICONS.x, title: 'Remove', onclick: () => ctx.removeFile(f) })));
        } else {
          slot.append(h('p', { class: 'muted', style: 'margin:0' }, i === 0 ? 'The older version of the document' : 'The newer version to compare with'),
            h('button', { type: 'button', class: 'btn primary', onclick: () => pickFor(i), html: `${ICONS.upload} Select PDF` }));
        }
        slots.append(slot);
      });
      area.append(h('p', { class: 'grid-hint', style: 'text-align:center' }, 'Add the original and the revised version – or drop both files at once.'), slots);
    },
    sidebar(body) {
      renderOptions(body, ctx.tool.options, state.options, ctx.caps, () => {});
    },
    validate() { normalize(); return ctx.ready().length === 2 ? null : 'Select both files to compare.'; },
  };
}

// ------------------------------------------------------------- results view
export function renderComparison(container, result) {
  const x = result.extra || {};
  if (x.mode === 'overlay') {
    container.append(h('div', { class: 'legend' },
      h('span', {}, h('i', { style: { background: '#e53935' } }), 'Only in the original'),
      h('span', {}, h('i', { style: { background: '#1e5bd8' } }), 'Only in the modified file'),
      h('span', {}, h('i', { style: { background: '#222' } }), 'In both')));
    const grid = h('div', { class: 'overlay-pages' });
    for (const [i, p] of x.pages.entries()) {
      grid.append(h('figure', {}, h('img', { src: `/api/jobs/${result.jobId}/assets/${p.asset}`, alt: `Page ${i + 1}`, loading: 'lazy' }),
        h('figcaption', {}, `Page ${i + 1} · ${p.changed ? `${p.changed}% of the page changed` : 'identical'}`)));
    }
    container.append(grid);
    return;
  }
  const { a, b, changes, stats } = x;
  container.append(h('div', { class: 'stats', style: 'justify-content:center' },
    h('span', {}, `${stats.changed} changed`), h('span', {}, `${stats.deleted} removed`), h('span', {}, `${stats.inserted} added`)),
  h('div', { class: 'legend' },
    h('span', {}, h('i', { style: { background: 'rgba(229,72,77,.5)' } }), 'Removed'),
    h('span', {}, h('i', { style: { background: 'rgba(48,164,108,.5)' } }), 'Added'),
    h('span', {}, h('i', { style: { background: 'rgba(255,178,36,.6)' } }), 'Changed')));
  const view = h('div', { class: 'cmp-view' });
  const column = (doc) => {
    const col = h('div', { class: 'cmp-col' }, h('h5', { title: doc.name }, doc.name));
    doc.pages.forEach((p, i) => {
      const page = h('div', { class: 'cmp-page', 'data-page': i, style: { aspectRatio: `${p.w} / ${p.h}` } },
        h('img', { src: `/api/files/${doc.id}/thumb/${i}?w=800`, loading: 'lazy', alt: '' }));
      for (const hl of doc.highlights.filter((q) => q.page === i)) {
        const [x0, y0, x1, y1] = hl.rect;
        page.append(h('div', { class: `hl ${hl.kind}`, 'data-change': hl.change, style: {
          left: `${x0 * 100}%`, top: `${y0 * 100}%`, width: `${(x1 - x0) * 100}%`, height: `${(y1 - y0) * 100}%` } }));
      }
      col.append(page);
    });
    return col;
  };
  const colA = column(a);
  const colB = column(b);
  const list = h('div', { class: 'cmp-list' });
  if (!changes.length) list.append(h('div', { class: 'ch' }, 'The text of both documents is identical.'));
  const focus = (idx) => {
    view.querySelectorAll('.hl.focus').forEach((n) => n.classList.remove('focus'));
    for (const col of [colA, colB]) {
      const hits = col.querySelectorAll(`.hl[data-change="${idx}"]`);
      hits.forEach((n) => n.classList.add('focus'));
      if (hits[0]) col.scrollTo({ top: hits[0].offsetTop + hits[0].parentElement.offsetTop - 80, behavior: 'smooth' });
    }
  };
  changes.forEach((c, idx) => {
    const label = { del: 'Removed', ins: 'Added', chg: 'Changed' }[c.kind];
    const body = c.kind === 'chg' ? `<del>${esc(c.a)}</del> → <ins>${esc(c.b)}</ins>` : c.kind === 'del' ? `<del>${esc(c.a)}</del>` : `<ins>${esc(c.b)}</ins>`;
    list.append(h('div', { class: `ch ${c.kind}`, onclick: () => focus(idx), html: `<b>${label}</b> · page ${(c.kind === 'ins' ? c.b_page : c.a_page) + 1}<br>${body}` }));
  });
  view.addEventListener('click', (e) => { const hl = e.target.closest('.hl'); if (hl) focus(hl.dataset.change); });
  view.append(colA, colB, list);
  container.append(view);
}
