// HTML to PDF: enter website URLs (or add .html files).
import { ICONS } from '../icons.js';
import { renderOptions } from '../options.js';
import { fileCard, filesBar } from '../tool.js';
import { esc, h, toast } from '../ui.js';

export function create(ctx) {
  const urls = [];

  function normalize(u) {
    u = u.trim();
    if (!u) return null;
    if (!/^[a-z]+:\/\//i.test(u)) u = `https://${u}`;
    try { return new URL(u).href; } catch (e) { return null; }
  }

  function urlForm(onAdd, label = 'Add') {
    const input = h('input', { type: 'url', placeholder: 'https://example.com/page', 'aria-label': 'Web address' });
    const add = () => {
      const u = normalize(input.value);
      if (!u) { toast('That doesn’t look like a web address.', 'error'); return; }
      onAdd(u);
      input.value = '';
    };
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') add(); });
    return h('div', { class: 'url-form' }, input, h('button', { type: 'button', class: 'btn primary', onclick: add }, label));
  }

  const self = {
    hero(zone) {
      zone.append(h('h3', {}, 'Paste a web address'),
        h('p', {}, 'Any page you can open in a browser – or a local .html file.'),
        urlForm((u) => { urls.push(u); ctx.showWork(); }, 'Add page'),
        h('p', { class: 'drop-hint', style: 'margin:16px 0 0' }, 'or ',
          h('button', { type: 'button', class: 'link-btn', onclick: () => ctx.openPicker() }, 'upload an HTML file')));
    },
    get keepWork() { return urls.length > 0; },
    onClear() { urls.length = 0; },
    canRun() { return urls.length > 0 || ctx.ready().length > 0; },
    summary() {
      const n = urls.length + ctx.ready().length;
      return n ? `<b>${n} page${n > 1 ? 's' : ''}</b> to convert` : 'No pages yet';
    },
    render(area) {
      area.innerHTML = '';
      area.append(filesBar({ label: self.summary() }));
      area.append(h('div', { style: 'max-width:640px;margin-bottom:20px' }, urlForm((u) => { urls.push(u); ctx.refresh(); }, 'Add page')));
      const list = h('div', { class: 'files' });
      urls.forEach((u, i) => {
        const host = (() => { try { return new URL(u).host; } catch (e) { return u; } })();
        list.append(h('div', { class: 'file-card' },
          h('div', { class: 'thumb' }, h('div', { class: 'placeholder', style: { background: ctx.tool.color, fontSize: '15px' } }, 'WEB')),
          h('div', { class: 'actions' }, h('button', { type: 'button', title: 'Remove', 'aria-label': `Remove ${host}`, html: ICONS.trash,
            onclick: () => { urls.splice(i, 1); if (self.canRun()) ctx.refresh(); else ctx.showEmpty(); } })),
          h('div', { class: 'name', title: u }, host),
          h('div', { class: 'meta', html: esc(u.replace(/^https?:\/\/[^/]+/, '') || '/') })));
      });
      ctx.state.files.forEach((f) => list.append(fileCard(f)));
      area.append(list);
    },
    sidebar(body) {
      renderOptions(body, ctx.tool.options, ctx.state.options, ctx.caps, () => {});
    },
    validate() { return self.canRun() ? null : 'Add a web address first.'; },
    payload() {
      return { files: ctx.ready().map((f) => ({ id: f.id })), options: { ...ctx.state.options, urls } };
    },
  };
  return self;
}
