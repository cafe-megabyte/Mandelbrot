import {createResizeScheduler} from './resize-scheduler.js';
import {createImageExport} from './image-export.js';
import {createView, previewTransform} from './view.js';
import {createNavigation} from './navigation.js';

const TILE_WIDTH = 256, TILE_HEIGHT = 64, SURFACE_SIZE = 1024;

export async function start(root) {
  let disposed = false, pending, frameRequest = 0;
  let physicalSize, replacementCount = 0, fullscreenPending = false, referenceWorker;
  const view = createView(root._mandelbrotView);
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
  const navigation = createNavigation(root, view, active => { scheduler.hold(active); resize(); });

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
          pending.skipped = (pending.skipped || 0) + (data.skipped || 0);
          pending.fallbacks = (pending.fallbacks || 0) + (data.fallbacks || 0);
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
        view: pending.view,
        x, y, width: Math.min(TILE_WIDTH, pending.width - x), height: Math.min(TILE_HEIGHT, pending.height - y)};
    }
    if (pending.view.perturb && !pending.reference) { pending.retry.push(job); return; }
    if (pending.view.perturb && slot.referenceGeneration !== pending.id) {
      slot.worker.postMessage({type: 'reference', generation: pending.id, bits: pending.reference.bits,
        view: pending.view, buffer: pending.reference.buffer});
      slot.referenceGeneration = pending.id;
    }
    slot.busy = true; slot.job = job;
    if (pending.view.deep) slot.memoryIterations = Math.max(slot.memoryIterations || 0,pending.view.iterations);
    const transfer = slot.buffer; slot.buffer = null;
    slot.worker.postMessage({...job, buffer: transfer}, transfer ? [transfer] : []);
  }

  function reveal(frame) {
    if (disposed || pending !== frame || frame.shown) return;
    frame.shown = true; frame.layer.style.visibility = 'visible';
    frame.layer.style.transform = previewTransform(frame.view, currentView(), root.clientWidth, root.clientHeight);
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
      backend, workers: slots.length, phase: frame.kind,
      zoom: frame.view.zoom, iterations: frame.view.iterations, deep: frame.view.deep,
      algorithm: frame.view.perturb ? 'perturbation/BLA' : frame.view.deep ? 'tile perturbation/BLA + double-double' : backend,
      referenceMilliseconds: frame.reference?.milliseconds || 0,
      skippedIterations: frame.skipped || 0, preciseFallbacks: frame.fallbacks || 0
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
    referenceWorker?.terminate(); referenceWorker = null;
    if (!disposed && pending.view.deep) for (const slot of [...slots]) if (slot.job?.generation === id) {
      slot.worker.terminate(); slots.splice(slots.indexOf(slot),1); newSlot().catch(fail);
    }
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
    layer._view = size.view;
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
    root.dataset.zoom = String(size.view.zoom);
    root.dataset.iterations = String(size.view.iterations);
    root.dataset.deep = String(size.view.deep);
    for (const slot of [...slots]) if (slot.memoryIterations &&
        (!size.view.deep || size.view.iterations*2 < slot.memoryIterations)) {
      slot.worker.terminate(); slots.splice(slots.indexOf(slot),1); newSlot().catch(fail);
    }
    const frame = pending;
    // During navigation retain the complete transformed picture until the new
    // view is complete. Initial/window resize retain the existing presentation.
    if (job.kind === 'final' && !size.view.revision) frame.revealTimer = setTimeout(() => reveal(frame), 500);
    if (size.view.perturb) {
      referenceWorker?.terminate();
      const worker = new Worker(new URL('./reference-worker.js', import.meta.url), {type:'module'});
      referenceWorker = worker;
      worker.onmessage = ({data}) => {
        if (disposed || pending !== frame || data.generation !== frame.id) return;
        if (data.type === 'error') { fail(new Error(data.message)); return; }
        frame.reference = data; worker.terminate(); if (referenceWorker === worker) referenceWorker = null;
        for (const slot of slots) dispatch(slot);
      };
      worker.onerror = event => fail(new Error(event.message || 'Reference worker failed'));
      worker.postMessage({type:'init',module});
      worker.postMessage({type:'prepare',generation:frame.id,view:frame.view,width:frame.width,height:frame.height});
    }
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
        const width = exact ? exact.width : Math.round(rect.width*dpr);
        if (!rect.width || !rect.height || !width) {
          scheduler.update({width:0,height:0,cssWidth:rect.width,cssHeight:rect.height}); return;
        }
        const height=exact ? exact.height : Math.round(rect.height*dpr);
        const target = view.snapshot(rect.width,rect.height,width,height);
        root._mandelbrotView=target;
        for (const child of root.children) if (child.style.visibility !== 'hidden' && child._view)
          child.style.transform = previewTransform(child._view,target,rect.width,rect.height);
        scheduler.update({width: exact ? exact.width : Math.round(rect.width * dpr),
          height: exact ? exact.height : Math.round(rect.height * dpr), cssWidth: rect.width, cssHeight: rect.height, view: target});
      } catch (error) { fail(error); }
    });
  }
  function currentView() { const r=root.getBoundingClientRect();return view.snapshot(r.width,r.height,Math.round(r.width*(devicePixelRatio||1))); }

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
    const pictureTarget = event.target.closest('canvas, img.export-image') ||
      (event.target === root && root.querySelector('canvas, img.export-image'));
    if (disposed || navigation.suppressClick() || event.button !== 0 || !pictureTarget ||
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
    navigation.dispose(); referenceWorker?.terminate();
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
  return {dispose, backend, setView: target => { view.set(target); scheduler.hold(true); resize();
    requestAnimationFrame(() => scheduler.hold(false)); }, getView: currentView, reset: () => { view.reset(); resize(); }};
}

async function loadBytes(name) {
  const response = await fetch(new URL(name, import.meta.url));
  if (!response.ok) throw new Error(`Missing ${name}`);
  return response.arrayBuffer();
}
