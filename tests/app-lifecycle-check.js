// Production app/scheduler/queue under a deterministic DOM and Worker host.
// No browser, sockets, image computation or wall-clock sleeps are needed.
var testDone = false;
const assertLifecycle = (condition, message) => { if (!condition) throw new Error(message); };
async function lifecycleFixture({width = 33, height = 17, zoom = 400, preview = false, progressive = true, imag = '1',
  compactTiles, engineOptions, minTilePixels, coldTiles, languages, language} = {}) {
  let time = 0, sequence = 0, navigate, resizeCallback;
  const timers = new Map(), workers = [], canvases = [], sentBuffers = new Set(), errors = [];
  const timer = (fn, delay = 0) => { const id = ++sequence; timers.set(id, {fn, at: time + delay}); return id; };
  const cancelTimer = id => timers.delete(id);
  const microtasks = async () => { for (let n = 0; n < 12; ++n) await Promise.resolve(); };
  async function advance(milliseconds) {
    const end = time + milliseconds;
    for (let turns = 0;; ++turns) {
      assertLifecycle(turns < 10000, 'Mock event loop did not settle');
      await microtasks();
      let next;
      for (const entry of timers) if (entry[1].at <= end && (!next || entry[1].at < next[1].at)) next = entry;
      if (!next) break;
      time = Math.max(time, next[1].at); timers.delete(next[0]); next[1].fn();
    }
    time = end; await microtasks();
  }
  class Element {
    constructor(tagName) {
      this.tagName = tagName.toUpperCase(); this.children = []; this.style = {}; this.dataset = {};
      this.listeners = new Map(); this.attributes = new Map(); this.width = 0; this.height = 0;
    }
    append(...children) { for (const child of children) { child.remove(); this.children.push(child); child.parentNode = this; } }
    insertBefore(child,before) {child.remove();this.children.splice(this.children.indexOf(before),0,child);child.parentNode=this;}
    remove() {
      if (this.parentNode) this.parentNode.children.splice(this.parentNode.children.indexOf(this), 1);
      this.parentNode = null;
    }
    setAttribute(name, value) { this.attributes.set(name, String(value)); }
    getAttribute(name) { return this.attributes.get(name) ?? null; }
    addEventListener(type, callback) {
      if (!this.listeners.has(type)) this.listeners.set(type, new Set());
      this.listeners.get(type).add(callback);
    }
    removeEventListener(type, callback) { this.listeners.get(type)?.delete(callback); }
    dispatchEvent(event) { for (const callback of [...(this.listeners.get(event.type) || [])]) callback(event); return true; }
    getBoundingClientRect() { return {width, height, left: 0, top: 0}; }
    get clientWidth() { return width; }
    get clientHeight() { return height; }
    getContext() {
      if (!this.context) this.context = {canvas: this, writes: 0, drawImage() {},getImageData(x,y,w,h){return {data:new Uint8ClampedArray(w*h*4)};}, transferFromImageBitmap(bitmap) {bitmap.close();}, putImageData: image => {
        assertLifecycle(!sentBuffers.has(image.data.buffer), 'Canvas used a buffer already transferred to a worker');
        assertLifecycle(this.width > 0, 'Canvas backing store was released before presentation');
        ++this.context.writes;
      }};
      return this.context;
    }
    querySelector(selector) {
      const matches = child => selector.startsWith('.') ? (child.className || '').split(/\s+/).includes(selector.slice(1))
        : child.tagName === selector.toUpperCase();
      return this.children.find(matches) ||
        this.children.map(child => child.querySelector(selector)).find(Boolean) || null;
    }
  }
  const root = new Element('main'), document = new Element('document'), window = new Element('window');
  document.createElement = tag => {
    const element = new Element(tag); if (tag === 'canvas') canvases.push(element); return element;
  };
  document.createElementNS = (namespace,tag) => document.createElement(tag);
  class Worker {
    constructor(url) {
      this.kind = String(url).includes('reference-worker') ? 'reference' : String(url).includes('preview-worker') ? 'preview' : 'engine';
      this.messages = []; this.jobs = []; this.terminated = false; workers.push(this);
    }
    postMessage(message, transfers = []) {
      assertLifecycle(!this.terminated, 'A removed worker consumed a new render job');
      for (const buffer of transfers) {
        assertLifecycle(!sentBuffers.has(buffer), 'Transferred a buffer twice'); sentBuffers.add(buffer);
      }
      this.messages.push({...message});
      if (message.type === 'init' && this.kind === 'engine') timer(() => this.emit({type: 'ready'}), 0);
      if (message.type === 'init' && this.kind === 'preview') timer(() => this.emit({type: 'ready',gpu:message.gpu}), 0);
      if (message.type === 'render') this.jobs.push({...message});
    }
    terminate() { this.terminated = true; }
    emit(data) { this.onmessage?.({data}); }
    reference() {
      const request = [...this.messages].reverse().find(message => message.type === 'prepare');
      assertLifecycle(request, 'Reference result has no request');
      this.emit({type: 'reference', generation: request.generation, bits: 1024, buffer: new ArrayBuffer(1024),
        referenceBytes: 1024, memoryBytes: 65536, milliseconds: 1, cacheHit: false});
    }
    preview() {
      const job=this.jobs.shift();assertLifecycle(job,'Preview result has no request');
      const bitmap={closed:false,close(){this.closed=true;}};
      this.emit({...job,type:'preview',bitmap,iterations:job.view.iterations,milliseconds:1});return bitmap;
    }
    tile(stats = {retries: 0}, computeMilliseconds = 1) {
      const job = this.jobs.shift(); assertLifecycle(job, 'Tile result has no request');
      const buffer = job.buffer || new ArrayBuffer(256 * 64 * 4); sentBuffers.delete(buffer);
      this.emit({...job, type: 'tile', buffer, timing: {computeMilliseconds, copyMilliseconds: 0},
        precisionBits: 1024, memoryBytes: 65536, referenceBytes: 1024, stats});
      return job;
    }
  }
  class URL {
    constructor(path) { this.href = path; }
    toString() { return this.href; }
  }
  const location = {hash: '', pathname: '/test/', search: ''};
  const history = {state: null, replaceState: (state, title, url) => { location.hash = url.includes('#') ? '#' + url.split('#')[1] : ''; }};
  const console = {error: (...items) => errors.push(items.join(' ')), debug() {}};
  const exportFrames = [];
  const globals = {
    document, window, location, history, console, navigator: {hardwareConcurrency: 2, languages, language}, devicePixelRatio: 1,
    Worker, URL, ImageData: class { constructor(data) { this.data = data; } },
    CustomEvent: class { constructor(type, properties) { this.type = type; Object.assign(this, properties); } },
    ResizeObserver: class { constructor(callback){resizeCallback=callback;} observe() {} disconnect() {} },
    matchMedia: () => ({addEventListener() {}, removeEventListener() {}}),
    performance: {now: () => time}, setTimeout: timer, clearTimeout: cancelTimer,
    requestAnimationFrame: fn => timer(fn, 16), cancelAnimationFrame: cancelTimer,
    fetch: async () => ({ok: true, arrayBuffer: async () => new ArrayBuffer(8)}),
    WebAssembly: {validate: () => true, compile: async () => ({}), Module: {imports: () => []}},
    createNavigation: (element,view,changed) => {
      navigate=(target,active)=>{view.set(target);changed(active);};
      return {dispose() {}, suppressClick: () => false};
    },
    createImageExport: (element, isCurrent) => ({cancel() {}, dispose() {}, prepare: frame => {
      assertLifecycle(isCurrent(frame), 'A stale frame was exported'); exportFrames.push(frame);
    }})
  };
  const source = ['web/view.js', 'web/tile-queue.js', 'web/resize-scheduler.js', 'web/presentation.js', 'web/preview.js', 'web/app.js']
    .map(path => readText(path).replace(/^import .*\n/gm, '').replace(/^export /gm, '')
      .replace(/import\.meta/g, '({url:"https://test.invalid/web/app.js"})')).join('\n');
  const library = new Function(...Object.keys(globals), source + '\nreturn {start,createView,useCompactTiles,minimumTilePixels};')(...Object.values(globals));
  const view = library.createView(); view.set({real: '0', imag, zoom});
  root._mandelbrotView = view.snapshot(width, height);
  const started = library.start(root, {workers: 1, preview, progressive, compactTiles, engineOptions, minTilePixels, coldTiles, export: {enabled: false}});
  await advance(0);
  const app = await started;
  await advance(16);
  const active = kind => workers.filter(worker => !worker.terminated && worker.kind === kind);
  function complete() {
    for (let turns = 0; root.dataset.state !== 'complete'; ++turns) {
      assertLifecycle(turns < 10000, 'Frame did not complete');
      const worker = active('engine').find(candidate => candidate.jobs.length);
      assertLifecycle(worker, `No work remains for unfinished frame (${errors})`); worker.tile();
    }
  }
  const observed=(physicalWidth=width,physicalHeight=height)=>resizeCallback([{contentRect:{width,height},
    devicePixelContentBoxSize:[{inlineSize:physicalWidth,blockSize:physicalHeight}]}]);
  return {app, root, workers, canvases, timers, errors, exportFrames, active, advance, complete, navigate, observed,
    useCompactTiles: library.useCompactTiles, minimumTilePixels: library.minimumTilePixels};
}

(async () => {
  for (const [languages, language, expectedLanguage, action, pixels] of [
    [undefined, undefined, 'en', 'Calculating', 'pixels'],
    [['de-CH', 'en-US'], 'de-CH', 'de', 'Berechne', 'Pixel'],
    [['en-GB', 'de-DE'], 'en-GB', 'en', 'Calculating', 'pixels'],
    [['fr-FR'], 'fr-FR', 'en', 'Calculating', 'pixels'],
    [['fr-FR', 'de-DE'], 'fr-FR', 'en', 'Calculating', 'pixels'],
    [undefined, 'de-AT', 'de', 'Berechne', 'Pixel']
  ]) {
    const thousands = expectedLanguage === 'de' ? '.' : ',';
    const groupedTotal = `3${thousands}000`;
    const f = await lifecycleFixture({width: 3000, height: 1, languages, language});
    await f.advance(600);
    const pill = f.root.querySelector('.render-progress-pill'), bar = f.root.querySelector('.render-progress');
    assertLifecycle(pill?.getAttribute('lang') === expectedLanguage && bar,
      'Slow frame did not show the localized progress pill');
    assertLifecycle(bar.getAttribute('aria-valuetext') === `${action} 0 / ${groupedTotal} ${pixels} • 0%`,
      'Reference preparation advanced the pixel count or selected the wrong language');
    f.active('reference')[0].reference();
    const job = f.active('engine')[0].tile();
    const completed = job.width * job.height * (job.mirrorY === null ? 1 : 2);
    const percent = Math.floor(100 * completed / 3000);
    assertLifecycle(f.root.querySelector('.render-progress-count').textContent === String(completed) &&
      f.root.querySelector('.render-progress-total').textContent === groupedTotal &&
      f.root.querySelector('.render-progress-percent').textContent === String(percent) &&
      bar.getAttribute('aria-valuetext') === `${action} ${completed} / ${groupedTotal} ${pixels} • ${percent}%`,
      'Visible and accessible progress lost completed physical pixels');
    let groupedCount = completed;
    while (groupedCount < 1000) {
      const next = f.active('engine')[0].tile();
      groupedCount += next.width * next.height * (next.mirrorY === null ? 1 : 2);
    }
    assertLifecycle(f.root.querySelector('.render-progress-count').textContent ===
      String(groupedCount).replace(/\B(?=(\d{3})+(?!\d))/g, thousands), 'Completed count lost localized thousands separators');
    f.complete();
    assertLifecycle(!f.root.querySelector('.render-progress-pill'), 'Completion retained the progress pill');
    f.app.dispose();
  }
  {
    const f = await lifecycleFixture({width: 1024, height: 512, preview: true});
    const obsolete=f.active('reference')[0];
    f.app.setView({real:'0',imag:'1',zoom:401});
    assertLifecycle(obsolete.terminated,'Navigation did not terminate active reference preparation');
    await f.advance(16);
    const current=f.active('reference')[0];
    obsolete.reference();obsolete.onerror?.({message:'late obsolete failure'});
    assertLifecycle(!f.errors.length && current!==obsolete,'Obsolete reference affected its replacement');
    f.app.dispose();
    assertLifecycle(current.terminated && !f.active('engine').length && !f.active('preview').length,
      'Dispose retained active workers');
    assertLifecycle(f.canvases.every(canvas=>canvas.width===0) && !f.timers.size,'Dispose retained hidden resources');
  }
  {
    const f = await lifecycleFixture();
    const cached = f.active('reference')[0]; cached.reference();
    const obsolete = f.active('engine')[0];
    f.app.setView({real: '0', imag: '1', zoom: 400});
    assertLifecycle(!cached.terminated && obsolete.terminated, 'Navigation discarded the idle cache or kept an obsolete compute worker');
    await f.advance(16);
    assertLifecycle(f.active('reference')[0] === cached, 'Navigation recreated an idle reference worker');
    cached.reference();
    const current = f.active('engine')[0], jobsBefore = current.messages.length;
    obsolete.tile();
    assertLifecycle(current.messages.length === jobsBefore && !f.errors.length, 'A stale worker result consumed current work');
    const firstTiles = [];
    f.root.addEventListener('mandelbrot-first-tile', event => firstTiles.push(event.detail));
    f.complete();
    assertLifecycle(firstTiles.length === 1 && firstTiles[0].milliseconds >= 0, 'First-tile event was not emitted exactly once');
    const visible = f.root.children.find(child => child._frame)?._frame;
    assertLifecycle(visible?.reference.buffer === null, 'Completed frame retained its main-thread reference buffer');
    f.app.dispose();
    assertLifecycle(cached.terminated && !f.active('engine').length && f.timers.size === 0, 'Disposed completed frame retained workers or timers');
    assertLifecycle(visible.surfaces.size > 0, 'Dispose removed the visible image needed for release handoff');
  }
  {
    const f=await lifecycleFixture({width:1024,height:512,zoom:0,preview:true});
    let previewEvents=0;
    f.root.addEventListener('mandelbrot-preview',()=>{
      ++previewEvents;f.app.setView({real:'-0.75',imag:'0',zoom:0});
    });
    const obsolete=f.active('engine')[0];
    f.active('preview')[0].preview();
    assertLifecycle(previewEvents===1,'GPU preview event missing');
    await f.advance(16);f.complete();
    assertLifecycle(f.root.dataset.zoom==='0' && !f.errors.length,'Reentrant preview navigation failed');
    f.app.dispose();
    assertLifecycle(!f.timers.size,'Preview disposal retained a timer');
  }
  {
    const f = await lifecycleFixture({width: 300, height: 1, zoom: 40});
    const frames = [];
    f.root.addEventListener('mandelbrot-frame', event => frames.push(event.detail));
    const worker = f.active('engine')[0];
    worker.tile({certifiedPixels: 4, certificateIterations: 5});
    worker.tile({certifiedPixels: 7, certificateIterations: 11});
    assertLifecycle(frames.length === 1 && frames[0].stats.certifiedPixels === 11 &&
      frames[0].stats.certificateIterations === 16, 'Frame telemetry lost finite-iteration certificate statistics');
    f.app.dispose();
  }
  {
    const f = await lifecycleFixture({zoom: 40});
    for (const [view, options, expected] of [
      [{deep: true, exponent: -50}, {}, true],
      [{deep: true, exponent: -26}, {}, true],
      [{deep: true, exponent: -51}, {}, true],
      [{deep: true, exponent: -52}, {}, false],
      [{deep: true, exponent: -25}, {}, false],
      [{deep: false, exponent: -26}, {}, false],
      [{deep: true, exponent: -40}, {engineOptions: 511}, false],
      [{deep: true, exponent: -40}, {engineOptions: 512}, true],
      [{deep: true, exponent: -40}, {engineOptions: 1023}, true],
      [{deep: true, exponent: -51}, {engineOptions: 1024}, true],
      [{deep: true, exponent: -27}, {engineOptions: 1024}, true],
      [{deep: true, exponent: -52}, {engineOptions: 1024}, false],
      [{deep: true, exponent: -26}, {engineOptions: 1024}, false],
      [{deep: false, exponent: -40}, {engineOptions: 1024}, false],
      [{deep: true, exponent: -40}, {engineOptions: 1024, compactTiles: false}, false],
      [{deep: true, exponent: -40}, {compactTiles: false}, false],
      [{deep: false, exponent: -10}, {engineOptions: 0, compactTiles: true}, true]
    ]) assertLifecycle(f.useCompactTiles(view, options) === expected,
      `Unexpected compact tile policy for ${JSON.stringify({view, options})}`);
    for(const [view,options,expected] of [
      [{deep:true,exponent:-40},{},256],
      [{deep:true,exponent:-40},{engineOptions:779},1],
      [{deep:true,exponent:-51},{engineOptions:3851},256],
      [{deep:true,exponent:-27},{engineOptions:3851},256],
      [{deep:true,exponent:-52},{engineOptions:3851},1],
      [{deep:true,exponent:-26},{engineOptions:3851},1],
      [{deep:true,exponent:-40},{engineOptions:3851,compactTiles:false},1],
      [{deep:true,exponent:-40},{engineOptions:0,compactTiles:true},1],
      [{deep:false,exponent:-40},{engineOptions:3851,compactTiles:true},1],
      [{deep:true,exponent:-40},{engineOptions:3851,minTilePixels:1},1],
      [{deep:true,exponent:-40},{engineOptions:0,compactTiles:false,minTilePixels:512},512]
    ])assertLifecycle(f.minimumTilePixels(view,options)===expected,
      `Unexpected tile pixel minimum for ${JSON.stringify({view,options})}`);
    f.app.dispose();
  }
  for (const [options, expected, minimum, footprint] of [
    [{},true,256,[32,8]], [{compactTiles:false},false,1,[128,1]], [{compactTiles:true,engineOptions:0},true,1,[32,4]],
    [{engineOptions:0},false,1,[128,1]], [{engineOptions:512},true,1,[32,4]], [{zoom:45},true,256,[32,8]],
    [{engineOptions:3851},true,256,[32,8]], [{engineOptions:1024},true,256,[32,8]],
    [{engineOptions:3851,compactTiles:false},false,1,[128,1]],
    [{engineOptions:3851,minTilePixels:1},true,1,[32,4]],
    [{engineOptions:0,compactTiles:false,minTilePixels:512},false,512,[256,2]],
    [{engineOptions:3851,minTilePixels:255.1},true,256,[32,8]],
    [{engineOptions:3851,minTilePixels:0},true,1,[32,4]]
  ]) {
    const f = await lifecycleFixture({width: 512, height: 128, zoom: 40, coldTiles:false, ...options});
    const frames = [];
    f.root.addEventListener('mandelbrot-frame', event => frames.push(event.detail));
    const worker = f.active('engine')[0]; worker.tile({retries: 0}, 1000);
    const next = worker.jobs[0];
    assertLifecycle(next.width === footprint[0] && next.height === footprint[1],
      'App did not apply the selected adaptive tile footprint');
    f.complete();
    assertLifecycle(frames.length === 1 && frames[0].compactTiles === expected && frames[0].minTilePixels===minimum && !f.errors.length,
      'Frame completion lost the selected compact tile policy');
    f.app.dispose();
    assertLifecycle(f.timers.size === 0 && !f.active('engine').length,
      'Compact tile completion retained scheduled work');
  }
  {
    const f = await lifecycleFixture({zoom:40,engineOptions:3851,minTilePixels:Infinity});
    assertLifecycle(f.root.dataset.state==='failed' && f.errors.length===1 && !f.canvases.length &&
      !f.active('engine').length && f.timers.size===0,'Invalid tile minimum leaked canvas or worker resources');
  }
  {
    const f = await lifecycleFixture({zoom: 40});
    f.root.addEventListener('mandelbrot-first-tile', () => f.app.dispose());
    const worker = f.active('engine')[0]; worker.tile();
    assertLifecycle(!f.active('engine').length && f.timers.size === 0 && !f.errors.length,
      'Reentrant first-tile disposal left work running');
  }
  {
    const f=await lifecycleFixture({width:513,height:129,zoom:0,imag:'0'});f.complete();
    f.app.setView({real:'-0.75',imag:'0',zoom:1});f.observed(514,130);await f.advance(0);
    const frame=f.root.children.find(child=>child._frame && child._frame.completed!==child._frame.total)?._frame;
    assertLifecycle(frame?.width===514 && frame.height===130 && f.active('engine')[0].jobs.length,
      'Stationary shallow selection waited another frame or ignored the observed physical raster');
    f.complete();
    f.navigate({real:'-0.7',imag:'0',zoom:2},true);f.observed();await f.advance(0);
    assertLifecycle(!f.active('engine')[0].jobs.length,'Observed size released an active navigation gesture');
    f.navigate({real:'0',imag:'1',zoom:40},false);f.observed();await f.advance(0);
    assertLifecycle(!f.active('engine')[0].jobs.length,'Deep selection skipped its existing navigation window');
    await f.advance(16);f.complete();f.app.dispose();
    assertLifecycle(!f.errors.length && !f.timers.size,'Observed selection retained timers or resources');
  }
  {
    const f=await lifecycleFixture({width:1024,height:512,zoom:40,imag:'0'});
    const worker=f.active('engine')[0],first=worker.jobs[0];
    assertLifecycle(first.width*first.height===256*64,'Analytic interior paid for unnecessary cold tiles');
    worker.tile();
    const frame=f.root.children.find(child=>child._frame)._frame;
    assertLifecycle(frame.presentation.peakBufferBytes===0,'Fast interior retained speculative display pixels');
    f.complete();f.app.dispose();
    assertLifecycle(!f.errors.length && !f.timers.size,'Interior completion retained resources');
  }
  {
    const f=await lifecycleFixture({width:1024,height:512,zoom:32});
    const worker=f.active('engine')[0],first=worker.jobs[0];
    assertLifecycle(first.width*first.height===256,'Cold precise code began with a long full-size tile');
    worker.tile({ddIterations:1});
    f.complete();
    f.app.setView({real:'0',imag:'1',zoom:32.1});await f.advance(16);
    const warm=worker.jobs[0];
    assertLifecycle(warm.width*warm.height===256*64,'Warm precise code retained the startup estimate');
    f.complete();f.app.dispose();
  }
  for(const zoom of [100,400,1600]) {
    const f=await lifecycleFixture({width:1024,height:512,zoom}),events=[];
    f.root.addEventListener('mandelbrot-present',event=>events.push(event.detail));
    f.active('reference')[0].reference();
    const worker=f.active('engine')[0],first=worker.jobs[0];
    assertLifecycle(first.width*first.height===256*64,'Prepared global reference paid for small startup tiles');
    worker.tile();await f.advance(16);
    assertLifecycle(events.length===1 && !events[0].final && events[0].presentedPixels===first.width*first.height &&
      !f.exportFrames.length,'Global-reference first tile was not shown before full export');
    f.complete();f.app.dispose();
    assertLifecycle(!f.errors.length && !f.timers.size,'Global-reference completion retained resources');
  }
  {
    const f=await lifecycleFixture({width:1024,height:256,zoom:0,imag:'0'}),events=[];
    f.root.addEventListener('mandelbrot-present',event=>events.push(event.detail));
    const worker=f.active('engine')[0],job=worker.tile();
    await f.advance(16);
    assertLifecycle(events.length===1 && !events[0].final && events[0].completedPixels===job.width*job.height*2,
      'First visible update lost mirrored pixels');
    const frame=f.root.children.find(child=>child._frame)._frame;
    assertLifecycle(frame.shown && frame.completed<frame.total && !f.exportFrames.length,'Partial frame stayed hidden or was exported');
    worker.tile();worker.tile();await f.advance(124);
    assertLifecycle(events.length===1,'Progress counter forced an extra image update');
    await f.advance(17);assertLifecycle(events.length===2,'Accumulated tile results were not shown');
    const displays=[...frame.surfaces.values()].map(surface=>surface.display.canvas);
    f.app.setView({real:'-0.75',imag:'0',zoom:1});
    assertLifecycle(frame.layer._retained && frame.layer.parentNode===f.root &&
      displays.every(canvas=>canvas.width===1024 && canvas.parentNode===frame.layer) &&
      [...frame.surfaces.values()].every(surface=>surface.context.canvas.width===0) &&
      frame.presentation.retainedBufferBytes===0,
      'Canceled partial frame lost its visible tiles or retained staging/pixel buffers');
    await f.advance(16);f.complete();
    assertLifecycle(events.at(-1).final && f.exportFrames.length===1 && displays.every(canvas=>canvas.width===0) &&
      !f.root.children.some(child=>child._retained),'Final frame did not replace and release the retained partial tiles');
    f.app.dispose();assertLifecycle(!f.timers.size,'Partial cancellation retained timers');
  }
  {
    const f=await lifecycleFixture({width:2048,height:1024,zoom:40,preview:true,coldTiles:false,compactTiles:false});
    const worker=f.active('engine')[0];worker.tile({},1000);
    await f.advance(16);worker.tile();await f.advance(141);
    const first=f.root.children.find(child=>child._frame)._frame;
    const surface=[...first.surfaces.values()].find(surface=>surface.display),display=surface.display.canvas;
    assertLifecycle(surface.visibleRegions.some(region=>region.height===1),'Fixture did not display a single-pixel scan band');
    f.navigate({real:'0',imag:'1',zoom:40.5},true);await f.advance(16);
    assertLifecycle(display.width===1024 && display.parentNode===first.layer && first.layer.style.transform.includes('scale('),
      'Navigation resampled or discarded fine partial tiles');
    const preview=f.active('preview')[0];preview.preview();
    assertLifecycle(first.layer.parentNode===f.root &&
      f.root.children.indexOf(first.layer)>f.root.children.findIndex(child=>child._preview),
      'A coarse preview covered or discarded the accurate navigation fallback');
    f.navigate({real:'0',imag:'1',zoom:41},false);await f.advance(16);
    const next=f.active('engine')[0];next.tile();await f.advance(16);
    const second=[...f.root.children].reverse().find(child=>child._frame)._frame;
    f.navigate({real:'0',imag:'1',zoom:41.5},true);
    assertLifecycle(display.width===0 && first.surfaces.size===0 && second.layer._retained &&
      f.root.children.filter(child=>child._retained).length===1 && f.root.children.filter(child=>child._preview).length===1,
      'Repeated partial navigation accumulated full-resolution backgrounds');
    f.navigate({real:'0',imag:'1',zoom:42},false);await f.advance(16);f.complete();f.app.dispose();
    assertLifecycle(!f.errors.length && !f.timers.size,'Retained partial navigation leaked callbacks or timers');
  }
  {
    const f=await lifecycleFixture({width:400,height:200,zoom:0,preview:true});f.complete();
    f.navigate({real:'-0.75',imag:'0',zoom:1},true);await f.advance(40);
    const worker=f.active('preview')[0];worker.preview();
    assertLifecycle(f.root.children.some(child=>child._preview),'Live preview was discarded while exact rendering was held');
    worker.preview();
    f.navigate({real:'-0.75',imag:'0',zoom:40},true);await f.advance(34);
    assertLifecycle(worker.jobs.at(-1).backend==='wasm','Deep live view did not use WASM fallback');
    f.navigate({real:'-0.75',imag:'0',zoom:40},false);await f.advance(16);
    assertLifecycle(worker.messages.some(m=>m.type==='cancel') && f.active('engine').some(w=>w.jobs.length),'Final work waited for the WASM preview');
    f.complete();f.app.dispose();assertLifecycle(!f.timers.size && !f.errors.length,'Live preview lifecycle leaked resources');
  }
  report('App lifecycle: active reference abort, idle cache reuse, stale replies, preview supersession, transfer ownership, compact/minimum tile policies and telemetry, first-tile events and disposal passed.');
  testDone = true;
})().catch(error => { report(String(error.stack || error)); });
