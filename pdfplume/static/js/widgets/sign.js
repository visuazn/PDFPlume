// Sign PDF: create a signature (type, draw or upload) and place it on pages.
import { ICONS } from '../icons.js';
import { esc, h, modal, toast } from '../ui.js';
import { EditorCore } from './editor-core.js';
import { imageToDataUrl } from './editor.js';

const SIG_FONTS = ['Great Vibes', 'Dancing Script', 'Sacramento', 'Caveat'];
const INK = ['#1a1a1a', '#1d4ed8', '#c62828', '#1b7f3b'];

function trimCanvas(c) {
  const ctx = c.getContext('2d');
  const { data, width, height } = ctx.getImageData(0, 0, c.width, c.height);
  let x0 = width; let y0 = height; let x1 = -1; let y1 = -1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (data[(y * width + x) * 4 + 3] > 8) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
    }
  }
  if (x1 < 0) return null;
  const pad = 6;
  x0 = Math.max(0, x0 - pad); y0 = Math.max(0, y0 - pad); x1 = Math.min(width - 1, x1 + pad); y1 = Math.min(height - 1, y1 + pad);
  const out = document.createElement('canvas');
  out.width = x1 - x0 + 1; out.height = y1 - y0 + 1;
  out.getContext('2d').drawImage(c, x0, y0, out.width, out.height, 0, 0, out.width, out.height);
  return out;
}

async function typedSignature(text, font, color) {
  await document.fonts.load(`96px "${font}"`).catch(() => {});
  const c = document.createElement('canvas');
  const g = c.getContext('2d');
  g.font = `96px "${font}"`;
  c.width = Math.ceil(g.measureText(text).width + 60);
  c.height = 190;
  g.font = `96px "${font}"`;
  g.fillStyle = color;
  g.textBaseline = 'middle';
  g.fillText(text, 30, 95);
  return trimCanvas(c);
}

/** Show the signature dialog; resolves to {src, w, h} or null. */
export function signatureDialog({ title = 'Create your signature', name = '' } = {}) {
  return new Promise((resolve) => {
    let tab = 'type';
    let color = INK[0];
    let font = SIG_FONTS[0];
    let text = name;
    let upload = null;
    let drawn = false;
    const body = h('div');
    const pad = h('canvas', { class: 'sig-pad', width: 700, height: 220 });
    const pg = pad.getContext('2d');
    let drawing = false;
    let last = null;
    const pos = (e) => { const r = pad.getBoundingClientRect(); return [(e.clientX - r.left) * (pad.width / r.width), (e.clientY - r.top) * (pad.height / r.height)]; };
    pad.addEventListener('pointerdown', (e) => { drawing = true; last = pos(e); pad.setPointerCapture(e.pointerId); });
    pad.addEventListener('pointermove', (e) => {
      if (!drawing) return;
      const p = pos(e);
      pg.strokeStyle = color; pg.lineWidth = 4.5; pg.lineCap = 'round'; pg.lineJoin = 'round';
      pg.beginPath(); pg.moveTo(...last); pg.lineTo(...p); pg.stroke();
      last = p; drawn = true;
    });
    pad.addEventListener('pointerup', () => { drawing = false; });

    const render = () => {
      body.innerHTML = '';
      const tabs = h('div', { class: 'tabs', style: 'margin:-20px -22px 18px' });
      for (const [v, l, ic] of [['type', 'Type', ICONS.text], ['draw', 'Draw', ICONS.pen], ['upload', 'Upload', ICONS.upload]]) {
        tabs.append(h('button', { type: 'button', class: tab === v ? 'active' : '', onclick: () => { tab = v; render(); }, html: `${ic}<span>${l}</span>` }));
      }
      body.append(tabs);
      const swatches = h('div', { class: 'swatches' }, ...INK.map((c) => h('button', { type: 'button', class: c === color ? 'active' : '', style: { background: c }, title: c,
        onclick: () => {
          if (tab === 'draw' && drawn) {
            // Recolour the existing drawing.
            const img = pg.getImageData(0, 0, pad.width, pad.height);
            const [r, g, b] = [1, 3, 5].map((i) => parseInt(c.slice(i, i + 2), 16));
            for (let i = 0; i < img.data.length; i += 4) if (img.data[i + 3]) { img.data[i] = r; img.data[i + 1] = g; img.data[i + 2] = b; }
            pg.putImageData(img, 0, 0);
          }
          color = c; render();
        } })));
      if (tab === 'type') {
        const input = h('input', { type: 'text', value: text, placeholder: 'Your name', style: 'width:100%;padding:12px;border:1px solid var(--border);border-radius:8px;font-size:16px;margin-bottom:14px',
          oninput: (e) => { text = e.target.value; list.querySelectorAll('button').forEach((b) => { b.textContent = text || 'Your name'; }); } });
        const list = h('div', { class: 'sig-styles' }, ...SIG_FONTS.map((f) => h('button', { type: 'button', class: f === font ? 'active' : '',
          style: { fontFamily: `"${f}", cursive`, color }, onclick: () => { font = f; render(); } }, text || 'Your name')));
        body.append(input, list, h('div', { style: 'margin-top:14px;display:flex;gap:12px;align-items:center' }, h('span', { class: 'muted' }, 'Color'), swatches));
        setTimeout(() => input.focus(), 20);
      } else if (tab === 'draw') {
        body.append(pad, h('div', { style: 'margin-top:12px;display:flex;gap:12px;align-items:center' }, h('span', { class: 'muted' }, 'Color'), swatches,
          h('span', { style: 'flex:1' }), h('button', { type: 'button', class: 'btn small', onclick: () => { pg.clearRect(0, 0, pad.width, pad.height); drawn = false; } }, 'Clear')));
      } else {
        const input = h('input', { type: 'file', accept: 'image/*', class: 'hidden', onchange: async (e) => {
          const f = e.target.files[0];
          if (f) { upload = await imageToDataUrl(f, 1200); render(); }
        } });
        body.append(input, h('div', { style: 'border:2px dashed var(--border);border-radius:12px;min-height:180px;display:grid;place-items:center;padding:16px;text-align:center' },
          upload ? h('img', { src: upload.src, style: 'max-height:170px' }) : h('div', {}, h('p', { class: 'muted' }, 'Upload a picture of your signature (PNG with transparent background works best).'),
            h('button', { type: 'button', class: 'btn primary', onclick: () => input.click() }, 'Choose image'))));
      }
    };
    render();
    let done = false;
    const finish = (v) => { if (done) return; done = true; m.close(); resolve(v); };
    const apply = async () => {
      let canvas = null;
      if (tab === 'type') {
        if (!text.trim()) { toast('Type your name first.', 'error'); return; }
        canvas = await typedSignature(text.trim(), font, color);
      } else if (tab === 'draw') {
        canvas = drawn ? trimCanvas(pad) : null;
        if (!canvas) { toast('Draw your signature first.', 'error'); return; }
      } else {
        if (!upload) { toast('Choose an image first.', 'error'); return; }
        finish({ ...upload, name: text });
        return;
      }
      finish({ src: canvas.toDataURL('image/png'), w: canvas.width, h: canvas.height, name: text });
    };
    const m = modal({ title, body, wide: true, onClose: () => finish(null),
      foot: [h('button', { type: 'button', class: 'btn', onclick: () => finish(null) }, 'Cancel'), h('button', { type: 'button', class: 'btn primary', onclick: apply }, 'Apply')] });
  });
}

// ------------------------------------------------------- certificates
function certDialog(name) {
  return new Promise((resolve) => {
    const f = { name: h('input', { type: 'text', value: name || '', placeholder: 'Name shown as the signer' }),
      email: h('input', { type: 'email', placeholder: 'name@example.com (optional)' }),
      org: h('input', { type: 'text', placeholder: 'Company (optional)' }),
      pw: h('input', { type: 'password', placeholder: 'At least 4 characters', autocomplete: 'new-password' }),
      pw2: h('input', { type: 'password', placeholder: 'Repeat the password', autocomplete: 'new-password' }) };
    const msg = h('p', { class: 'form-error' });
    const row = (label, input) => h('div', { class: 'opt', style: 'margin-bottom:12px' }, h('label', { class: 'lbl' }, label), input);
    const create = async () => {
      if (f.pw.value !== f.pw2.value) { msg.textContent = 'The passwords don’t match.'; return; }
      try {
        const info = await fetch('/api/certificates', { method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: f.name.value, email: f.email.value, organization: f.org.value, password: f.pw.value }) })
          .then(async (r) => { const d = await r.json(); if (!r.ok) throw new Error(d.error); return d; });
        resolve({ info, password: f.pw.value }); // before close(), whose onClose resolves null
        m.close();
      } catch (e) { msg.textContent = e.message; }
    };
    const m = modal({ title: 'Create a signing certificate', onClose: () => resolve(null),
      body: h('div', {}, h('p', { class: 'muted', style: 'margin:0 0 14px;font-size:13px;line-height:1.5' },
        'Your certificate is made and kept on this computer. The password protects it – you need it every time you sign.'),
      row('Name', f.name), row('Email', f.email), row('Organization', f.org), row('Password', f.pw), row('Confirm password', f.pw2), msg),
      foot: [h('button', { type: 'button', class: 'btn', onclick: () => m.close() }, 'Cancel'), h('button', { type: 'button', class: 'btn primary', id: 'cert-create', onclick: create }, 'Create certificate')] });
    setTimeout(() => f.name.focus(), 30);
  });
}

function importDialog() {
  return new Promise((resolve) => {
    const file = h('input', { type: 'file', accept: '.p12,.pfx,application/x-pkcs12' });
    const pw = h('input', { type: 'password', placeholder: 'Certificate password', autocomplete: 'off' });
    const msg = h('p', { class: 'form-error' });
    const go = async () => {
      if (!file.files[0]) { msg.textContent = 'Choose a .p12 or .pfx file.'; return; }
      const form = new FormData();
      form.append('file', file.files[0]);
      form.append('password', pw.value);
      try {
        const info = await fetch('/api/certificates/import', { method: 'POST', body: form })
          .then(async (r) => { const d = await r.json(); if (!r.ok) throw new Error(d.error); return d; });
        resolve({ info, password: pw.value });
        m.close();
      } catch (e) { msg.textContent = e.message; }
    };
    const m = modal({ title: 'Import a certificate', onClose: () => resolve(null),
      body: h('div', {}, h('p', { class: 'muted', style: 'margin:0 0 14px;font-size:13px;line-height:1.5' },
        'Use a certificate from your organization or a certificate authority (.p12 or .pfx with its private key). It is copied to this computer only.'),
      h('div', { class: 'opt', style: 'margin-bottom:12px' }, file), h('div', { class: 'opt', style: 'margin-bottom:12px' }, pw), msg),
      foot: [h('button', { type: 'button', class: 'btn', onclick: () => m.close() }, 'Cancel'), h('button', { type: 'button', class: 'btn primary', onclick: go }, 'Import')] });
  });
}

export function create(ctx) {
  const st = { name: '', signature: null, initials: null, stamp: null,
    digital: false, certs: null, certId: '', password: '', reason: '', location: '', existing: null };
  let sideBody = null;
  const core = new EditorCore(ctx, {
    tools: {},
    onSelect: () => {},
    onDropField: (type, p, page) => place(type, page, p),
  });

  const today = () => new Date().toLocaleDateString(undefined, { year: 'numeric', month: '2-digit', day: '2-digit' });

  async function ensure(type) {
    if (type === 'signature' || type === 'initials') {
      if (!st[type]) {
        const initials = st.name.split(/\s+/).filter(Boolean).map((w) => w[0].toUpperCase()).join('');
        const res = await signatureDialog({ title: type === 'signature' ? 'Create your signature' : 'Create your initials', name: type === 'initials' ? initials : st.name });
        if (!res) return false;
        st[type] = res;
        if (type === 'signature' && res.name) st.name = res.name;
        renderSide();
      }
    }
    if (type === 'stamp' && !st.stamp) {
      const input = h('input', { type: 'file', accept: 'image/*' });
      const file = await new Promise((r) => { input.onchange = () => r(input.files[0]); input.click(); });
      if (!file) return false;
      st.stamp = await imageToDataUrl(file, 1200);
      renderSide();
    }
    return true;
  }

  async function place(type, page = core.currentPage(), at = null) {
    if (!(await ensure(type))) return;
    const info = core.pageInfo[page];
    if (!at) {
      // Stagger clicked fields so they don't land on top of each other.
      const c = core.visibleCenter(page);
      const n = core.elements.filter((e) => e.page === page).length % 6;
      at = { x: c.x, y: Math.min(0.92, c.y + n * 0.05) };
    }
    if (['signature', 'initials', 'stamp'].includes(type)) {
      const img = st[type];
      const fw = type === 'signature' ? 0.28 : type === 'initials' ? 0.12 : 0.2;
      const fh = fw * (img.h / img.w) * (info.w / info.h);
      const x = at.x - fw / 2;
      const y = at.y - fh / 2;
      core.add({ type: 'image', page, x: Math.max(0, Math.min(1 - fw, x)), y: Math.max(0, Math.min(1 - fh, y)), w: fw, h: fh, src: img.src, keepRatio: true });
    } else {
      const text = type === 'date' ? today() : type === 'name' ? (st.name || 'Your name') : 'Text';
      core.add({ type: 'text', page, x: Math.max(0, at.x - 0.08), y: at.y, text, font: 'helvetica', size: 12, color: '#000000' }, { edit: type === 'text' });
    }
  }

  function fieldRow(type, label, icon, preview) {
    const row = h('div', { class: 'sign-field', draggable: 'true', title: 'Click to add to the current page, or drag onto a page',
      onclick: () => place(type) },
    h('span', { class: 'sf-ic', html: icon }),
    h('div', { class: 'sf-preview' }, preview ? h('img', { src: preview, alt: '' }) : h('span', { class: 'sf-label' }, label)));
    if (type === 'signature' || type === 'initials' || type === 'stamp') {
      row.append(h('button', { type: 'button', class: 'sf-edit', title: 'Change', html: ICONS.edit, onclick: async (e) => {
        e.stopPropagation();
        st[type] = null;
        await ensure(type);
      } }));
    }
    row.addEventListener('dragstart', (e) => { e.dataTransfer.setData('application/x-pdfplume-field', type); e.dataTransfer.effectAllowed = 'copy'; });
    return row;
  }

  function renderSide() {
    if (!sideBody) return;
    sideBody.innerHTML = '';
    sideBody.append(h('div', { class: 'opt' }, h('label', { class: 'lbl' }, 'Full name'),
      h('input', { type: 'text', value: st.name, placeholder: 'Your full name', oninput: (e) => { st.name = e.target.value; } })));
    sideBody.append(h('div', { class: 'opt-title' }, 'Signature fields'),
      h('div', { class: 'sign-fields' },
        fieldRow('signature', 'Signature', ICONS.sign, st.signature && st.signature.src),
        fieldRow('initials', 'Initials', ICONS.initials, st.initials && st.initials.src),
        fieldRow('name', 'Name', ICONS.user),
        fieldRow('date', 'Date', ICONS.calendar),
        fieldRow('text', 'Text', ICONS.text),
        fieldRow('stamp', 'Company stamp', ICONS.stamp, st.stamp && st.stamp.src)),
      h('div', { class: 'info-box', style: 'margin-top:18px' }, 'Click a field to place it on the current page or drag it onto any page. Drag to move, use the round handle to resize, press Delete to remove.'));
    sideBody.append(digitalSection());
  }

  async function loadCerts() {
    try { st.certs = (await ctx.api.get('/api/certificates')).certificates; } catch (e) { st.certs = []; }
    if (!st.certs.some((c) => c.id === st.certId)) st.certId = st.certs[0] ? st.certs[0].id : '';
  }

  async function loadExisting() {
    const f = ctx.ready()[0];
    if (!f || st.existing?.fileId === f.id) return;
    try { st.existing = { fileId: f.id, list: (await ctx.api.get(`/api/files/${f.id}/signatures`)).signatures }; } catch (e) { st.existing = { fileId: f.id, list: [] }; }
    renderSide();
  }

  function digitalSection() {
    const box = h('div', { class: 'digital' });
    const ex = st.existing && st.existing.list;
    if (ex && ex.length) {
      const ok = ex.every((x) => x.intact);
      box.append(h('div', { class: ok ? 'info-box' : 'warn-box', html: `${ok ? ICONS.shield : ICONS.alert} <span>This PDF already has ${ex.length} digital signature${ex.length > 1 ? 's' : ''}${ok ? ' – intact' : ' – one is broken'}: ${ex.map((x) => esc(x.signer.replace(/^.*Common Name: /, ''))).join(', ')}. PDFPlume adds your changes as an update, so they stay valid.</span>` }));
    }
    const toggle = h('input', { type: 'checkbox', id: 'digital-toggle', checked: st.digital, onchange: async (e) => {
      st.digital = e.target.checked;
      if (st.digital && !st.certs) await loadCerts();
      renderSide();
      ctx.refresh();
    } });
    box.append(h('div', { class: 'opt-title', style: 'margin-top:22px' }, 'Digital signature'),
      h('div', { class: 'opt' }, h('label', { class: 'check-row' }, toggle, h('span', {}, 'Also sign with a certificate',
        h('span', { class: 'help', style: 'display:block' }, 'Proves who signed and that nothing changed afterwards. PDF viewers show it in their signature panel.')))));
    if (!st.digital) return box;
    if (!st.certs) { box.append(h('p', { class: 'muted' }, 'Loading certificates…')); return box; }
    const addBtns = h('div', { class: 'row', style: 'gap:8px;margin-top:8px' },
      h('button', { type: 'button', class: 'btn sm', id: 'cert-new', html: `${ICONS.plus} New certificate`, onclick: async () => {
        const res = await certDialog(st.name);
        if (res) { await loadCerts(); st.certId = res.info.id; st.password = res.password; renderSide(); toast('Certificate created'); }
      } }),
      h('button', { type: 'button', class: 'btn sm', html: `${ICONS.upload} Import .p12`, onclick: async () => {
        const res = await importDialog();
        if (res) { await loadCerts(); st.certId = res.info.id; st.password = res.password; renderSide(); toast('Certificate imported'); }
      } }));
    if (!st.certs.length) {
      box.append(h('div', { class: 'opt' }, h('p', { class: 'muted', style: 'font-size:13px;margin:10px 0 0' }, 'You don’t have a certificate yet.'), addBtns));
      return box;
    }
    const sel = h('select', { id: 'cert-select', onchange: (e) => { st.certId = e.target.value; st.password = ''; renderSide(); } },
      ...st.certs.map((c) => h('option', { value: c.id, selected: c.id === st.certId }, `${c.name}${c.email ? ` <${c.email}>` : ''}${c.self_signed ? ' · self-made' : ''}`)));
    const cur = st.certs.find((c) => c.id === st.certId);
    const input = (key, attrs) => {
      const el = h('input', { ...attrs, oninput: (e) => { st[key] = e.target.value; } });
      el.value = st[key];
      return el;
    };
    box.append(h('div', { class: 'opt' }, h('label', { class: 'lbl' }, 'Certificate'), sel, addBtns),
      h('div', { class: 'opt' }, h('label', { class: 'lbl' }, 'Certificate password'), input('password', { type: 'password', id: 'cert-password', autocomplete: 'off' })),
      h('div', { class: 'opt' }, h('label', { class: 'lbl' }, 'Reason (optional)'), input('reason', { type: 'text', placeholder: 'I approve this document' })),
      h('div', { class: 'opt' }, h('label', { class: 'lbl' }, 'Location (optional)'), input('location', { type: 'text', placeholder: 'City' })));
    if (cur) {
      box.append(h('div', { class: cur.self_signed ? 'warn-box' : 'info-box' },
        cur.self_signed ? 'Self-made certificate: viewers will say the signer’s identity isn’t verified until they trust it. Send recipients your certificate file so they can.'
          : `Issued by ${cur.issuer}.`,
        h('div', { class: 'row', style: 'gap:12px;margin-top:8px' },
          h('a', { class: 'link-btn', href: `/api/certificates/${cur.id}/download`, download: '' }, 'Download certificate'),
          h('button', { type: 'button', class: 'link-btn', onclick: async () => {
            if (!confirm(`Delete the certificate “${cur.name}” from this computer? Files you already signed stay signed.`)) return;
            await ctx.api.del(`/api/certificates/${cur.id}`).catch(() => {});
            await loadCerts();
            renderSide();
          } }, 'Delete'))));
    }
    return box;
  }

  let asked = false;
  return {
    flush: true,
    async render(area) {
      const f = ctx.ready()[0];
      if (!f) { area.innerHTML = '<p class="grid-hint" style="padding:40px">Uploading…</p>'; return; }
      if (area.querySelector('.editor-shell') && core.file && core.file.id === f.id) return;
      await core.load(f);
      area.innerHTML = '';
      const bar = h('div', { class: 'editor-bar' },
        h('span', { style: 'font-weight:700;padding:0 8px' }, esc(f.name)), h('span', { style: 'flex:1' }),
        h('button', { type: 'button', class: 'tool-btn', onclick: () => core.undo(), html: `${ICONS.undo}<span>Undo</span>` }),
        h('button', { type: 'button', class: 'tool-btn', onclick: () => core.setZoom(core.zoom / 1.2), html: `${ICONS.zoomOut}<span>Zoom</span>` }),
        h('button', { type: 'button', class: 'tool-btn', onclick: () => core.setZoom(core.zoom * 1.2), html: `${ICONS.zoomIn}<span>Zoom</span>` }));
      const scroll = h('div', { class: 'editor-scroll' });
      area.append(h('div', { class: 'editor-shell' }, bar, scroll));
      core.mount(scroll);
      loadExisting();
      if (!asked && !st.signature) { asked = true; setTimeout(() => ensure('signature'), 300); }
    },
    sidebar(body) { sideBody = body; renderSide(); },
    onFiles() { core.file = null; st.existing = null; },
    validate() {
      if (st.digital) {
        if (!st.certId) return 'Create or import a certificate first.';
        if (!st.password) return 'Enter the certificate password.';
        return null;
      }
      return core.elements.length ? null : 'Place your signature on the document first.';
    },
    payload() {
      core.stopEditing();
      const options = { elements: core.payload(), signer_name: st.name };
      if (st.digital) options.digital = { cert_id: st.certId, password: st.password, reason: st.reason, location: st.location };
      return { files: [{ id: ctx.ready()[0].id }], options };
    },
  };
}
