// One tap/click menu: save, copy URL, full screen and exact coordinate entry.
// The dialog lives outside the viewport element, so navigation never sees its
// pointer, wheel or keyboard events. It is built lazily on first use.

const COPY = {
  en: {
    menu: 'Mandelbrot menu', save: 'Save image', preparing: 'Preparing PNG…', calculating: 'Calculating…',
    copy: 'Copy URL', copied: 'Copied', copyFailed: "Couldn't copy", fullscreen: 'Full screen',
    exitFullscreen: 'Exit full screen', coordinates: 'Enter coordinates', close: 'Close', percent: '%',
    x: 'Centre x', y: 'Centre y', zoom: 'Zoom (power of 2)', paste: 'Paste a URL or image metadata',
    pastePlaceholder: 'https://…#x=…&y=…&zoom=… or {"center_x": …}', found: 'Found:', nothing: 'No coordinates found',
    show: 'Show', back: 'Back', number: 'Enter a number', zoomRange: 'Enter a zoom of 0 or more',
    zoomLarge: 'This zoom is too large', invalid: "These coordinates can't be shown"
  },
  de: {
    menu: 'Mandelbrot-Menü', save: 'Bild speichern', preparing: 'PNG wird vorbereitet…', calculating: 'Wird berechnet…',
    copy: 'URL kopieren', copied: 'Kopiert', copyFailed: 'Kopieren fehlgeschlagen', fullscreen: 'Vollbild',
    exitFullscreen: 'Vollbild beenden', coordinates: 'Koordinaten eingeben', close: 'Schließen', percent: '\u00a0%',
    x: 'Mittelpunkt x', y: 'Mittelpunkt y', zoom: 'Zoom (Zweierpotenz)', paste: 'URL oder Bild-Metadaten einfügen',
    pastePlaceholder: 'https://…#x=…&y=…&zoom=… oder {"center_x": …}', found: 'Erkannt:', nothing: 'Keine Koordinaten gefunden',
    show: 'Anzeigen', back: 'Zurück', number: 'Zahl eingeben', zoomRange: 'Zoom ab 0 eingeben',
    zoomLarge: 'Dieser Zoom ist zu groß', invalid: 'Diese Koordinaten lassen sich nicht anzeigen'
  }
};

// Accepts comma or point as decimal separator, typographic minus signs, spaces
// and moderate exponents. Returns a plain decimal string or null; never a Number.
export function parseDecimal(text) {
  let value = String(text ?? '').replace(/[\s   '_]/g, '').replace(/[−‒–—]/g, '-');
  if ((value.match(/[.,]/g) || []).length > 1) return null;
  value = value.replace(',', '.');
  const match = /^([+-]?)(\d*)(?:\.(\d*))?(?:e([+-]?\d{1,5}))?$/i.exec(value);
  if (!match || !(match[2] || match[3])) return null;
  let [, sign, whole, fraction = '', exponent = '0'] = match;
  let shift = Number(exponent);
  if (Math.abs(shift) > 20000) return null;
  // Move the decimal point by the exponent on the digit string itself.
  let digits = whole + fraction, point = whole.length + shift;
  if (point < 0) { digits = '0'.repeat(-point) + digits; point = 0; }
  if (point > digits.length) digits += '0'.repeat(point - digits.length);
  whole = digits.slice(0, point).replace(/^0+(?=\d)/, '') || '0';
  fraction = digits.slice(point).replace(/0+$/, '');
  if (sign === '+' || (whole === '0' && !fraction)) sign = '';
  return sign + whole + (fraction ? '.' + fraction : '');
}

// Pulls x, y and zoom out of any pasted text: a full URL or fragment, the PNG's
// JSON (valid or not), XMP or tEXt dumps. Nothing is validated as a whole.
export function extractView(text) {
  let source = String(text ?? '');
  try { source = decodeURIComponent(source.replace(/\+/g, '%2B')); } catch {}
  const number = '([+\\-\\u2212]?(?:\\d+(?:[.,]\\d+)?|[.,]\\d+)(?:[eE][+\\-]?\\d+)?)';
  const field = keys => new RegExp(`(?:${keys})[\\\\"']*\\s*[:=>]\\s*[\\\\"']*\\s*${number}`, 'i');
  const result = {};
  // A bare key must not end another word ("max=", "index=").
  for (const [name, keys] of [['x', 'center_?x|(?:^|[^\\w.-])x'], ['y', 'center_?y|(?:^|[^\\w.-])y'],
    ['zoom', 'zoom_?exponent|(?:^|[^\\w.-])zoom']]) {
    const match = field(keys).exec(source);
    if (match) result[name] = match[1];
  }
  return result;
}

// Field values to a view target, or per-field error keys. `fromFragment` is the
// URL parser, so typed coordinates obey exactly the same limits as links.
export function viewInput({x, y, zoom}, fromFragment) {
  const errors = {}, real = parseDecimal(x), imag = parseDecimal(y), level = parseDecimal(zoom);
  if (real === null) errors.x = 'number';
  if (imag === null) errors.y = 'number';
  if (level === null) errors.zoom = 'number';
  else if (level.startsWith('-') && Number(level) !== 0) errors.zoom = 'zoomRange';
  else if (!(512 + 256 * Math.ceil(Number(level)) <= 0x7fffffbf)) errors.zoom = 'zoomLarge';
  if (Object.keys(errors).length) return {errors};
  // The typed digits are the shortest link that restores exactly this view.
  const fragment = `#x=${real}&y=${imag}&zoom=${level.replace(/^-/, '')}`, target = fromFragment(fragment);
  return target ? {target, fragment} : {errors: {form: 'invalid'}};
}

const ICONS = {
  save: 'M12 4v11m0 0l-4-4m4 4l4-4M5 19h14',
  copy: 'M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1',
  fullscreen: 'M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5',
  coordinates: 'M12 3v4M12 17v4M3 12h4M17 12h4M12 8a4 4 0 1 0 0 8a4 4 0 0 0 0-8z',
  close: 'M6 6l12 12M18 6L6 18'
};
const STYLE = `
dialog.mandelbrot-menu{padding:0;border:1px solid rgba(255,255,255,.18);border-radius:14px;background:#15171d;color:#f4f7ff;
  width:min(420px,calc(100vw - 32px));max-height:calc(var(--mandelbrot-vvh,100dvh) - 32px);overflow:auto;box-sizing:border-box;
  font:400 15px/1.4 system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;box-shadow:0 8px 40px rgba(0,0,0,.6);color-scheme:dark}
dialog.mandelbrot-menu::backdrop{background:rgba(0,0,0,.35)}
.mandelbrot-menu [hidden]{display:none!important}
.mandelbrot-menu .mm-actions{padding:6px 0}
.mandelbrot-menu .mm-item{display:flex;align-items:center;gap:14px;width:100%;min-height:48px;padding:10px 18px;border:0;background:none;
  color:inherit;font:inherit;text-align:left;cursor:pointer;box-sizing:border-box}
.mandelbrot-menu .mm-item:hover:not(:disabled){background:rgba(255,255,255,.07)}
.mandelbrot-menu .mm-item:disabled{cursor:default;color:rgba(244,247,255,.5)}
.mandelbrot-menu svg{flex:none;width:20px;height:20px;fill:none;stroke:currentColor;stroke-width:1.8;stroke-linecap:round;stroke-linejoin:round;opacity:.8}
.mandelbrot-menu .mm-hint{margin-left:auto;padding-left:12px;font-size:12px;color:rgba(244,247,255,.6);font-variant-numeric:tabular-nums;white-space:nowrap}
.mandelbrot-menu .mm-separator{height:1px;margin:6px 0;background:rgba(255,255,255,.1)}
.mandelbrot-menu form{padding:16px 18px 18px}
.mandelbrot-menu label{display:block;margin:12px 0 4px;font-size:13px;color:rgba(244,247,255,.75)}
.mandelbrot-menu label:first-child{margin-top:0}
.mandelbrot-menu textarea,.mandelbrot-menu input{display:block;width:100%;box-sizing:border-box;margin:0;padding:7px 9px;border-radius:8px;
  border:1px solid rgba(255,255,255,.2);background:#0b0c10;color:inherit;font:400 12px/1.4 ui-monospace,SFMono-Regular,Menlo,monospace;
  resize:none;overflow-wrap:anywhere;word-break:break-all}
.mandelbrot-menu input{font-size:14px}
.mandelbrot-menu [aria-invalid=true]{border-color:#ff8f8f}
.mandelbrot-menu .mm-note{min-height:1.2em;margin:4px 0 0;font-size:12px;color:rgba(244,247,255,.6)}
.mandelbrot-menu .mm-error{color:#ff9c9c}
.mandelbrot-menu .mm-buttons{display:flex;gap:10px;justify-content:flex-end;margin-top:16px}
.mandelbrot-menu .mm-buttons button{min-height:40px;padding:0 18px;border-radius:8px;border:1px solid rgba(255,255,255,.25);background:none;
  color:inherit;font:inherit;cursor:pointer}
.mandelbrot-menu .mm-buttons button[type=submit]{background:#b4ffff;border-color:#b4ffff;color:#05262a;font-weight:500}
.mandelbrot-menu :focus-visible{outline:2px solid #b4ffff;outline-offset:-2px}
@media (max-width:599px){
  dialog.mandelbrot-menu{width:100%;max-width:100%;margin:auto 0 0;border-radius:14px 14px 0 0;border-width:1px 0 0;
    padding-bottom:env(safe-area-inset-bottom)}
  dialog.mandelbrot-menu.mm-form-view{margin:0 0 auto;border-radius:0 0 14px 14px;border-width:0 0 1px;padding:env(safe-area-inset-top) 0 0;
    max-height:var(--mandelbrot-vvh,100dvh)}
}`;

export function createMenu(api) {
  const text = COPY[api.language] || COPY.en, documentRef = api.document || document;
  let style, dialog, actions, form, items = {}, fields = {}, notes = {}, timer = 0, closeTimer = 0, disposed = false;
  function icon(name) {
    const svg = documentRef.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 24 24'); svg.setAttribute('aria-hidden', 'true');
    const path = documentRef.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', ICONS[name]); svg.append(path); return svg;
  }
  function item(name, label, action) {
    const button = documentRef.createElement('button'); button.type = 'button'; button.className = 'mm-item';
    const caption = documentRef.createElement('span'); caption.textContent = label;
    const hint = documentRef.createElement('span'); hint.className = 'mm-hint';
    button.append(icon(name), caption, hint); button.addEventListener('click', action);
    actions.append(button); return items[name] = {button, caption, hint};
  }
  function field(name, multiline) {
    const id = `mandelbrot-menu-${name}`, label = documentRef.createElement('label');
    label.htmlFor = id; label.textContent = text[name];
    const control = documentRef.createElement(multiline ? 'textarea' : 'input');
    control.id = id; control.name = name; control.spellcheck = false;
    control.setAttribute('autocomplete', 'off'); control.setAttribute('autocorrect', 'off');
    control.setAttribute('autocapitalize', 'off');
    if (multiline) control.rows = name === 'paste' ? 3 : 2;
    else control.inputMode = 'decimal';
    const note = documentRef.createElement('p'); note.className = 'mm-note'; note.id = `${id}-note`;
    control.setAttribute('aria-describedby', note.id);
    control.addEventListener('input', () => { if (name !== 'paste') clearError(name); fit(control); });
    form.append(label, control, note); fields[name] = control; notes[name] = note; return control;
  }
  function fit(control) {
    if (control.tagName !== 'TEXTAREA') return;
    control.style.height = 'auto';
    control.style.height = `${Math.min(control.scrollHeight + 2, control.name === 'paste' ? 160 : 132)}px`;
  }
  function build() {
    style = documentRef.createElement('style'); style.textContent = STYLE; documentRef.head.append(style);
    dialog = documentRef.createElement('dialog'); dialog.className = 'mandelbrot-menu';
    dialog.setAttribute('lang', api.language); dialog.setAttribute('aria-label', text.menu);
    actions = documentRef.createElement('div'); actions.className = 'mm-actions';
    item('save', text.save, save);
    item('copy', text.copy, copyURL);
    item('fullscreen', text.fullscreen, () => { api.toggleFullscreen(); close(); });
    item('coordinates', text.coordinates, showForm);
    const separator = documentRef.createElement('div'); separator.className = 'mm-separator'; actions.append(separator);
    item('close', text.close, close);
    form = documentRef.createElement('form'); form.noValidate = true; form.hidden = true;
    field('x', true); field('y', true); field('zoom', false); field('paste', true);
    fields.paste.placeholder = text.pastePlaceholder;
    fields.paste.addEventListener('input', pasted);
    notes.form = documentRef.createElement('p'); notes.form.className = 'mm-note mm-error'; notes.form.setAttribute('role', 'alert');
    const buttons = documentRef.createElement('div'); buttons.className = 'mm-buttons';
    const back = documentRef.createElement('button'); back.type = 'button'; back.textContent = text.back;
    back.addEventListener('click', showActions);
    const submit = documentRef.createElement('button'); submit.type = 'submit'; submit.textContent = text.show;
    buttons.append(back, submit); form.append(notes.form, buttons);
    form.addEventListener('submit', event => { event.preventDefault(); apply(); });
    form.addEventListener('keydown', event => {
      // Coordinates contain no line breaks: Return always shows the view.
      if (event.key === 'Enter' && !event.shiftKey && !event.isComposing && /^(INPUT|TEXTAREA)$/.test(event.target.tagName)) {
        event.preventDefault(); apply();
      }
    });
    fields.zoom.addEventListener('input', zoomHint);
    dialog.append(actions, form); documentRef.body.append(dialog);
    // A click on the backdrop targets the dialog itself; its content never does.
    dialog.addEventListener('click', event => { if (event.target === dialog) close(); });
    dialog.addEventListener('close', closed);
    api.window?.visualViewport?.addEventListener('resize', viewport);
  }
  function viewport() {
    const height = api.window?.visualViewport?.height;
    if (dialog && height) dialog.style.setProperty('--mandelbrot-vvh', `${height}px`);
  }
  function update() {
    if (!dialog?.open) return;
    const status = api.exportStatus();
    items.save.button.hidden = status.disabled;
    items.save.button.disabled = !status.file;
    items.save.hint.textContent = status.file ? `PNG · ${status.width} × ${status.height}`
      : status.fraction < 1 ? `${text.calculating} ${Math.floor(100 * status.fraction)}${text.percent}` : text.preparing;
    items.fullscreen.button.hidden = !api.fullscreenAvailable();
    items.fullscreen.caption.textContent = api.fullscreenActive() ? text.exitFullscreen : text.fullscreen;
  }
  function open() {
    if (disposed || dialog?.open) return;
    if (!dialog) build();
    showActions(); items.copy.hint.textContent = ''; viewport();
    dialog.showModal(); update();
    api.window?.clearInterval?.(timer); timer = api.window?.setInterval?.(update, 250) || 0;
  }
  function close() { if (dialog?.open) dialog.close(); }
  function closed() {
    api.window?.clearInterval?.(timer); timer = 0; clearTimeout(closeTimer);
    dialog.classList.remove('mm-form-view');
  }
  function showActions() {
    dialog.classList.remove('mm-form-view'); form.hidden = true; actions.hidden = false; update();
  }
  function showForm() {
    const current = api.currentFields();
    fields.x.value = current.x; fields.y.value = current.y; fields.zoom.value = current.zoom; fields.paste.value = '';
    for (const name of ['x', 'y', 'zoom', 'form']) clearError(name);
    notes.paste.textContent = ''; zoomHint();
    dialog.classList.add('mm-form-view'); actions.hidden = true; form.hidden = false;
    for (const control of Object.values(fields)) fit(control);
    fields.x.focus(); fields.x.setSelectionRange?.(0, fields.x.value.length);
  }
  function zoomHint() {
    if (fields.zoom.getAttribute('aria-invalid') === 'true') return;
    const level = Number(parseDecimal(fields.zoom.value));
    notes.zoom.textContent = parseDecimal(fields.zoom.value) === null || level < 0 ? '' : `= ${magnification(level)}×`;
  }
  function magnification(level) {
    const locale = api.language === 'de' ? 'de-DE' : 'en-US';
    if (level <= 40) return new Intl.NumberFormat(locale, {maximumFractionDigits: level < 4 ? 2 : 0}).format(2 ** level);
    const decimal = level * Math.log10(2), power = Math.floor(decimal);
    const mantissa = new Intl.NumberFormat(locale, {maximumFractionDigits: 2}).format(10 ** (decimal - power));
    return `${mantissa} · 10^${new Intl.NumberFormat(locale).format(power)}`;
  }
  function pasted() {
    const found = extractView(fields.paste.value), names = [];
    for (const name of ['x', 'y', 'zoom']) if (found[name] !== undefined) {
      fields[name].value = found[name]; clearError(name); fit(fields[name]);
      names.push(name === 'zoom' ? text.zoom.split(' ')[0] : name);
    }
    zoomHint();
    notes.paste.classList.toggle('mm-error', !names.length && !!fields.paste.value.trim());
    notes.paste.textContent = names.length ? `${text.found} ${names.join(', ')}` : fields.paste.value.trim() ? text.nothing : '';
  }
  function clearError(name) {
    fields[name]?.removeAttribute('aria-invalid');
    if (notes[name]) { notes[name].textContent = ''; notes[name].classList.remove('mm-error'); }
    if (name === 'zoom') zoomHint();
    if (name !== 'form' && notes.form) notes.form.textContent = '';
  }
  function apply() {
    const {target, fragment, errors} = viewInput({x: fields.x.value, y: fields.y.value, zoom: fields.zoom.value}, api.fromFragment);
    if (errors) {
      for (const [name, key] of Object.entries(errors)) {
        fields[name]?.setAttribute('aria-invalid', 'true');
        notes[name].textContent = text[key]; notes[name].classList.add('mm-error');
      }
      const first = ['x', 'y', 'zoom'].find(name => errors[name]); if (first) fields[first].focus();
      return;
    }
    close(); api.setView(target, fragment);
  }
  async function save() {
    const {file} = api.exportStatus(); if (!file) return;
    const coarse = api.window?.matchMedia?.('(pointer: coarse)').matches;
    const nav = api.navigator;
    // Phones and tablets cannot download into their photo library; their share
    // sheet can. Desktop browsers keep an ordinary download.
    if (coarse && nav?.canShare?.({files: [file]})) {
      try { await nav.share({files: [file]}); close(); return; }
      catch (error) { if (error?.name === 'AbortError') return; }
    }
    const url = URL.createObjectURL(file), link = documentRef.createElement('a');
    link.href = url; link.download = file.name; link.hidden = true;
    documentRef.body.append(link); link.click(); link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
    close();
  }
  async function copyURL() {
    const href = api.location.href;
    let copied = false;
    try { await api.navigator.clipboard.writeText(href); copied = true; }
    catch {
      const area = documentRef.createElement('textarea'); area.value = href; area.setAttribute('readonly', '');
      dialog.append(area); area.select();
      try { copied = documentRef.execCommand('copy'); } catch {}
      area.remove(); items.copy.button.focus();
    }
    items.copy.hint.textContent = copied ? text.copied : text.copyFailed;
    if (copied) { clearTimeout(closeTimer); closeTimer = setTimeout(close, 900); }
  }
  return {
    open, close, isOpen: () => !!dialog?.open,
    dispose() {
      disposed = true; close(); api.window?.clearInterval?.(timer); clearTimeout(closeTimer);
      api.window?.visualViewport?.removeEventListener('resize', viewport);
      dialog?.remove(); style?.remove(); dialog = style = null;
    }
  };
}
