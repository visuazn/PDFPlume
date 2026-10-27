// Crop PDF: drag a crop rectangle over a page preview.
import { ICONS } from '../icons.js';
import { h } from '../ui.js';

export function create(ctx) {
  const st = { page: 0, box: { x0: 0.08, y0: 0.08, x1: 0.92, y1: 0.92 }, apply: 'all', sizes: null };
  let info = null;
  const file = () => ctx.ready()[0];

  function describe() {
    if (!info || !st.sizes) return;
    const p = st.sizes[st.page];
    const w = (st.box.x1 - st.box.x0) * p.w;
    const hh = (st.box.y1 - st.box.y0) * p.h;
    info.textContent = `Crop area: ${(w / 72 * 25.4).toFixed(0)} × ${(hh / 72 * 25.4).toFixed(0)} mm (${Math.round(w)} × ${Math.round(hh)} pt)`;
  }

  async function render(area) {
    const f = file();
    area.innerHTML = '';
    if (!f) return;
    if (!st.sizes || st.fileId !== f.id) {
      st.sizes = (await ctx.api.get(`/api/files/${f.id}/pages`)).pages;
      st.fileId = f.id;
      st.page = 0;
    }
    const p = st.sizes[st.page];
    const maxW = Math.min(area.clientWidth - 80, 760);
    const maxH = window.innerHeight - 220;
    const scale = Math.min(maxW / p.w, maxH / p.h);
    const W = p.w * scale;
    const H = p.h * scale;
    const nav = h('div', { class: 'page-nav' },
      h('button', { type: 'button', class: 'btn icon', disabled: st.page === 0, html: ICONS.chevL, onclick: () => { st.page--; render(area); } }),
      h('span', {}, `Page ${st.page + 1} of ${st.sizes.length}`),
      h('button', { type: 'button', class: 'btn icon', disabled: st.page >= st.sizes.length - 1, html: ICONS.chevR, onclick: () => { st.page++; render(area); } }));
    const page = h('div', { class: 'vpage', style: { width: `${W}px`, height: `${H}px`, margin: '0 auto', overflow: 'hidden' } },
      h('img', { src: ctx.thumbUrl(f, st.page, Math.min(2000, Math.ceil(W * 2 / 200) * 200)), draggable: 'false' }));
    const box = h('div', { class: 'crop-box' });
    for (const k of ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w']) box.append(h('span', { class: `hd ${k}`, 'data-h': k }));
    const place = () => Object.assign(box.style, { left: `${st.box.x0 * 100}%`, top: `${st.box.y0 * 100}%`, width: `${(st.box.x1 - st.box.x0) * 100}%`, height: `${(st.box.y1 - st.box.y0) * 100}%` });
    place();
    page.append(box);
    box.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      const handle = e.target.dataset.h || 'move';
      const r = page.getBoundingClientRect();
      const start = { x: e.clientX, y: e.clientY, ...st.box };
      const move = (ev) => {
        const dx = (ev.clientX - start.x) / r.width;
        const dy = (ev.clientY - start.y) / r.height;
        const b = { ...st.box };
        const min = 0.03;
        if (handle === 'move') {
          const w = start.x1 - start.x0; const hh = start.y1 - start.y0;
          b.x0 = Math.max(0, Math.min(1 - w, start.x0 + dx)); b.x1 = b.x0 + w;
          b.y0 = Math.max(0, Math.min(1 - hh, start.y0 + dy)); b.y1 = b.y0 + hh;
        } else {
          if (handle.includes('w')) b.x0 = Math.max(0, Math.min(start.x1 - min, start.x0 + dx));
          if (handle.includes('e')) b.x1 = Math.min(1, Math.max(start.x0 + min, start.x1 + dx));
          if (handle.includes('n')) b.y0 = Math.max(0, Math.min(start.y1 - min, start.y0 + dy));
          if (handle.includes('s')) b.y1 = Math.min(1, Math.max(start.y0 + min, start.y1 + dy));
        }
        st.box = b;
        place();
        describe();
      };
      const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); };
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', up);
    });
    area.append(nav, page);
    describe();
  }

  return {
    render,
    sidebar(body) {
      info = h('div', { class: 'info-box' });
      const seg = h('div', { class: 'cards' }, ...[['all', 'All pages', 'Apply the crop to every page.'], ['current', 'Current page', 'Crop only the page shown.']].map(([v, t, d]) =>
        h('button', { type: 'button', class: `opt-card${st.apply === v ? ' active' : ''}`, onclick: () => { st.apply = v; ctx.refreshSidebar(); } },
          h('span', { class: 'radio' }), h('span', {}, h('span', { class: 't' }, t), h('span', { class: 'd' }, d)))));
      body.append(h('p', { class: 'muted', style: 'font-size:13px;margin:0 0 14px' }, 'Drag the frame or its handles to choose the area to keep.'),
        info, h('div', { class: 'opt' }, h('label', { class: 'lbl' }, 'Apply to'), seg),
        h('div', { class: 'opt' }, h('button', { type: 'button', class: 'btn', html: `${ICONS.reset} Reset crop area`, onclick: () => { st.box = { x0: 0, y0: 0, x1: 1, y1: 1 }; ctx.refresh(); } })));
      describe();
    },
    onFiles() { st.sizes = null; },
    payload() {
      return { files: [{ id: file().id }], options: { box: st.box, apply: st.apply, page: st.page } };
    },
  };
}
