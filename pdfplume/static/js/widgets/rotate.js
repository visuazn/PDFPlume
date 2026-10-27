// Rotate PDF: whole files, or single pages when one file is open.
import { ICONS } from '../icons.js';
import { fileCard, filesBar } from '../tool.js';
import { h } from '../ui.js';
import { rotatedImgStyle } from './common.js';

export function create(ctx) {
  const norm = (d) => ((d % 360) + 360) % 360;

  function render(area) {
    const ready = ctx.ready();
    area.innerHTML = '';
    area.append(filesBar());
    if (ready.length === 1 && ctx.state.files.length === 1) {
      const f = ready[0];
      f.pageRot = f.pageRot || {};
      area.append(h('p', { class: 'grid-hint' }, 'Click a page to rotate it 90°, or rotate everything from the options panel.'));
      const grid = h('div', { class: 'page-grid' });
      for (let i = 0; i < f.pages; i++) {
        const rot = norm((f.rotation || 0) + (f.pageRot[i] || 0));
        const t = h('div', { class: 'page-tile', title: 'Click to rotate' },
          h('div', { class: 'pimg' }, h('img', { src: ctx.thumbUrl(f, i, 220), loading: 'lazy', draggable: 'false', style: rotatedImgStyle(rot) })),
          h('div', { class: 'num' }, `${i + 1}${rot ? ` · ${rot}°` : ''}`));
        t.append(h('div', { class: 'tools' },
          h('button', { type: 'button', title: 'Rotate left', html: ICONS.rotL, onclick: (e) => { e.stopPropagation(); f.pageRot[i] = norm((f.pageRot[i] || 0) - 90); render(area); } }),
          h('button', { type: 'button', title: 'Rotate right', html: ICONS.rotR, onclick: (e) => { e.stopPropagation(); f.pageRot[i] = norm((f.pageRot[i] || 0) + 90); render(area); } })));
        t.addEventListener('click', () => { f.pageRot[i] = norm((f.pageRot[i] || 0) + 90); render(area); });
        grid.append(t);
      }
      area.append(grid);
      return;
    }
    const list = h('div', { class: 'files' });
    ctx.state.files.forEach((f) => list.append(fileCard(f, { rotatable: true, onRotate: () => render(area),
      extraActions: [h('button', { type: 'button', title: 'Rotate left', html: ICONS.rotL, onclick: () => { f.rotation = norm((f.rotation || 0) - 90); render(area); } })] })));
    area.append(list);
  }

  const rotateAll = (delta) => {
    for (const f of ctx.state.files) f.rotation = norm((f.rotation || 0) + delta);
    ctx.refresh();
  };

  return {
    render,
    sidebar(body) {
      body.append(h('div', { class: 'info-box' }, 'Click a page (or the rotate icon on a file) to turn it 90°. The buttons below rotate everything at once.'),
        h('div', { class: 'opt' }, h('label', { class: 'lbl' }, 'Rotation'),
          h('div', { class: 'row' },
            h('button', { type: 'button', class: 'btn', style: 'justify-content:center', html: `${ICONS.rotR} Right`, onclick: () => rotateAll(90) }),
            h('button', { type: 'button', class: 'btn', style: 'justify-content:center', html: `${ICONS.rotL} Left`, onclick: () => rotateAll(-90) }))),
        h('div', { class: 'opt' }, h('button', { type: 'button', class: 'btn small', html: `${ICONS.reset} Reset all`,
          onclick: () => { for (const f of ctx.state.files) { f.rotation = 0; f.pageRot = {}; } ctx.refresh(); } })));
    },
    validate() {
      const any = ctx.ready().some((f) => norm(f.rotation || 0) || Object.values(f.pageRot || {}).some((v) => norm(v)));
      return any ? null : 'Rotate at least one file or page first.';
    },
    payload() {
      return {
        files: ctx.ready().map((f) => ({ id: f.id, options: { rotation: norm(f.rotation || 0),
          pages: Object.fromEntries(Object.entries(f.pageRot || {}).filter(([, v]) => norm(v))) } })),
        options: {},
      };
    },
  };
}
