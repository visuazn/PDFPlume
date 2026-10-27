// Declarative sidebar options (see the `options` arrays in tools.js).
import { api } from './api.js';
import { ICONS } from './icons.js';
import { POS9 } from './tools.js';
import { esc, h, toast } from './ui.js';

const TESS_NAMES = {
  eng: 'English', fra: 'French', deu: 'German', spa: 'Spanish', ita: 'Italian', por: 'Portuguese',
  nld: 'Dutch', rus: 'Russian', ukr: 'Ukrainian', pol: 'Polish', ces: 'Czech', swe: 'Swedish',
  dan: 'Danish', fin: 'Finnish', nor: 'Norwegian', ell: 'Greek', tur: 'Turkish', ara: 'Arabic',
  heb: 'Hebrew', fas: 'Persian', hin: 'Hindi', ben: 'Bengali', urd: 'Urdu', chi_sim: 'Chinese (Simplified)',
  chi_tra: 'Chinese (Traditional)', jpn: 'Japanese', kor: 'Korean', ind: 'Indonesian', msa: 'Malay',
  vie: 'Vietnamese', tha: 'Thai', ron: 'Romanian', hun: 'Hungarian', bul: 'Bulgarian', slk: 'Slovak',
  cat: 'Catalan', tam: 'Tamil', tel: 'Telugu', hrv: 'Croatian', srp: 'Serbian', slv: 'Slovenian',
  lit: 'Lithuanian', lav: 'Latvian', est: 'Estonian', afr: 'Afrikaans', glg: 'Galician', eus: 'Basque',
};

const add = (parent, ...parts) => parent.append(...parts.filter(Boolean));

export function defaultsFor(schema = []) {
  const out = {};
  const walk = (items) => items.forEach((o) => {
    if (o.items) walk(o.items);
    if (o.type === 'textstyle') Object.assign(out, o.defaults);
    else if (o.key && o.default !== undefined) out[o.key] = o.default;
    if (o.mosaicKey) out[o.mosaicKey] = false;
  });
  walk(schema);
  return out;
}

function missing(need, caps) {
  if (!need) return null;
  if (need === 'tesseract' && !caps.tesseract) return 'Requires Tesseract OCR (not installed)';
  if (need === 'translation' && !(caps.translation && caps.translation.available)) return 'Requires a translation engine';
  return null;
}

/**
 * Render ``schema`` into ``root``. ``values`` is mutated in place and
 * ``onChange(key)`` is called after every change.
 */
export function renderOptions(root, schema, values, caps, onChange, hooks = {}) {
  root.innerHTML = '';
  const rerender = () => renderOptions(root, schema, values, caps, onChange, hooks);
  const set = (key, v, re = false) => { values[key] = v; onChange(key); if (re) rerender(); };

  const build = (o) => {
    if (o.when && !o.when(values)) return null;
    const wrap = h('div', { class: 'opt' });
    const label = o.label ? h('label', { class: 'lbl' }, o.label) : null;
    switch (o.type) {
      case 'note':
        return h('div', { class: 'info-box', html: o.html });
      case 'sortButtons':
        add(wrap, h('div', { class: 'row' },
          h('button', { type: 'button', class: 'btn', onclick: () => hooks.sortFiles && hooks.sortFiles(1), html: `${ICONS.sort} A → Z` }),
          h('button', { type: 'button', class: 'btn', onclick: () => hooks.sortFiles && hooks.sortFiles(-1), html: `${ICONS.sort} Z → A` })));
        return wrap;
      case 'cards': {
        if (o.needsOllama && !(caps.translation && caps.translation.ollama)) return null;
        const box = h('div', { class: `cards${o.grid ? ' grid2' : ''}` });
        for (const c of o.choices) {
          const why = missing(c.needs, caps);
          const b = h('button', { type: 'button', class: `opt-card${o.center ? ' center' : ''}${values[o.key] === c.value ? ' active' : ''}`, disabled: !!why,
            onclick: () => set(o.key, c.value, true) },
          o.center ? null : h('span', { class: 'radio' }),
          h('span', {}, h('span', { class: 't' }, c.title), c.desc ? h('span', { class: 'd' }, why || c.desc) : (why ? h('span', { class: 'd' }, why) : null)));
          if (why) b.style.opacity = '.55';
          box.append(b);
        }
        add(wrap, label, box);
        return wrap;
      }
      case 'tabs': {
        const box = h('div', { class: 'tabs' });
        for (const c of o.choices) {
          box.append(h('button', { type: 'button', class: values[o.key] === c.value ? 'active' : '', onclick: () => set(o.key, c.value, true),
            html: `${ICONS[c.icon] || ''}<span>${esc(c.label)}</span>` }));
        }
        return box;
      }
      case 'seg': {
        const box = h('div', { class: 'seg' });
        for (const c of o.choices) {
          box.append(h('button', { type: 'button', class: values[o.key] === c.value ? 'active' : '', onclick: () => set(o.key, c.value, true) }, c.label));
        }
        add(wrap, label, box);
        return wrap;
      }
      case 'select': {
        const sel = h('select', { onchange: (e) => set(o.key, o.number ? Number(e.target.value) : e.target.value, true) });
        for (const c of o.choices) sel.append(h('option', { value: c.value, selected: String(values[o.key]) === String(c.value) }, c.label));
        add(wrap, label, sel);
        return wrap;
      }
      case 'checkbox': {
        const why = missing(o.needs, caps);
        const input = h('input', { type: 'checkbox', checked: !!values[o.key] && !why, disabled: !!why, onchange: (e) => set(o.key, e.target.checked) });
        add(wrap, h('label', { class: 'check-row' }, input, h('span', {}, o.label, why ? h('span', { class: 'muted', style: 'display:block;font-size:12.5px' }, why) : null,
          o.help && !why ? h('span', { class: 'help', style: 'display:block' }, o.help) : null)));
        return wrap;
      }
      case 'number':
      case 'text':
      case 'password': {
        const input = h('input', { type: o.type, value: values[o.key] ?? '', placeholder: o.placeholder || '', min: o.min, max: o.max, step: o.step,
          autocomplete: o.type === 'password' ? 'new-password' : 'off',
          oninput: (e) => set(o.key, o.type === 'number' ? Number(e.target.value) : e.target.value) });
        add(wrap, label, input);
        if (o.help) add(wrap, h('div', { class: 'help' }, o.help));
        return wrap;
      }
      case 'textarea': {
        const input = h('textarea', { rows: 2, oninput: (e) => set(o.key, e.target.value) });
        input.value = values[o.key] ?? '';
        add(wrap, label, input);
        return wrap;
      }
      case 'range': {
        const out = h('span', { class: 'muted' }, `${values[o.key]}%`);
        const input = h('input', { type: 'range', min: o.min, max: o.max, value: values[o.key], style: 'width:100%;accent-color:var(--accent)',
          oninput: (e) => { out.textContent = `${e.target.value}%`; set(o.key, Number(e.target.value)); } });
        add(wrap, h('label', { class: 'lbl' }, o.label, ' ', out), input);
        return wrap;
      }
      case 'position': {
        const grid = h('div', { class: 'pos-grid' });
        const mosaic = o.mosaicKey && values[o.mosaicKey];
        for (const p of POS9) {
          const off = (o.disable || []).includes(p);
          grid.append(h('button', { type: 'button', title: p.replace('-', ' '), disabled: off,
            class: !mosaic && values[o.key] === p ? 'active' : '', onclick: () => { if (o.mosaicKey) values[o.mosaicKey] = false; set(o.key, p, true); } }));
        }
        const row = h('div', { class: 'pos-wrap' }, grid);
        if (o.mosaicKey) {
          row.append(h('label', { class: 'check-row' }, h('input', { type: 'checkbox', checked: !!mosaic,
            onchange: (e) => set(o.mosaicKey, e.target.checked, true) }), h('span', {}, 'Mosaic (repeat over the page)')));
        }
        add(wrap, label, row);
        return wrap;
      }
      case 'textstyle': {
        const k = o.keys;
        const font = h('select', { onchange: (e) => set(k.font, e.target.value) },
          ...[['helvetica', 'Arial / Helvetica'], ['times', 'Times New Roman'], ['courier', 'Courier']].map(([v, l]) =>
            h('option', { value: v, selected: values[k.font] === v }, l)));
        const size = h('input', { type: 'number', min: 4, max: 400, value: values[k.size], style: 'width:76px;flex:none', oninput: (e) => set(k.size, Number(e.target.value)) });
        const toggles = h('div', { class: 'toggle-group' });
        const tog = (key, text, style) => {
          if (!key) return;
          toggles.append(h('button', { type: 'button', class: values[key] ? 'active' : '', style, title: key,
            onclick: (e) => { set(key, !values[key]); e.currentTarget.classList.toggle('active', !!values[key]); } }, text));
        };
        tog(k.bold, 'B', 'font-weight:800');
        tog(k.italic, 'I', 'font-style:italic;font-family:serif');
        if (o.underline) tog(k.underline, 'U', 'text-decoration:underline');
        const color = h('input', { type: 'color', value: values[k.color], oninput: (e) => set(k.color, e.target.value) });
        add(wrap, label, h('div', { class: 'row', style: 'margin-bottom:10px' }, font, size),
          h('div', { class: 'row', style: 'justify-content:space-between' }, toggles, h('span', { style: 'flex:none' }, color)));
        return wrap;
      }
      case 'image': {
        const preview = h('div', { class: 'preview' });
        if (values[o.key]) preview.append(h('img', { src: api.thumb(values[o.key], 0, 160) }));
        const input = h('input', { type: 'file', accept: 'image/*', class: 'hidden', onchange: async (e) => {
          const f = e.target.files[0];
          if (!f) return;
          try {
            const meta = await api.upload(f);
            values[o.key] = meta.id;
            set(o.key, meta.id, true);
          } catch (err) { toast(err.message, 'error'); }
        } });
        add(wrap, label, h('div', { class: 'image-pick' }, preview,
          h('button', { type: 'button', class: 'btn', onclick: () => input.click(), html: `${ICONS.upload} ${values[o.key] ? 'Change image' : 'Add image'}` }), input));
        return wrap;
      }
      case 'row': {
        const row = h('div', { class: 'row', style: 'align-items:flex-start' });
        for (const item of o.items) { const el = build(item); if (el) { el.style.marginBottom = '0'; row.append(el); } }
        add(wrap, row);
        return wrap;
      }
      case 'details': {
        const d = h('details', {}, h('summary', { style: 'cursor:pointer;font-weight:700;font-size:14px;margin-bottom:12px' }, o.label));
        for (const item of o.items) { const el = build(item); if (el) d.append(el); }
        add(wrap, d);
        return wrap;
      }
      case 'language':
        return buildLanguage(o, wrap, label);
      default:
        return null;
    }
  };

  function buildLanguage(o, wrap, label) {
    if (o.source === 'translate') {
      const tr = caps.translation || {};
      if (!tr.available) {
        if (o.key === 'source') {
          return h('div', { class: 'warn-box', html: `<b>No translation engine found.</b><br>Install one and restart PDFPlume:<br>
          • Offline: <code>pip install argostranslate</code> then download a language pair (see README)<br>
          • Or run LibreTranslate locally and set <code>LIBRETRANSLATE_URL</code><br>
          • Or run Ollama and set <code>OLLAMA_URL</code>` });
        }
        return null;
      }
      const sel = h('select', { onchange: (e) => set(o.key, e.target.value) });
      if (o.auto) sel.append(h('option', { value: 'auto', selected: values[o.key] === 'auto' }, 'Detect language'));
      for (const l of tr.languages || []) sel.append(h('option', { value: l.code, selected: values[o.key] === l.code }, l.name));
      if (!o.auto && !(tr.languages || []).some((l) => l.code === values[o.key]) && tr.languages && tr.languages.length) {
        values[o.key] = tr.languages[0].code;
      }
      add(wrap, label, sel);
      return wrap;
    }
    // Tesseract languages, multiple selection with chips.
    if (!caps.tesseract) {
      return h('div', { class: 'warn-box', html: `<b>Tesseract OCR is not installed.</b> Install it to recognize text:<br>
        Windows: <code>winget install UB-Mannheim.TesseractOCR</code><br>macOS: <code>brew install tesseract tesseract-lang</code><br>
        Linux: <code>sudo apt install tesseract-ocr</code>` });
    }
    const langs = caps.tesseract_languages || ['eng'];
    const current = String(values[o.key] || 'eng').split('+').filter((l) => langs.includes(l));
    if (!current.length) current.push(langs.includes('eng') ? 'eng' : langs[0]);
    values[o.key] = current.join('+');
    const chips = h('div', { class: 'chip-list' });
    for (const l of current) {
      chips.append(h('span', { class: 'chip' }, TESS_NAMES[l] || l,
        current.length > 1 ? h('button', { type: 'button', 'aria-label': 'remove', onclick: () => set(o.key, current.filter((x) => x !== l).join('+'), true) }, '×') : null));
    }
    const sel = h('select', { onchange: (e) => { if (e.target.value) set(o.key, [...current, e.target.value].join('+'), true); } },
      h('option', { value: '' }, '+ Add another language…'),
      ...langs.filter((l) => !current.includes(l)).map((l) => h('option', { value: l }, TESS_NAMES[l] || l)));
    add(wrap, label, chips, langs.length > current.length ? h('div', { style: 'margin-top:10px' }, sel) : null);
    return wrap;
  }

  for (const o of schema) {
    const el = build(o);
    if (el) root.append(el);
  }
}
