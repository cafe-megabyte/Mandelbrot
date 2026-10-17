import {createResizeScheduler} from './resize-scheduler.js';
import {createImageExport} from './image-export.js';
import {createView, previewTransform, viewFragment, viewFromFragment} from './view.js';
import {createNavigation} from './navigation.js';
import {createTileQueue} from './tile-queue.js';
import {createPresentation} from './presentation.js';
import {createPreviewRenderer} from './preview.js';

const TILE_WIDTH = 256, TILE_HEIGHT = 64, SURFACE_SIZE = 1024;
// Keep the scheduling fallback aligned with the verified core default.
// Explicit engineOptions allow independent optimization experiments.
const DEFAULT_ENGINE_OPTIONS = 3851;

function usePreciseSeries(view, options) {
  // snapshot's mantissa is in [1,2); core normalization adds one to exponent.
  return view.deep && view.exponent >= -51 && view.exponent <= -27 &&
    ((options.engineOptions === undefined ? DEFAULT_ENGINE_OPTIONS : options.engineOptions) & 1024) !== 0;
}

function useCompactTiles(view, options) {
  if (options.compactTiles !== undefined) return options.compactTiles === true;
  // Compact footprints retain more certificates and accurate series steps.
  const certificate = view.deep && view.exponent >= -50 && view.exponent <= -26 &&
    ((options.engineOptions === undefined ? DEFAULT_ENGINE_OPTIONS : options.engineOptions) & 512) !== 0;
  return certificate || usePreciseSeries(view, options);
}

function minimumTilePixels(view, options, compactTiles = useCompactTiles(view, options)) {
  if (options.minTilePixels !== undefined) return options.minTilePixels;
  return compactTiles && usePreciseSeries(view, options) ? 256 : 1;
}

export async function start(root, options = {}) {
  let disposed = false, pending, frameRequest = 0, selectionRequest = 0, navigationActive = false, previewWindow = false;
  let physicalSize, replacementCount = 0, fullscreenPending = false, referenceWorker, referenceIterations = 0;
  let referencePreparing = false, viewURL = location.hash;
  let progress, progressFill, progressPill, progressCompleted, progressPercent, progressTotal;
  const progressLanguage = (navigator.languages?.[0] || navigator.language || 'en')
    .toLowerCase().split('-')[0] === 'de' ? 'de' : 'en';
  const progressCopy = progressLanguage === 'de'
    ? {action: 'Berechne', pixels: 'Pixel', label: 'Fortschritt der Bildberechnung'}
    : {action: 'Calculating', pixels: 'pixels', label: 'Image calculation progress'};
  const progressFormatter = new Intl.NumberFormat(progressLanguage === 'de' ? 'de-DE' : 'en-US',
    {useGrouping: true, maximumFractionDigits: 0});
  const progressNumber = value => progressFormatter.format(value);
  const view = createView(root._mandelbrotView);
  const linkedView = viewFromFragment(location.hash);
  if (!root._mandelbrotView && linkedView) view.set(linkedView);
  const slots = [];
  const simdBytes = await loadBytes('engine-simd.wasm');
  const backend = WebAssembly.validate(simdBytes) ? 'simd128' : 'scalar';
  const wasmBytes = backend === 'simd128' ? simdBytes : await loadBytes('engine-scalar.wasm');
  const module = await WebAssembly.compile(wasmBytes);
  if (WebAssembly.Module.imports(module).length) throw new Error('Unexpected WASM imports');
  const workerCount = Math.max(1, Math.min(8, options.workers || (navigator.hardwareConcurrency || 2) - 1));
  const canvasReadFrequently = options.willReadFrequently===undefined ? options.progressive!==false : !!options.willReadFrequently;
  const previews = options.preview === false ? null : createPreviewRenderer({module,engineOptions:options.engineOptions,
    gpu:options.gpuPreview!==false,snapshot:(...args)=>view.snapshot(...args),show:showPreview});
  const imageExport = createImageExport(root, frame => !disposed && pending === frame &&
    frame.completed === frame.total && frame.shown && root.dataset.resizeMode === 'idle', options.export);
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
  const navigation = createNavigation(root, view, active => {
    navigationActive = active;
    if (active) { scheduler.hold(true); resize(); }
    else { saveURL(); selectView(); }
  });
  function selectView() {
    navigationActive = false;
    previewWindow = true;
    scheduler.hold(true); resize();
    // URL/API selections also have a navigation window before the next final
    // frame. Use it for a bounded preview; final work never waits for it.
    if(previews){const r=root.getBoundingClientRect(),dpr=devicePixelRatio||1;
      const width=Math.round(r.width*dpr),height=Math.round(r.height*dpr);
      if(width && height)previews.request({width,height,cssWidth:r.width,cssHeight:r.height,
        view:view.snapshot(r.width,r.height,width,height)},true);}
    cancelAnimationFrame(selectionRequest);
    selectionRequest=requestAnimationFrame(()=>{selectionRequest=0;previewWindow=false;scheduler.hold(false);});
  }
  function saveURL() {
    const fragment = viewFragment(currentView());
    if (fragment !== location.hash)
      history.replaceState(history.state, '', location.pathname + location.search + fragment);
    viewURL = fragment;
  }
  function restoreURL() {
    if (viewURL === location.hash) return;
    viewURL = location.hash;
    view.set(viewFromFragment(location.hash) || {});
    selectView();
  }

  function newSlot() {
    return new Promise((resolve, reject) => {
      const worker = new Worker(new URL('./engine-worker.js', import.meta.url), {type: 'module'});
      const slot = {worker, busy: false, job: null, ready: false,
        buffers: [new ArrayBuffer(TILE_WIDTH * TILE_HEIGHT * 4), new ArrayBuffer(TILE_WIDTH * TILE_HEIGHT * 4)]};
      slots.push(slot);
      const timer = setTimeout(() => { worker.terminate(); reject(new Error('Worker startup timed out')); }, 15000);
      slot.timer = timer;
      worker.onmessage = ({data}) => {
        if (disposed || !slots.includes(slot)) return;
        if (data.type === 'ready') {
          clearTimeout(timer); slot.ready = true; resolve(slot); dispatch(slot); return;
        }
        if (data.type === 'error') {
          if (!slot.ready) { clearTimeout(timer); reject(new Error(data.message)); }
          else lostSlot(slot, new Error(data.message));
          return;
        }
        if (data.type !== 'tile') return;
        const job = slot.job;
        slot.busy = false; slot.job = null;
        if (!disposed && pending && data.generation === pending.generation && scheduler.accept(pending.id)) {
          const frame = pending;
          const work=data.stats || {};
          if(frame.view.deep && (work.ddIterations || work.perturbIterations || work.fixedIterations))
            slot.warmPath=usePreciseSeries(frame.view,options)?'series':frame.view.perturb?'perturb':'local';
          frame.precisionHint = Math.max(frame.precisionHint || 0, data.precisionBits || 0);
          frame.queue.observe(data.timing?.computeMilliseconds,data.width*data.height);
          frame.tileTimes.push(data.timing?.computeMilliseconds || 0);
          frame.workerMilliseconds += data.timing?.computeMilliseconds || 0;
          frame.copyMilliseconds += data.timing?.copyMilliseconds || 0;
          frame.roundTripMilliseconds += performance.now() - slot.sentAt;
          slot.memoryBytes = data.memoryBytes || 0;
          slot.referenceBytes = data.referenceBytes || 0;
          for (const [key,value] of Object.entries(data.stats || {}))
            frame.stats[key] = (frame.stats[key] || 0) + value;
          // The spare buffer lets computation overlap main-thread presentation.
          // data.buffer remains owned here until every putImageData has returned.
          if (options.pipeline !== false) dispatch(slot);
          if (pending !== frame) { dispatch(slot,data.buffer); return; }
          const presentationStarted = performance.now();
          const pixels = new Uint8ClampedArray(data.buffer, 0, data.width * data.height * 4);
          putPixels(pending, data.x, data.y, data.width, data.height, pixels);
          let completedPixels = data.width * data.height;
          if (job.mirrorY !== null) {
            const stride = data.width * 4;
            const reflected = pending.mirrorBuffer.subarray(0, pixels.length);
            for (let row = 0; row < data.height; ++row)
              reflected.set(pixels.subarray(row * stride, (row + 1) * stride), (data.height - 1 - row) * stride);
            putPixels(pending, data.x, job.mirrorY, data.width, data.height, reflected);
            completedPixels *= 2;
          }
          ++pending.completed;
          pending.completedPixels += completedPixels;
          updateProgress(pending);
          pending.skipped = (pending.skipped || 0) + (data.skipped || 0);
          pending.fallbacks = (pending.fallbacks || 0) + (data.fallbacks || 0);
          pending.presentationMilliseconds += performance.now() - presentationStarted;
          if (frame.firstTileMilliseconds === undefined) {
            frame.firstTileMilliseconds = performance.now() - frame.started;
            root.dispatchEvent(new CustomEvent('mandelbrot-first-tile', {bubbles: true, detail: {
              generation: frame.generation, width: frame.width, height: frame.height,
              milliseconds: frame.firstTileMilliseconds, phase: frame.preview ? 'preview' : frame.kind,
              zoom: frame.view.zoom
            }}));
            if (pending !== frame) { dispatch(slot, data.buffer); return; }
          }
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
      worker.postMessage({type: 'init', module, engineOptions: options.engineOptions});
    });
  }

  function lostSlot(slot, error) {
    if (disposed || !slots.includes(slot)) return;
    console.error('Mandelbrot worker:', error);
    if (slot.job && pending && slot.job.generation === pending.generation) pending.retry.push(slot.job);
    slot.worker.terminate(); slots.splice(slots.indexOf(slot), 1);
    if (++replacementCount <= 2) newSlot().catch(fail);
    else fail(error);
  }

  function dispatch(slot, buffer) {
    if (disposed || !slots.includes(slot)) return;
    if (buffer) slot.buffers.push(buffer);
    if (!pending || slot.busy || !slot.ready || pending.completed === pending.total) return;
    if (!scheduler.accept(pending.id)) return;
    if (pending.view.perturb && !pending.reference) return;
    let job = pending.retry.pop();
    if (!job) {
      const tile = pending.queue.take();
      pending.total = pending.queue.total;
      if (!tile) return;
      job = {type: 'render', generation: pending.generation, ...tile};
    }
    if (pending.view.perturb && slot.referenceGeneration !== pending.generation) {
      slot.worker.postMessage({type: 'reference', generation: pending.generation, bits: pending.reference.bits,
        view: pending.view, buffer: pending.reference.buffer});
      slot.referenceGeneration = pending.generation;
    }
    if (slot.configuredGeneration !== pending.generation) {
      slot.worker.postMessage({type:'configure', generation:pending.generation, view:pending.view,
        frameWidth:pending.width, frameHeight:pending.height, precisionHint:pending.precisionHint});
      slot.configuredGeneration = pending.generation;
    }
    slot.busy = true; slot.job = job;
    if (pending.view.deep) slot.memoryIterations = Math.max(slot.memoryIterations || 0,pending.view.iterations);
    const transfer = slot.buffers.pop();
    slot.sentAt = performance.now();
    slot.worker.postMessage({...job, precisionHint:pending.precisionHint, buffer: transfer}, transfer ? [transfer] : []);
  }

  function putPixels(frame, x, y, width, height, pixels) {
    for (let row = 0; row < height;) {
      const targetY = y + row, rows = Math.min(height - row, SURFACE_SIZE - targetY % SURFACE_SIZE);
      const surface = frame.surfaces.get(`${Math.floor(x / SURFACE_SIZE)},${Math.floor(targetY / SURFACE_SIZE)}`);
      const part = pixels.subarray(row * width * 4, (row + rows) * width * 4);
      surface.context.putImageData(new ImageData(part, width, rows), x % SURFACE_SIZE, targetY % SURFACE_SIZE);
      frame.presentation?.note(surface,x % SURFACE_SIZE,targetY % SURFACE_SIZE,width,rows,part);
      row += rows;
    }
  }

  function updateProgress(frame) {
    if (!progress) return;
    const total = frame.width * frame.height, fraction = frame.completedPixels / total;
    const percent = String(Math.floor(100 * fraction));
    const completed = progressNumber(frame.completedPixels);
    progressCompleted.textContent = completed;
    progressPercent.textContent = percent;
    progress.setAttribute('aria-valuenow', percent);
    progress.setAttribute('aria-valuetext',
      `${progressCopy.action} ${completed} / ${progressTotal} ${progressCopy.pixels} • ${percent}%`);
    progressFill.style.transform = `scaleX(${fraction})`;
  }
  function showProgress(frame) {
    if (disposed || pending !== frame || frame.completed === frame.total) return;
    progressPill = document.createElement('div'); progressPill.className = 'render-progress-pill';
    progressPill.setAttribute('lang', progressLanguage);
    Object.assign(progressPill.style, {position: 'absolute', left: '50%', bottom: 'max(24px, env(safe-area-inset-bottom))',
      transform: 'translateX(-50%)', width: 'max-content', maxWidth: 'calc(100% - 24px)', boxSizing: 'border-box',
      padding: '10px 18px 12px', borderRadius: '999px', background: '#111318', color: '#f4f7ff',
      border: '1px solid rgba(255,255,255,0.28)', boxShadow: '0 3px 18px rgba(0,0,0,0.65)',
      font: '500 12px/1.4 system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
      fontVariantNumeric: 'tabular-nums lining-nums', fontFeatureSettings: '"tnum" 1, "lnum" 1',
      pointerEvents: 'none', zIndex: '1'});
    const label = document.createElement('div'); label.className = 'render-progress-label';
    label.setAttribute('aria-hidden', 'true');
    Object.assign(label.style, {display: 'flex', flexWrap: 'wrap', justifyContent: 'center',
      alignItems: 'baseline', columnGap: '0.35em', rowGap: '2px', marginBottom: '8px', textAlign: 'center'});
    const action = document.createElement('span'); action.textContent = progressCopy.action;
    const counts = document.createElement('span'); counts.style.whiteSpace = 'pre';
    progressTotal = progressNumber(frame.width * frame.height);
    const countSlot = document.createElement('span');
    Object.assign(countSlot.style, {display: 'inline-block', position: 'relative'});
    const countSizer = document.createElement('span'); countSizer.textContent = progressTotal;
    countSizer.style.visibility = 'hidden';
    progressCompleted = document.createElement('span'); progressCompleted.className = 'render-progress-count';
    // Measure the final grouped number, including the font's actual separators.
    // Overlay the changing count so another digit cannot resize the sentence.
    Object.assign(progressCompleted.style, {position: 'absolute', inset: '0', textAlign: 'right'});
    countSlot.append(countSizer, progressCompleted);
    const separator = document.createElement('span'); separator.textContent = '\u00a0/\u00a0';
    const total = document.createElement('span'); total.className = 'render-progress-total';
    total.textContent = progressTotal;
    counts.append(countSlot, separator, total);
    const tail = document.createElement('span');
    Object.assign(tail.style, {display: 'inline-flex', alignItems: 'baseline', columnGap: '0.35em', whiteSpace: 'nowrap'});
    const pixels = document.createElement('span'); pixels.textContent = progressCopy.pixels;
    const bullet = document.createElement('span'); bullet.className = 'render-progress-separator'; bullet.textContent = '•';
    const percentage = document.createElement('span');
    Object.assign(percentage.style, {display: 'inline-block', width: 'calc(3ch + 1em)', textAlign: 'left'});
    progressPercent = document.createElement('span'); progressPercent.className = 'render-progress-percent';
    const percentSign = document.createElement('span'); percentSign.textContent = '%';
    percentage.append(progressPercent, percentSign);
    tail.append(pixels, bullet, percentage);
    label.append(action, counts, tail);
    progress = document.createElement('div'); progress.className = 'render-progress';
    progress.setAttribute('role', 'progressbar');
    progress.setAttribute('aria-label', progressCopy.label);
    progress.setAttribute('aria-valuemin', '0'); progress.setAttribute('aria-valuemax', '100');
    Object.assign(progress.style, {height: '6px', borderRadius: '3px',
      background: '#3b414c', overflow: 'hidden', pointerEvents: 'none'});
    progressFill = document.createElement('div');
    Object.assign(progressFill.style, {height: '100%', background: '#b4ffff', transformOrigin:'left'});
    progress.append(progressFill); progressPill.append(label, progress); root.append(progressPill); updateProgress(frame);
  }
  function hideProgress(frame) {
    clearTimeout(frame?.progressTimer);
    progressPill?.remove(); progress = progressFill = progressPill = progressCompleted = progressPercent = progressTotal = null;
  }

  function reveal(frame, complete = false) {
    if (disposed || pending !== frame) return;
    frame.shown = true; frame.layer.style.visibility = 'visible';
    frame.layer.style.transform = previewTransform(frame.view, currentView(), root.clientWidth, root.clientHeight);
    if (complete) for (const child of [...root.children])
      if (child !== frame.layer && (child._frame || child._preview)) {
        releaseSurfaces(child._frame); child.remove();
      }
    root.dataset.exportState = 'pending';
  }

  function showPreview(data) {
    if (disposed || (!pending && !navigationActive && !previewWindow) ||
        (pending && pending.completed===pending.total && !navigationActive && !previewWindow)) {
      data.bitmap.close();return;
    }
    const frame = pending && pending.completed!==pending.total ? pending : null;
    const layer=document.createElement('div');layer.className='frame';layer._preview=true;layer._view=data.view;
    layer.style.transform=previewTransform(data.view,currentView(),root.clientWidth,root.clientHeight);
    const canvas=document.createElement('canvas');canvas.width=data.width;canvas.height=data.height;
    canvas.setAttribute('aria-hidden','true');Object.assign(canvas.style,{width:'100%',height:'100%'});
    const bitmapContext=canvas.getContext('bitmaprenderer');
    if(bitmapContext)bitmapContext.transferFromImageBitmap(data.bitmap);
    else {canvas.getContext('2d',{alpha:false}).drawImage(data.bitmap,0,0);data.bitmap.close();}
    layer.append(canvas);
    for(const child of [...root.children])if(child!==frame?.layer && (child._frame || child._preview)) {
      releaseSurfaces(child._frame);child.remove();
    }
    if(frame)root.insertBefore(layer,frame.layer);else root.append(layer);
    root.dispatchEvent(new CustomEvent('mandelbrot-preview',{bubbles:true,detail:{
      generation:frame?.generation,revision:data.view.revision,width:data.width,height:data.height,
      milliseconds:data.milliseconds,computeMilliseconds:data.computeMilliseconds,zoom:data.view.zoom,backend:data.backend,
      quality:{iterations:data.iterations,moving:data.moving}}}));
  }

  function presented(frame,detail) {
    if(disposed || pending!==frame)return;
    if(!detail.final)reveal(frame);
    root.dispatchEvent(new CustomEvent('mandelbrot-present',{bubbles:true,detail:{
      generation:frame.generation,width:frame.width,height:frame.height,phase:frame.kind,
      completedPixels:frame.completedPixels,presentedPixels:detail.pixels,final:detail.final,milliseconds:performance.now()-frame.started,
      presentationMilliseconds:detail.milliseconds,count:detail.count,interval:detail.interval}}));
  }

  // Bound abandoned partial images to a small backdrop. drawImage reads the
  // existing raster without a GPU-to-CPU readback or a full-resolution copy.
  function snapshotBackground() {
    const rect=root.getBoundingClientRect(),scale=Math.min(1,320/Math.max(rect.width,rect.height));
    if(!rect.width || !rect.height)return;
    const layer=document.createElement('div');layer.className='frame';layer._preview=true;layer._view=root._mandelbrotView || currentView();
    const canvas=document.createElement('canvas');canvas.width=Math.max(1,Math.round(rect.width*scale));
    canvas.height=Math.max(1,Math.round(rect.height*scale));
    canvas.setAttribute('aria-hidden','true');Object.assign(canvas.style,{width:'100%',height:'100%'});
    const context=canvas.getContext('2d',{alpha:false});
    for(const child of [...root.children])if(child._frame || child._preview) {
      if(child.style.visibility==='hidden')continue;
      const surfaces=child._frame?.surfaces;
      if(surfaces?.size)for(const surface of surfaces.values()) {
        const source=surface.display?.canvas || surface.context.canvas;
        if(source.style.visibility==='hidden')continue;
        const r=source.getBoundingClientRect();
        if(surface.visibleRegions)for(const area of surface.visibleRegions)
          context.drawImage(source,area.x,area.y,area.width,area.height,
            (r.left-rect.left+area.x*r.width/source.width)*scale,(r.top-rect.top+area.y*r.height/source.height)*scale,
            area.width*r.width/source.width*scale,area.height*r.height/source.height*scale);
        else context.drawImage(source,(r.left-rect.left)*scale,(r.top-rect.top)*scale,r.width*scale,r.height*scale);
      } else {
        const source=child.querySelector('img') || child.querySelector('canvas');
        if(source){const r=source.getBoundingClientRect();context.drawImage(source,
          (r.left-rect.left)*scale,(r.top-rect.top)*scale,r.width*scale,r.height*scale);}
      }
    }
    layer.append(canvas);
    for(const child of [...root.children])if(child._frame || child._preview){releaseSurfaces(child._frame);child.remove();}
    root.append(layer);
  }

  function finish() {
    const frame = pending;
    if (frame.reference) frame.reference.buffer = null;
    if (!scheduler.complete(frame.id)) return;
    clearTimeout(frame.revealTimer); hideProgress(frame); reveal(frame,true);
    frame.presentation?.finish();
    if(disposed || pending!==frame)return;
    previews?.stop();
    root.dataset.state = 'complete';
    root.dispatchEvent(new CustomEvent('mandelbrot-frame', {bubbles: true, detail: {
      width: frame.width, height: frame.height, milliseconds: performance.now() - frame.started,
      backend, workers: slots.length, phase: frame.kind,
      zoom: frame.view.zoom, iterations: frame.view.iterations, deep: frame.view.deep,
      algorithm: frame.view.perturb ? 'perturbation/BLA' : frame.view.deep ? 'tile perturbation/BLA + double-double' : backend,
      referenceMilliseconds: frame.reference?.milliseconds || 0,
      computedPixels: frame.computedRows * frame.width, mirroredPixels: frame.mirroredRows * frame.width,
      skippedIterations: frame.skipped || 0, preciseFallbacks: frame.fallbacks || 0,
      firstTileMilliseconds:frame.firstTileMilliseconds, presentationMilliseconds:frame.presentationMilliseconds,
      workerMilliseconds:frame.workerMilliseconds, copyMilliseconds:frame.copyMilliseconds,
      roundTripMilliseconds:frame.roundTripMilliseconds, stats:frame.stats,
      tileCount:frame.total, compactTiles:frame.compactTiles, minTilePixels:frame.minTilePixels,
      tileMilliseconds:tileSummary(frame.tileTimes),
      wasmMemoryBytes:slots.reduce((sum,slot)=>sum+(slot.memoryBytes||0),0),
      referenceBytes:frame.reference?.referenceBytes || 0,
      referenceWorkerMemoryBytes:frame.reference?.memoryBytes || 0,
      referenceCacheHit:frame.reference?.cacheHit || false,
      retainedReferenceBytes:0, transferBufferBytes:workerCount*TILE_WIDTH*TILE_HEIGHT*8,
      canvasBytes:frame.width*frame.height*4, canvasReadFrequently:frame.canvasReadFrequently,
      previewMilliseconds:frame.job.previewMilliseconds || 0,
      presentationCount:frame.presentation?.count || 0, revealMilliseconds:frame.presentation?.milliseconds || 0,
      presentationCanvasBytes:frame.presentation?.peakCanvasBytes || 0,
      presentationBufferBytes:frame.presentation?.peakBufferBytes || 0
    }}));
    if (frame.kind === 'final') imageExport.prepare(frame);
  }

  function tileSummary(times) {
    const sorted=[...times].sort((a,b)=>a-b);
    return {median:sorted[Math.floor(sorted.length/2)]||0,p95:sorted[Math.floor(sorted.length*.95)]||0,max:sorted.at(-1)||0};
  }
  function releaseSurfaces(frame) {
    if (!frame?.surfaces) return;
    frame.presentation?.dispose();
    for (const {context} of frame.surfaces.values()) { context.canvas.width=0; context.canvas.remove(); }
    frame.surfaces.clear();
  }

  function fail(error) {
    console.error('Mandelbrot renderer:', error);
    dispose();
    root.dataset.state = 'failed';
  }

  function destroyReference() {
    referenceWorker?.terminate();
    referenceWorker = null;
    referenceIterations = 0;
    referencePreparing = false;
  }

  function cancelReference() {
    // A high-precision WASM batch cannot process a cancellation message until
    // it returns. Kill active preparation promptly; keep a completed cache.
    if (referencePreparing) destroyReference();
    else referenceWorker?.postMessage({type: 'cancel'});
  }

  function cancelRender(id) {
    if (pending?.id !== id) return;
    hideProgress(pending);
    clearTimeout(pending.revealTimer);
    if (pending.reference) pending.reference.buffer=null;
    if (pending.shown && pending.completed!==pending.total) snapshotBackground();
    else if (!pending.shown) { releaseSurfaces(pending); pending.layer.remove(); }
    cancelReference();
    if (!disposed && pending.view.deep) for (const slot of [...slots]) if (slot.job?.generation === pending.generation) {
      slot.worker.terminate(); slots.splice(slots.indexOf(slot),1); newSlot().catch(fail);
    }
    pending = null;
  }

  function render(size, job) {
    if (disposed || !size.width || !size.height) return;
    previewWindow = false;
    const compactTiles = useCompactTiles(size.view,options);
    const requestedMinPixels = minimumTilePixels(size.view,options,compactTiles);
    const queue = createTileQueue(size.width,size.height,size.view,
      {adaptive:options.adaptiveTiles!==false,compact:compactTiles,minPixels:requestedMinPixels});
    // Validate before allocating canvas backing stores. The queue rounds and
    // clamps the optional floor; telemetry reports that effective value.
    const minTilePixels = Math.max(1,Math.ceil(requestedMinPixels));
    // The old coarse pass warmed WASM before large local-reference calls.
    // Start cold local-reference code with small FINAL tiles instead: long
    // baseline-compiled calls cannot benefit from a later tier-up on stack.
    const warmPath=usePreciseSeries(size.view,options)?'series':size.view.perturb?'perturb':'local';
    // These conservative interior disks do not need deep-code warm-up. Keep
    // normal tiles and defer extra display copies until an update is needed.
    // This affects scheduling only; WASM still computes every final pixel.
    const radius=Math.hypot(size.width,size.height)*size.view.mantissa*2**size.view.exponent/2;
    const analyticInterior=Math.hypot(size.view.centreReal,size.view.centreImag)+radius<.25 ||
      Math.hypot(size.view.centreReal+1,size.view.centreImag)+radius<.25;
    // Prepared global references retain normal batches. Small startup tiles
    // slow that path without improving its already short first-tile latency.
    const cold=options.coldTiles!==false && size.view.deep && !size.view.perturb &&
      !analyticInterior && slots.some(slot=>slot.warmPath!==warmPath);
    if(cold)queue.observe(12,Math.max(256,minTilePixels));
    imageExport.cancel();
    hideProgress(pending);
    if (pending) {
      clearTimeout(pending.revealTimer);
      if (!pending.shown) { releaseSurfaces(pending); pending.layer.remove(); }
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
        const context = canvas.getContext('2d', {alpha: false, willReadFrequently:canvasReadFrequently});
        if (!context) {
          canvas.width = 0; releaseSurfaces({surfaces}); layer.remove();
          fail(new Error('Canvas allocation failed')); return;
        }
        surfaces.set(`${x / SURFACE_SIZE},${y / SURFACE_SIZE}`, {context}); layer.append(canvas);
      }
    }
    root.append(layer);
    pending = {...size, computedRows:queue.computedRows,mirroredRows:queue.mirroredRows, queue,
      id: job.id, generation:job.id*2+1,kind: job.kind, layer, surfaces, completed: 0,
      completedPixels: 0, retry: [], shown: false, mirrorBuffer: new Uint8ClampedArray(TILE_WIDTH * TILE_HEIGHT * 4),
      total:queue.total, started:job.started,job,stats:{},tileTimes:[],
      workerMilliseconds:0,copyMilliseconds:0,presentationMilliseconds:0,roundTripMilliseconds:0,
      canvasReadFrequently,compactTiles,minTilePixels,cold};
    layer._frame=pending;
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
    if(options.progressive!==false)frame.presentation=createPresentation(frame,detail=>presented(frame,detail),
      {failed:fail,retainPixels:!analyticInterior});
    previews?.request(size,false);
    if (job.kind === 'final') frame.progressTimer = setTimeout(() => showProgress(frame),
      Math.max(0, 500 - (performance.now() - frame.started)));
    // During navigation retain the complete transformed picture until the new
    // view is complete. Initial/window resize retain the existing presentation.
    if (!frame.presentation && job.kind === 'final' && !size.view.revision)
      frame.revealTimer = setTimeout(() => reveal(frame), 500);
    if (size.view.perturb) {
      if (referenceWorker && size.view.iterations*2<referenceIterations) {
        destroyReference();
      }
      if (!referenceWorker) {
        referenceWorker = new Worker(new URL('./reference-worker.js', import.meta.url), {type:'module'});
        referenceWorker.postMessage({type:'init',module,engineOptions:options.engineOptions});
      }
      const worker = referenceWorker;
      referenceIterations=Math.max(referenceIterations,size.view.iterations);
      worker.onmessage = ({data}) => {
        if (disposed || referenceWorker !== worker || data.generation !== frame.generation) return;
        if (data.type !== 'reference' && data.type !== 'error') return;
        referencePreparing = false;
        if (pending !== frame) return;
        if (data.type === 'error') { fail(new Error(data.message)); return; }
        frame.reference = data;
        for (const slot of slots) dispatch(slot);
      };
      worker.onerror = event => {
        if (!disposed && referenceWorker === worker) fail(new Error(event.message || 'Reference worker failed'));
      };
      referencePreparing = true;
      worker.postMessage({type:'prepare',generation:frame.generation,view:frame.view,width:frame.width,height:frame.height});
    } else destroyReference();
    for (const slot of slots) dispatch(slot);
  }

  function resize(immediate = false) {
    if (disposed || (frameRequest && immediate!==true)) return;
    const updateSize = () => {
      frameRequest = 0;
      const rect = root.getBoundingClientRect(), dpr = devicePixelRatio || 1;
      const exact = physicalSize && physicalSize.dpr === dpr && physicalSize.cssWidth === rect.width &&
        physicalSize.cssHeight === rect.height ? physicalSize : null;
      try {
        const width = exact ? exact.width : Math.round(rect.width*dpr);
        if (!rect.width || !rect.height || !width) {
          previews?.stop();
          scheduler.update({width:0,height:0,cssWidth:rect.width,cssHeight:rect.height}); return;
        }
        const height=exact ? exact.height : Math.round(rect.height*dpr);
        const target = view.snapshot(rect.width,rect.height,width,height);
        root._mandelbrotView=target;
        for (const child of root.children) if (child.style.visibility !== 'hidden' && child._view)
          child.style.transform = previewTransform(child._view,target,rect.width,rect.height);
        const size={width: exact ? exact.width : Math.round(rect.width * dpr),
          height: exact ? exact.height : Math.round(rect.height * dpr), cssWidth: rect.width, cssHeight: rect.height, view: target};
        if(navigationActive)previews?.request(size,true);
        scheduler.update(size);
      } catch (error) { fail(error); }
    };
    if(immediate===true){cancelAnimationFrame(frameRequest);updateSize();}
    else frameRequest=requestAnimationFrame(updateSize);
  }
  function currentView() { const r=root.getBoundingClientRect();return view.snapshot(r.width,r.height,Math.round(r.width*(devicePixelRatio||1))); }

  const observer = new ResizeObserver(entries => {
    const entry = entries[0], box = entry.devicePixelContentBoxSize?.[0];
    if (box) physicalSize = {width: box.inlineSize, height: box.blockSize, dpr: devicePixelRatio || 1,
      cssWidth: entry.contentRect.width, cssHeight: entry.contentRect.height};
    // A stationary shallow selection can use the exact observed raster now,
    // without spending another display cycle waiting for its size.
    if(previewWindow && selectionRequest && !navigationActive && box?.inlineSize>0 && box?.blockSize>0 &&
        !view.snapshot(entry.contentRect.width,entry.contentRect.height,box.inlineSize,box.blockSize).deep) {
      cancelAnimationFrame(selectionRequest);selectionRequest=0;
      resize(true);previewWindow=false;scheduler.hold(false);
    }else resize();
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
    disposed = true; observer.disconnect(); cancelAnimationFrame(frameRequest);cancelAnimationFrame(selectionRequest);
    scheduler.dispose();
    imageExport.dispose();
    navigation.dispose(); destroyReference();
    previews?.dispose();pending?.presentation?.dispose(pending.shown);
    hideProgress(pending);
    clearTimeout(pending?.revealTimer);
    if (pending && !pending.shown) { releaseSurfaces(pending); pending.layer.remove(); }
    densityQuery?.removeEventListener('change', densityChanged);
    window.removeEventListener('resize', resize); document.removeEventListener('visibilitychange', resume);
    window.removeEventListener('hashchange', restoreURL); window.removeEventListener('popstate', restoreURL);
    root.removeEventListener('click', enterFullscreen); document.removeEventListener('fullscreenchange', fullscreenChanged);
    for (const slot of slots) {
      clearTimeout(slot.timer); slot.worker.terminate(); slot.buffers.length = 0; slot.job = null;
    }
    slots.length = 0;
  }

  if(previews){const r=root.getBoundingClientRect(),dpr=devicePixelRatio||1;
    const width=Math.round(r.width*dpr),height=Math.round(r.height*dpr);
    if(width && height){previewWindow=true;previews.request({width,height,cssWidth:r.width,cssHeight:r.height,
      view:view.snapshot(r.width,r.height,width,height)},true);}}
  try { await Promise.all(Array.from({length: workerCount}, () => newSlot())); }
  catch (error) { dispose(); throw error; }
  try { observer.observe(root, {box: 'device-pixel-content-box'}); }
  catch { observer.observe(root); }
  window.addEventListener('resize', resize); document.addEventListener('visibilitychange', resume);
  window.addEventListener('hashchange', restoreURL); window.addEventListener('popstate', restoreURL);
  root.addEventListener('click', enterFullscreen); document.addEventListener('fullscreenchange', fullscreenChanged);
  densityChanged();
  return {dispose, backend, setView: target => { view.set(target); saveURL(); selectView(); }, getView: currentView,
    reset: () => { view.reset(); saveURL(); selectView(); }};
}

async function loadBytes(name) {
  const response = await fetch(new URL(name, import.meta.url));
  if (!response.ok) throw new Error(`Missing ${name}`);
  return response.arrayBuffer();
}
