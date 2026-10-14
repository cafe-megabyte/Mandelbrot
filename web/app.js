import {createResizeScheduler} from './resize-scheduler.js';
import {createImageExport} from './image-export.js';

const TILE_WIDTH = 256, TILE_HEIGHT = 64, SURFACE_SIZE = 1024;

export async function start(root) {
  let disposed = false, pending, frameRequest = 0;
  let physicalSize, replacementCount = 0, fullscreenPending = false;
  const slots = [];
  const simdBytes = await loadBytes('engine-simd.wasm');
  const backend = WebAssembly.validate(simdBytes) ? 'simd128' : 'scalar';
  const module = await WebAssembly.compile(backend === 'simd128' ? simdBytes : await loadBytes('engine-scalar.wasm'));
  if (WebAssembly.Module.imports(module).length) throw new Error('Unexpected WASM imports');
  const workerCount = Math.max(1, Math.min(8, (navigator.hardwareConcurrency || 2) - 1));
  const imageExport = createImageExport(root, frame => !disposed && pending === frame &&
    frame.completed === frame.total && frame.shown && root.dataset.resizeMode === 'idle');
  const scheduler = createResizeScheduler({
    start: (size, job) => { try { render(size, job); } catch (error) { fail(error); } },
    cancel: cancelRender,
    reuse: frame => {
      if (pending?.id !== frame.id || pending.completed !== pending.total || !pending.shown) return false;
      pending.kind = 'final'; root.dataset.phase = 'final'; imageExport.prepare(pending); return true;
    },
    state: detail => {
      root.dataset.resizeMode = detail.mode;
      if (detail.mode !== 'idle') imageExport.cancel();
      root.dispatchEvent(new CustomEvent('mandelbrot-resize', {bubbles: true, detail}));
    }
  });

  function newSlot() {
    return new Promise((resolve, reject) => {
      const worker = new Worker(new URL('./engine-worker.js', import.meta.url), {type: 'module'});
      const slot = {worker, busy: false, job: null, ready: false};
      slots.push(slot);
      const timer = setTimeout(() => { worker.terminate(); reject(new Error('Worker startup timed out')); }, 15000);
      slot.timer = timer;
      worker.onmessage = ({data}) => {
        if (data.type === 'ready') {
          clearTimeout(timer); slot.ready = true; resolve(slot); dispatch(slot); return;
        }
        if (data.type === 'error') {
          if (!slot.ready) { clearTimeout(timer); reject(new Error(data.message)); }
          else lostSlot(slot, new Error(data.message));
          return;
        }
        if (data.type !== 'tile') return;
        slot.busy = false; slot.job = null;
        if (!disposed && pending && data.generation === pending.id && scheduler.accept(data.generation)) {
          const surface = pending.surfaces.get(`${Math.floor(data.x / SURFACE_SIZE)},${Math.floor(data.y / SURFACE_SIZE)}`);
          const pixels = new Uint8ClampedArray(data.buffer, 0, data.width * data.height * 4);
          surface.context.putImageData(new ImageData(pixels, data.width, data.height),
            data.x % SURFACE_SIZE, data.y % SURFACE_SIZE);
          ++pending.completed;
          if (pending.completed === pending.total) finish();
        }
        dispatch(slot, data.buffer);
      };
      worker.onerror = event => {
        const error = new Error(event.message || 'Render worker failed');
        if (!slot.ready) { clearTimeout(timer); reject(error); }
        else lostSlot(slot, error);
      };
      worker.onmessageerror = () => lostSlot(slot, new Error('Worker message could not be decoded'));
      worker.postMessage({type: 'init', module});
    });
  }

  function lostSlot(slot, error) {
    if (disposed || !slots.includes(slot)) return;
    console.error('Mandelbrot worker:', error);
    if (slot.job && pending && slot.job.generation === pending.id) pending.retry.push(slot.job);
    slot.worker.terminate(); slots.splice(slots.indexOf(slot), 1);
    if (++replacementCount <= 2) newSlot().catch(fail);
    else fail(error);
  }

  function dispatch(slot, buffer) {
    if (buffer) slot.buffer = buffer;
    if (disposed || !pending || slot.busy || !slot.ready || pending.completed === pending.total) return;
    if (!scheduler.accept(pending.id)) return;
    let job = pending.retry.pop();
    if (!job) {
      if (pending.next === pending.total) return;
      const index = pending.next++, cols = Math.ceil(pending.width / TILE_WIDTH);
      const x = (index % cols) * TILE_WIDTH, y = Math.floor(index / cols) * TILE_HEIGHT;
      job = {type: 'render', generation: pending.id, frameWidth: pending.width, frameHeight: pending.height,
        x, y, width: Math.min(TILE_WIDTH, pending.width - x), height: Math.min(TILE_HEIGHT, pending.height - y)};
    }
    slot.busy = true; slot.job = job;
    const transfer = slot.buffer; slot.buffer = null;
    slot.worker.postMessage({...job, buffer: transfer}, transfer ? [transfer] : []);
  }

  function reveal(frame) {
    if (disposed || pending !== frame || frame.shown) return;
    frame.shown = true; frame.layer.style.visibility = 'visible';
    for (const child of [...root.children]) if (child !== frame.layer) child.remove();
    root.dataset.exportState = 'pending';
  }

  function finish() {
    const frame = pending;
    if (!scheduler.complete(frame.id)) return;
    clearTimeout(frame.revealTimer); reveal(frame);
    root.dataset.state = 'complete';
    root.dispatchEvent(new CustomEvent('mandelbrot-frame', {bubbles: true, detail: {
      width: frame.width, height: frame.height, milliseconds: performance.now() - frame.started,
      backend, workers: slots.length, phase: frame.kind
    }}));
    if (frame.kind === 'final') imageExport.prepare(frame);
  }

  function fail(error) {
    console.error('Mandelbrot renderer:', error);
    dispose();
    root.dataset.state = 'failed';
  }

  function cancelRender(id) {
    if (pending?.id !== id) return;
    clearTimeout(pending.revealTimer);
    if (!pending.shown) pending.layer.remove();
    pending = null;
  }

  function render(size, job) {
    if (disposed || !size.width || !size.height) return;
    imageExport.cancel();
    if (pending) {
      clearTimeout(pending.revealTimer);
      if (!pending.shown) pending.layer.remove();
    }
    const layer = document.createElement('div'); layer.className = 'frame';
    layer.style.visibility = 'hidden';
    const surfaces = new Map();
    for (let y = 0; y < size.height; y += SURFACE_SIZE) {
      for (let x = 0; x < size.width; x += SURFACE_SIZE) {
        const width = Math.min(SURFACE_SIZE, size.width - x), height = Math.min(SURFACE_SIZE, size.height - y);
        const canvas = document.createElement('canvas'); canvas.width = width; canvas.height = height;
        canvas.setAttribute('aria-hidden', 'true');
        // Percentage geometry lets the previous image follow the viewport
        // smoothly while a new full-resolution calculation is deferred.
        Object.assign(canvas.style, {left: `${100 * x / size.width}%`, top: `${100 * y / size.height}%`,
          width: `${100 * width / size.width}%`, height: `${100 * height / size.height}%`});
        const context = canvas.getContext('2d', {alpha: false});
        if (!context) { layer.remove(); fail(new Error('Canvas allocation failed')); return; }
        surfaces.set(`${x / SURFACE_SIZE},${y / SURFACE_SIZE}`, {context}); layer.append(canvas);
      }
    }
    root.append(layer);
    pending = {...size, id: job.id, kind: job.kind, layer, surfaces, next: 0, completed: 0, retry: [], shown: false,
      total: Math.ceil(size.width / TILE_WIDTH) * Math.ceil(size.height / TILE_HEIGHT), started: job.started};
    root.dataset.state = 'rendering';
    root.dataset.phase = job.kind;
    const frame = pending;
    if (job.kind === 'final') frame.revealTimer = setTimeout(() => reveal(frame), 500);
    for (const slot of slots) dispatch(slot);
  }

  function resize() {
    if (disposed || frameRequest) return;
    frameRequest = requestAnimationFrame(() => {
      frameRequest = 0;
      const rect = root.getBoundingClientRect(), dpr = devicePixelRatio || 1;
      const exact = physicalSize && physicalSize.dpr === dpr && physicalSize.cssWidth === rect.width &&
        physicalSize.cssHeight === rect.height ? physicalSize : null;
      try {
        scheduler.update({width: exact ? exact.width : Math.round(rect.width * dpr),
          height: exact ? exact.height : Math.round(rect.height * dpr), cssWidth: rect.width, cssHeight: rect.height});
      } catch (error) { fail(error); }
    });
  }

  const observer = new ResizeObserver(entries => {
    const entry = entries[0], box = entry.devicePixelContentBoxSize?.[0];
    if (box) physicalSize = {width: box.inlineSize, height: box.blockSize, dpr: devicePixelRatio || 1,
      cssWidth: entry.contentRect.width, cssHeight: entry.contentRect.height};
    resize();
  });
  let densityQuery;
  function densityChanged() {
    densityQuery?.removeEventListener('change', densityChanged);
    physicalSize = null;
    densityQuery = matchMedia(`(resolution: ${devicePixelRatio || 1}dppx)`);
    densityQuery.addEventListener('change', densityChanged); resize();
  }
  function resume() { if (!document.hidden) { physicalSize = null; resize(); } }
  function enterFullscreen(event) {
    if (disposed || event.button !== 0 || !event.target.closest('canvas, img.export-image') ||
        document.fullscreenElement || fullscreenPending || !document.fullscreenEnabled || !root.requestFullscreen) return;
    fullscreenPending = true;
    // Keep the stable viewport element fullscreen while tiles/PNGs are replaced.
    // Request directly in the click handler to retain user activation.
    try {
      root.requestFullscreen({navigationUI: 'hide'})
        .then(fullscreenChanged)
        .catch(error => console.debug('Mandelbrot fullscreen:', error.message))
        .finally(() => { fullscreenPending = false; });
    } catch (error) { fullscreenPending = false; console.debug('Mandelbrot fullscreen:', error.message); }
  }
  function fullscreenChanged() {
    if (disposed) return;
    physicalSize = null; scheduler.invalidate(); resize();
  }
  function dispose() {
    if (disposed) return;
    disposed = true; observer.disconnect(); cancelAnimationFrame(frameRequest);
    scheduler.dispose();
    imageExport.dispose();
    clearTimeout(pending?.revealTimer);
    if (pending && !pending.shown) pending.layer.remove();
    densityQuery?.removeEventListener('change', densityChanged);
    window.removeEventListener('resize', resize); document.removeEventListener('visibilitychange', resume);
    root.removeEventListener('click', enterFullscreen); document.removeEventListener('fullscreenchange', fullscreenChanged);
    for (const slot of slots) { clearTimeout(slot.timer); slot.worker.terminate(); }
  }

  try { await Promise.all(Array.from({length: workerCount}, () => newSlot())); }
  catch (error) { dispose(); throw error; }
  try { observer.observe(root, {box: 'device-pixel-content-box'}); }
  catch { observer.observe(root); }
  window.addEventListener('resize', resize); document.addEventListener('visibilitychange', resume);
  root.addEventListener('click', enterFullscreen); document.addEventListener('fullscreenchange', fullscreenChanged);
  densityChanged();
  return {dispose, backend};
}

async function loadBytes(name) {
  const response = await fetch(new URL(name, import.meta.url));
  if (!response.ok) throw new Error(`Missing ${name}`);
  return response.arrayBuffer();
}
