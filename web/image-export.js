const SURFACE_SIZE = 1024;

export function createImageExport(root, isCurrent, options = {}) {
  let task, disposed = false;

  function cancel() {
    if (!task) return;
    task.worker.terminate();
    if (task.url) URL.revokeObjectURL(task.url);
    task = null;
    root.dataset.exportState = 'pending';
  }
  function prepare(frame) {
    if (disposed) return;
    if (options.enabled === false) { root.dataset.exportState = 'disabled'; return; }
    if (!isCurrent(frame) || frame.layer.querySelector('img') || task?.frame === frame) return;
    cancel();
    try {
      const worker = new Worker(new URL('./png-worker.js', import.meta.url), {type: 'module'});
      const job = {worker, frame, started: performance.now(), readbackMilliseconds: 0, packingMilliseconds: 0,
        readbackCalls: 0, readbackBytes: 0, transferBufferAllocations: 0, transferBufferBytes: 0};
      task = job; root.dataset.exportState = 'preparing';
      worker.onerror = error => { console.debug('Mandelbrot PNG:', error.message); if (task === job) cancel(); };
      worker.onmessage = async ({data}) => {
        if (task !== job) return;
        if (!isCurrent(frame)) { cancel(); return; }
        try {
          if (data.type === 'next') {
            const {y, height} = data, stride = frame.width * 4;
            // The worker returns the previous strip after consuming it. Keep
            // one maximum-size transfer buffer, including for a short last strip.
            const buffer = data.buffer || new ArrayBuffer(stride * Math.min(32, frame.height));
            if (!data.buffer) ++job.transferBufferAllocations;
            job.transferBufferBytes = Math.max(job.transferBufferBytes, buffer.byteLength);
            const band = new Uint8Array(buffer, 0, stride * height);
            // At most 32 rows are read per task. Each reply yields to browser
            // input/resize handling; no full-size temporary canvas is allocated.
            for (let x = 0; x < frame.width; x += SURFACE_SIZE) {
              const context = frame.surfaces.get(`${x / SURFACE_SIZE},${Math.floor(y / SURFACE_SIZE)}`).context;
              const columns = context.canvas.width;
              const readStarted = performance.now();
              const pixels = context.getImageData(0, y % SURFACE_SIZE, columns, height).data;
              job.readbackMilliseconds += performance.now() - readStarted;
              ++job.readbackCalls; job.readbackBytes += pixels.byteLength;
              const packStarted = performance.now();
              for (let row = 0; row < height; ++row)
                band.set(pixels.subarray(row * columns * 4, (row + 1) * columns * 4), row * stride + x * 4);
              job.packingMilliseconds += performance.now() - packStarted;
            }
            worker.postMessage({type: 'band', y, height, buffer: band.buffer}, [band.buffer]);
          } else if (data.type === 'complete') {
            worker.terminate();
            const name = `mandelbrot-${frame.width}x${frame.height}.png`;
            const file = new File([data.blob], name, {type: 'image/png'});
            const url = URL.createObjectURL(file); job.url = url;
            const image = new Image(); image.className = 'export-image'; image.alt = '';
            image.draggable = false;
            image.setAttribute('aria-hidden', 'true');
            Object.assign(image.style, {position: 'absolute', inset: '0', width: '100%', height: '100%', display: 'block'});
            const decodeStarted = performance.now();
            image.src = url; await image.decode();
            const decodeMilliseconds = performance.now() - decodeStarted;
            if (task !== job || !isCurrent(frame)) { if (task === job) cancel(); return; }
            frame.layer.append(image);
            const observer = new MutationObserver(() => {
              if (image.isConnected) return;
              observer.disconnect(); URL.revokeObjectURL(url);
            });
            observer.observe(root, {childList: true, subtree: true});
            // The decoded PNG replaces the tile surfaces without retaining a
            // second full image of canvas backing stores in the settled state.
            for (const {context} of frame.surfaces.values()) { context.canvas.remove(); context.canvas.width = 0; }
            frame.surfaces.clear(); task = null;
            root.dataset.exportState = 'ready';
            root.dispatchEvent(new CustomEvent('mandelbrot-export', {bubbles: true,
              detail: {width: frame.width, height: frame.height, bytes: file.size, filename: name,
                milliseconds: performance.now() - job.started, readbackMilliseconds: job.readbackMilliseconds,
                packingMilliseconds: job.packingMilliseconds, decodeMilliseconds,
                readbackCalls: job.readbackCalls, readbackBytes: job.readbackBytes,
                transferBufferAllocations: job.transferBufferAllocations, transferBufferBytes: job.transferBufferBytes,
                canvasReadFrequently: frame.canvasReadFrequently ?? null, encoder: data.metrics}}));
          } else if (data.type === 'error') throw new Error(data.message);
        } catch (error) { console.debug('Mandelbrot PNG:', error.message); if (task === job) cancel(); }
      };
      worker.postMessage({type: 'init', width: frame.width, height: frame.height});
    } catch (error) { console.debug('Mandelbrot PNG:', error.message); cancel(); }
  }
  function dispose() { disposed = true; cancel(); }
  return {prepare, cancel, dispose};
}
