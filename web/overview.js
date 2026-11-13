// "Show location": the start view in a full-screen modal dialog with a white
// (HDR where supported) marker at the current centre. The dialog lives in the
// top layer outside the viewport element, so the current view, its pending
// render and navigation stay untouched. Any tap, click or key closes it.
import {createView} from './view.js';
import {createTileQueue} from './tile-queue.js';

const SURFACE_SIZE = 1024, TILE_BYTES = 256 * 64 * 4;
// Unique worker URLs: WebKit merges concurrent loads of one URL and the merged
// loads bypass the service worker, so they fail offline (see app.js).
let overviewWorkerSerial = 0;
const STYLE = `
dialog.mandelbrot-overview{position:fixed;inset:0;width:100%;height:100%;max-width:none;max-height:none;margin:0;padding:0;border:0;
  background:#000;overflow:hidden;cursor:pointer;touch-action:none;outline:none;color-scheme:dark;
  -webkit-user-select:none;user-select:none;-webkit-touch-callout:none;-webkit-tap-highlight-color:transparent}
dialog.mandelbrot-overview::backdrop{background:#000}
.mandelbrot-overview .mo-frame{position:absolute;inset:0;overflow:hidden}
.mandelbrot-overview canvas{position:absolute;display:block}
.mandelbrot-overview .mo-marker{position:absolute;left:0;top:0;width:0;height:0;pointer-events:none}
.mandelbrot-overview .mo-dot,.mandelbrot-overview .mo-ring{position:absolute;left:-6px;top:-6px;width:12px;height:12px;
  border-radius:50%;box-sizing:border-box}
.mandelbrot-overview .mo-dot{display:block;dynamic-range-limit:no-limit;
  box-shadow:0 0 0 1.5px rgba(0,0,0,.6),0 0 12px 3px rgba(255,255,255,.7)}
.mandelbrot-overview .mo-ring{border:2px solid #fff;opacity:0;animation:mo-pulse 1.8s ease-out infinite}
@keyframes mo-pulse{0%{transform:scale(1);opacity:.9}100%{transform:scale(4);opacity:0}}
@media (prefers-reduced-motion:reduce){.mandelbrot-overview .mo-ring{animation:none}}`;

function crc32(bytes) {
  let crc = ~0;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; ++bit) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return ~crc >>> 0;
}
// One 16-bit RGB pixel at the peak code value, tagged by cICP as BT.2020/PQ.
// HDR-capable browsers show it as bright as the display allows; a decoder that
// ignores cICP reads the same bytes as ordinary sRGB white.
export function hdrWhitePNG() {
  const chunk = (type, data) => {
    const out = new Uint8Array(12 + data.length), view = new DataView(out.buffer);
    view.setUint32(0, data.length);
    for (let i = 0; i < 4; ++i) out[4 + i] = type.charCodeAt(i);
    out.set(data, 8); view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
    return out;
  };
  const header = new Uint8Array(13), headerView = new DataView(header.buffer);
  headerView.setUint32(0, 1); headerView.setUint32(4, 1); header[8] = 16; header[9] = 2;
  const raw = [0, 255, 255, 255, 255, 255, 255];
  let a = 1, b = 0;
  for (const byte of raw) { a = (a + byte) % 65521; b = (b + a) % 65521; }
  // zlib stream with a single stored (uncompressed) deflate block.
  const zlib = new Uint8Array([0x78, 0x01, 0x01, raw.length, 0, ~raw.length & 255, 255, ...raw,
    b >>> 8, b & 255, a >>> 8, a & 255]);
  return new Blob([new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header),
    chunk('cICP', new Uint8Array([9, 16, 0, 1])), chunk('IDAT', zlib), chunk('IEND', new Uint8Array(0))], {type: 'image/png'});
}

// Position of a complex point in CSS pixels of the start view of this size.
export function overviewPoint(real, imag, size) {
  const base = createView().snapshot(size.cssWidth, size.cssHeight, size.width, size.height);
  const spacing = base.mantissa * 2 ** base.exponent * size.width / size.cssWidth;
  return {x: size.cssWidth / 2 + (real - base.centreReal) / spacing, y: size.cssHeight / 2 - (imag - base.centreImag) / spacing};
}

export function createOverview(api) {
  const documentRef = api.document || document, windowRef = api.window || window;
  let style, dialog, marker, dotURL, observer, size, job, cache, generation = 0, disposed = false;
  const slots = [];

  function build() {
    style = documentRef.createElement('style'); style.textContent = STYLE; documentRef.head.append(style);
    dialog = documentRef.createElement('dialog'); dialog.className = 'mandelbrot-overview';
    dialog.setAttribute('lang', api.language); dialog.setAttribute('aria-label', api.label);
    dialog.tabIndex = -1;
    marker = documentRef.createElement('div'); marker.className = 'mo-marker';
    const ring = documentRef.createElement('span'); ring.className = 'mo-ring';
    const dot = documentRef.createElement('img'); dot.className = 'mo-dot'; dot.alt = ''; dot.draggable = false;
    dotURL = URL.createObjectURL(hdrWhitePNG()); dot.src = dotURL;
    marker.append(ring, dot); dialog.append(marker); documentRef.body.append(dialog);
    dialog.addEventListener('click', close);
    dialog.addEventListener('contextmenu', event => event.preventDefault());
    dialog.addEventListener('keydown', event => {
      if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); close(); }
    });
    dialog.addEventListener('close', closed);
    // Neither the page nor the fractal behind it may zoom.
    for (const type of ['gesturestart', 'gesturechange', 'gestureend', 'touchmove', 'wheel'])
      dialog.addEventListener(type, event => event.preventDefault(), {passive: false});
    observer = new ResizeObserver(entries => {
      const entry = entries[0], box = entry.devicePixelContentBoxSize?.[0], dpr = windowRef.devicePixelRatio || 1;
      const cssWidth = entry.contentRect.width, cssHeight = entry.contentRect.height;
      if (!cssWidth || !cssHeight) return;
      show({cssWidth, cssHeight, width: box?.inlineSize || Math.round(cssWidth * dpr),
        height: box?.blockSize || Math.round(cssHeight * dpr)});
    });
  }

  function open() {
    if (disposed || dialog?.open) return;
    if (!dialog) build();
    dialog.showModal(); dialog.focus();
    // The dialog covers exactly the viewport element; its observed device
    // pixels avoid a second render once the dialog's own box is observed.
    const rect = dialog.getBoundingClientRect(), dpr = windowRef.devicePixelRatio || 1, known = api.size?.();
    show(known?.cssWidth === rect.width && known?.cssHeight === rect.height ? known
      : {cssWidth: rect.width, cssHeight: rect.height, width: Math.round(rect.width * dpr), height: Math.round(rect.height * dpr)});
    try { observer.observe(dialog, {box: 'device-pixel-content-box'}); } catch { observer.observe(dialog); }
  }
  function close() { if (dialog?.open) dialog.close(); }
  function closed() {
    observer.disconnect();
    // An unfinished start view is not worth computing in the background.
    if (job && job !== cache) discard(job);
    job = null; size = null; stopWorkers();
  }

  function show(next) {
    if (!next.cssWidth || !next.cssHeight || !next.width || !next.height) return;
    size = next; place();
    const same = frame => frame && frame.size.width === next.width && frame.size.height === next.height &&
      frame.size.cssWidth === next.cssWidth && frame.size.cssHeight === next.cssHeight;
    if (same(job)) return;
    if (job && job !== cache) discard(job);
    if (same(cache)) { job = cache; attach(cache); return; }
    render(next);
  }
  function place() {
    const {real, imag} = api.centre();
    let {x, y} = overviewPoint(real, imag, size);
    // A centre panned outside the start view is pinned to its nearest edge.
    x = Math.min(size.cssWidth - 8, Math.max(8, Number.isFinite(x) ? x : size.cssWidth / 2));
    y = Math.min(size.cssHeight - 8, Math.max(8, Number.isFinite(y) ? y : size.cssHeight / 2));
    marker.style.transform = `translate(${x}px,${y}px)`;
  }
  function attach(frame) {
    for (const child of [...dialog.children]) if (child !== marker && child !== frame.element) child.remove();
    if (frame.element.parentNode !== dialog) dialog.insertBefore(frame.element, marker);
  }
  function discard(frame) {
    frame.element.remove();
    for (const {context} of frame.surfaces.values()) context.canvas.width = 0;
    frame.surfaces.clear();
  }

  function render(next) {
    const view = createView().snapshot(next.cssWidth, next.cssHeight, next.width, next.height);
    const queue = createTileQueue(next.width, next.height, view, {adaptive: false});
    const element = documentRef.createElement('div'); element.className = 'mo-frame';
    const surfaces = new Map();
    for (let y = 0; y < next.height; y += SURFACE_SIZE) for (let x = 0; x < next.width; x += SURFACE_SIZE) {
      const width = Math.min(SURFACE_SIZE, next.width - x), height = Math.min(SURFACE_SIZE, next.height - y);
      const canvas = documentRef.createElement('canvas'); canvas.width = width; canvas.height = height;
      canvas.setAttribute('aria-hidden', 'true');
      Object.assign(canvas.style, {left: `${100 * x / next.width}%`, top: `${100 * y / next.height}%`,
        width: `${100 * width / next.width}%`, height: `${100 * height / next.height}%`});
      const context = canvas.getContext('2d', {alpha: false});
      if (!context) { canvas.width = 0; discard({element, surfaces}); return; }
      surfaces.set(`${x / SURFACE_SIZE},${y / SURFACE_SIZE}`, {context}); element.append(canvas);
    }
    job = {generation: ++generation, size: next, view, queue, element, surfaces, completed: 0,
      mirror: new Uint8ClampedArray(TILE_BYTES)};
    attach(job);
    if (cache) { discard(cache); cache = null; }
    startWorkers();
    for (const slot of slots) dispatch(slot);
  }

  function startWorkers() {
    while (slots.length < Math.max(1, api.workers || 1)) {
      const worker = new Worker(new URL(`./engine-worker.js?overview=${++overviewWorkerSerial}`, import.meta.url), {type: 'module'});
      const slot = {worker, ready: false, busy: false, task: null, configured: -1, buffer: new ArrayBuffer(TILE_BYTES)};
      worker.onmessage = ({data}) => received(slot, data);
      worker.onerror = event => failed(new Error(event.message || 'Overview worker failed'));
      worker.postMessage({type: 'init', module: api.module, engineOptions: api.engineOptions});
      slots.push(slot);
    }
  }
  function stopWorkers() {
    for (const slot of slots) slot.worker.terminate();
    slots.length = 0;
  }
  function failed(error) {
    console.error('Mandelbrot overview:', error);
    stopWorkers();
  }
  function dispatch(slot) {
    if (disposed || !slot.ready || slot.busy || !job || job === cache) return;
    const tile = job.queue.take();
    if (!tile) return;
    if (slot.configured !== job.generation) {
      slot.worker.postMessage({type: 'configure', generation: job.generation, view: job.view,
        frameWidth: job.size.width, frameHeight: job.size.height});
      slot.configured = job.generation;
    }
    slot.busy = true; slot.task = {...tile, generation: job.generation};
    const buffer = slot.buffer; slot.buffer = null;
    slot.worker.postMessage({type: 'render', generation: job.generation, x: tile.x, y: tile.y,
      width: tile.width, height: tile.height, buffer}, buffer ? [buffer] : []);
  }
  function received(slot, data) {
    if (disposed || !slots.includes(slot)) return;
    if (data.type === 'ready') { slot.ready = true; dispatch(slot); return; }
    if (data.type === 'error') { failed(new Error(data.message)); return; }
    if (data.type !== 'tile') return;
    const task = slot.task;
    slot.busy = false; slot.task = null;
    if (job && job !== cache && data.generation === job.generation) {
      const pixels = new Uint8ClampedArray(data.buffer, 0, data.width * data.height * 4);
      draw(job, data.x, data.y, data.width, data.height, pixels);
      if (task.mirrorY !== null) {
        const stride = data.width * 4, reflected = job.mirror.subarray(0, pixels.length);
        for (let row = 0; row < data.height; ++row)
          reflected.set(pixels.subarray(row * stride, (row + 1) * stride), (data.height - 1 - row) * stride);
        draw(job, data.x, task.mirrorY, data.width, data.height, reflected);
      }
      if (++job.completed === job.queue.total) { cache = job; stopWorkers(); return; }
    }
    slot.buffer = data.buffer;
    dispatch(slot);
  }
  function draw(frame, x, y, width, height, pixels) {
    for (let row = 0; row < height;) {
      const targetY = y + row, rows = Math.min(height - row, SURFACE_SIZE - targetY % SURFACE_SIZE);
      const surface = frame.surfaces.get(`${Math.floor(x / SURFACE_SIZE)},${Math.floor(targetY / SURFACE_SIZE)}`);
      surface.context.putImageData(new ImageData(pixels.subarray(row * width * 4, (row + rows) * width * 4), width, rows),
        x % SURFACE_SIZE, targetY % SURFACE_SIZE);
      row += rows;
    }
  }

  return {
    open, close, isOpen: () => !!dialog?.open,
    dispose() {
      if (disposed) return;
      close(); disposed = true; stopWorkers(); observer?.disconnect();
      if (job && job !== cache) discard(job);
      if (cache) discard(cache);
      job = cache = null;
      if (dotURL) URL.revokeObjectURL(dotURL);
      dialog?.remove(); style?.remove(); dialog = style = null;
    }
  };
}
