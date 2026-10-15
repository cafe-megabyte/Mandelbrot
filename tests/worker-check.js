// Protocol, precision-resume and reference-cache checks with deterministic engines.
// Run with the repository's js-runner; no DOM, network, timers or Node dependency.
var testDone = false;
const requireWorker = (condition, message) => { if (!condition) throw new Error(message); };
function runWorker(source, engine, options = {}) {
  const messages = [], tasks = [];
  let tick = 0;
  const self = {postMessage(message) { messages.push(message); }};
  const wasm = {Module: {imports: () => []}, Instance: class { constructor() { this.exports = engine; } }};
  class Channel {
    constructor() { this.port1 = {}; this.port2 = {postMessage: () => tasks.push(() => this.port1.onmessage())}; }
  }
  const load = new Function('self', 'WebAssembly', 'writeCentre', 'performance', 'MessageChannel',
    readText(source).replace(/^import .*\n/gm, ''));
  load(self, wasm, options.writeCentre || (() => {}), {now: () => ++tick}, Channel);
  const send = data => self.onmessage({data});
  send({type: 'init', module: {}, engineOptions: 7});
  return {send, messages, tasks};
}

(function engineProtocol() {
  let precision = 0, needs = false, completed = 0, attempt = 0, configured = 0, allocated = 0, grown = 0;
  let written = 0, options;
  const engine = {
    memory: {buffer: new ArrayBuffer(65536)}, abi_version: () => 1,
    tile_width: () => 256, tile_height: () => 64, output_address: () => 0,
    deep_data_address: () => 4096, deep_data_size: () => 1024,
    deep_set_options: value => { options = value; },
    deep_allocate: bits => { ++allocated; precision = bits; return 1; },
    deep_configure: () => { ++configured; return 1; },
    deep_grow_precision: bits => {
      ++grown; precision = bits;
      const next = new ArrayBuffer(engine.memory.buffer.byteLength + 65536);
      new Uint8Array(next).set(new Uint8Array(engine.memory.buffer)); engine.memory.buffer = next;
      needs = false; return 1;
    },
    deep_render_tile: (x, y, width, height) => {
      ++attempt; completed = 0;
      const out = new Uint32Array(engine.memory.buffer, 0, width * height);
      out[0] = 0xff030201; out[1] = 0xff060504; completed = 2;
      if (attempt === 1) { needs = true; return 0; }
      out.fill(0xff0c0b0a, 2); completed = width * height; return width * height * 4;
    },
    deep_render_tile_resume: (x, y, width, height) => {
      requireWorker(completed === 2 && precision === 320, 'Resume lost progress or precision');
      ++attempt;
      const out = new Uint32Array(engine.memory.buffer, 0, width * height);
      requireWorker(out[0] === 0xff030201 && out[1] === 0xff060504, 'Growth lost validated pixels');
      out.fill(0xff090807, 2); completed = width * height; return width * height * 4;
    },
    deep_needs_precision: () => needs, deep_tile_completed_pixels: () => completed,
    deep_stat_skipped: () => attempt, deep_stat_fallbacks: () => 1,
    deep_stat_dd_fallbacks: () => 2, deep_stat_fixed_iterations: () => 10,
    deep_stat_dd_iterations: () => 20, deep_stat_reference_iterations: () => 30,
    deep_stat_local_references: () => 1, deep_stat_perturb_iterations: () => 40,
    deep_stat_certified_pixels: () => attempt, deep_stat_certificate_iterations: () => attempt * 5
  };
  const worker = runWorker('web/engine-worker.js', engine, {writeCentre: () => { ++written; }});
  const view = {deep: true, perturb: true, bits: 160, real: '-1', imag: '2', iterations: 32,
    mantissa: 1, exponent: -100};
  const reference = new Uint8Array(1024); reference.fill(23);
  worker.send({type: 'reference', generation: 1, bits: 256, view, buffer: reference.buffer});
  worker.send({type: 'configure', generation: 1, view, frameWidth: 4, frameHeight: 1});
  worker.send({type: 'render', generation: 1, x: 0, y: 0, width: 4, height: 1});
  const tile = worker.messages[worker.messages.length - 1];
  requireWorker(tile.type === 'tile', JSON.stringify(tile));
  requireWorker(options === 7 && allocated === 1 && grown === 1 && configured === 1 && written === 1,
    'Reference was allocated/copied/configured again during precision retry');
  requireWorker(tile.stats.retries === 1 && tile.stats.preservedPixels === 2 && tile.stats.discardedPixels === 0,
    'Resume statistics are incorrect');
  requireWorker(tile.stats.fixedIterations === 20 && tile.stats.ddIterations === 40 && tile.skipped === 3,
    'Statistics did not include every attempt');
  requireWorker(tile.stats.certifiedPixels === 3 && tile.stats.certificateIterations === 15,
    'Finite-iteration certificate statistics did not include every attempt');
  requireWorker(tile.precisionBits === 320 && tile.memoryBytes === 131072 && tile.retainedReferenceBytes === 0,
    'Precision or memory diagnostics are incorrect');
  requireWorker(new Uint8Array(engine.memory.buffer, 4096, 1024).every(value => value === 23),
    'Precision growth lost the reference');
  const pixels = new Uint32Array(tile.buffer, 0, 4);
  requireWorker(pixels[0] === 0xff030201 && pixels[3] === 0xff090807, 'Partial retry output differs');
  delete engine.deep_stat_certified_pixels; delete engine.deep_stat_certificate_iterations;
  worker.send({type: 'render', generation: 1, x: 0, y: 0, width: 4, height: 1, precisionHint: 384});
  requireWorker(configured === 1 && grown === 2 && precision === 384, 'Per-generation precision hint was not applied');
  const legacy = worker.messages[worker.messages.length - 1];
  requireWorker(legacy.type === 'tile' && legacy.stats.certifiedPixels === 0 && legacy.stats.certificateIterations === 0,
    'Missing optional certificate diagnostics changed rendering');
  worker.send({type: 'render', generation: 2, x: 0, y: 0, width: 4, height: 1});
  requireWorker(worker.messages[worker.messages.length - 1].type === 'error', 'Missing generation configuration was accepted');
  worker.send({type: 'render', generation: 1, x: 0, y: 0, width: 4, height: 1, precisionHint: NaN});
  requireWorker(worker.messages[worker.messages.length - 1].type === 'error', 'Invalid precision hint was accepted');
})();

(async function referenceProtocol() {
  let allocations = 0, finishes = 0, options, referenceCalls = 0;
  const engine = {
    memory: {buffer: new ArrayBuffer(65536)}, abi_version: () => 1,
    deep_set_options: value => { options = value; },
    deep_allocate: () => { ++allocations; return 1; }, deep_begin: () => 1,
    deep_reference: () => {
      ++referenceCalls;
      const bytes = new DataView(engine.memory.buffer);
      bytes.setUint32(0, 2, true);
      for (let index = 0; index <= 2; ++index) {
        const offset = 232 + index * 24;
        bytes.setFloat64(offset, index ? 0.5 : 0, true);
        bytes.setFloat64(offset + 8, index ? -0.25 : 0, true);
        bytes.setInt32(offset + 16, index ? -1200 : 0, true);
      }
      return 1;
    },
    deep_needs_precision: () => 0, deep_data_address: () => 0, deep_data_size: () => 4096,
    deep_finish: () => { ++finishes; }
  };
  const worker = runWorker('web/reference-worker.js', engine);
  async function settle() {
    for (let turn = 0; turn < 40; ++turn) {
      while (worker.tasks.length) worker.tasks.shift()();
      await Promise.resolve();
    }
  }
  const view = {bits: 1760, real: '1', imag: '2', iterations: 4096, mantissa: 1, exponent: -1600};
  const prepare = (generation, changes = {}, width = 100) => worker.send({type: 'prepare', generation,
    view: {...view, ...changes}, width, height: 100});
  prepare(1); await settle();
  const first = worker.messages[0];
  requireWorker(first?.type === 'reference' && !first.cacheHit && first.attempts === 2, 'Reference was not validated twice');
  requireWorker(first.orbitSnapshotBytes === 72 && first.referenceBytes === 4096 && options === 7,
    'Reference comparison copied more than the required orbit');
  prepare(2); await settle();
  requireWorker(worker.messages[1]?.cacheHit && allocations === 2 && finishes === 1, 'Identical reference was not reused');
  prepare(3, {}, 50); await settle();
  requireWorker(worker.messages[2]?.cacheHit && allocations === 2, 'Contained radius was not reused');
  prepare(4, {}, 200); await settle();
  requireWorker(!worker.messages[3]?.cacheHit && allocations === 4, 'Larger radius reused unsafe BLA bounds');
  prepare(5, {real: '3'});
  worker.send({type: 'cancel'});
  prepare(6, {real: '4'});
  prepare(7, {real: '5'});
  await settle();
  const generations = worker.messages.map(message => message.generation);
  requireWorker(!generations.includes(5) && !generations.includes(6) && generations.includes(7),
    'Canceled or superseded reference request was published');
  requireWorker(worker.messages.every(message => message.type === 'reference'), JSON.stringify(worker.messages));
  requireWorker(referenceCalls >= 7, 'Reference cancellation test did not execute meaningful work');
  const failed = runWorker('web/reference-worker.js', {...engine, abi_version: () => 2});
  failed.send({type: 'prepare', generation: 99, view, width: 100, height: 100});
  await Promise.resolve();
  await Promise.resolve();
  requireWorker(failed.messages.some(message => message.type === 'error' && message.generation === 99),
    'Reference initialization error was not attached to the requesting generation');
  report('Worker configuration, precision hints/resume, statistics, compact reference validation, safe cache bounds and cancellation passed.');
  testDone = true;
})().catch(error => { report(String(error.stack || error)); });
