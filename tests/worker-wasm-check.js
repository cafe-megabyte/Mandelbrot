// Exercise the actual production worker scripts and rebuilt WASM together.
var testDone = false;
const {writeCentre, decimalFixed} = new Function(readText('web/view.js').replace(/^export /gm, '') +
  '\nreturn {writeCentre,decimalFixed};')();
const module = new WebAssembly.Module(new Uint8Array(moduleBytes));
const requireWorkerWasm = (condition, message) => { if (!condition) throw new Error(message); };
function createWorkerHarness(path) {
  const messages = [], tasks = [];
  let clock = 0;
  const self = {postMessage(message) { messages.push(message); }};
  class Channel {
    constructor() { this.port1 = {}; this.port2 = {postMessage: () => tasks.push(() => this.port1.onmessage())}; }
  }
  new Function('self', 'WebAssembly', 'writeCentre', 'performance', 'MessageChannel',
    readText(path).replace(/^import .*\n/gm, ''))
    (self, WebAssembly, writeCentre, {now: () => ++clock}, Channel);
  const send = data => self.onmessage({data});
  send({type: 'init', module});
  return {send, messages, tasks};
}
(async () => {
  const reference = createWorkerHarness('web/reference-worker.js');
  const render = createWorkerHarness('web/engine-worker.js');
  const bits = 512;
  const view = {bits, real: decimalFixed('0', bits).toString(), imag: decimalFixed('1', bits).toString(),
    iterations: 512, mantissa: 1, exponent: -400, deep: true, perturb: true};
  async function prepare(generation, width, height) {
    const previous = reference.messages.length;
    reference.send({type: 'prepare', generation, view, width, height});
    for (let turn = 0; turn < 1000 && reference.messages.length === previous; ++turn) {
      while (reference.tasks.length) reference.tasks.shift()();
      await Promise.resolve();
    }
    const result = reference.messages[reference.messages.length - 1];
    requireWorkerWasm(result?.type === 'reference' && result.generation === generation,
      `Reference worker did not finish: ${JSON.stringify(result)}`);
    return result;
  }
  function verify(data, width, height, hint) {
    render.send({...data, view});
    render.send({type: 'configure', generation: data.generation, frameWidth: width, frameHeight: height, view});
    render.send({type: 'render', generation: data.generation, x: 0, y: 0, width, height, precisionHint: hint});
    const actual = render.messages[render.messages.length - 1];
    requireWorkerWasm(actual.type === 'tile', JSON.stringify(actual));
    const engine = new WebAssembly.Instance(module, {}).exports;
    requireWorkerWasm(engine.deep_allocate(actual.precisionBits, view.iterations), 'Comparison allocation failed');
    new Uint8Array(engine.memory.buffer, engine.deep_data_address(), data.buffer.byteLength)
      .set(new Uint8Array(data.buffer));
    writeCentre(engine, view);
    requireWorkerWasm(engine.deep_configure(width, height, view.mantissa, view.exponent, view.iterations, 1, 1),
      'Comparison viewport rejected');
    const bytes = engine.deep_render_tile(0, 0, width, height);
    requireWorkerWasm(bytes === width * height * 4, 'Comparison tile did not render');
    const expected = new Uint8Array(engine.memory.buffer, engine.output_address(), bytes);
    const received = new Uint8Array(actual.buffer, 0, bytes);
    requireWorkerWasm(received.every((value, index) => value === expected[index]), 'Worker/reference protocol changed pixels');
    const expectedSkipped = engine.deep_stat_skipped();
    requireWorkerWasm(expectedSkipped > 0 && actual.skipped === expectedSkipped,
      `Imported reference disabled BLA skipping: worker ${actual.skipped}, direct ${expectedSkipped}`);
    requireWorkerWasm(actual.retainedReferenceBytes === 0 && actual.referenceBytes === data.referenceBytes,
      'Worker reference memory accounting differs');
    return actual;
  }
  const first = await prepare(1, 9, 5);
  requireWorkerWasm(!first.cacheHit && first.attempts >= 2, 'Initial real reference was not validated');
  verify(first, 9, 5, first.bits + 64);
  const cached = await prepare(2, 5, 3);
  requireWorkerWasm(cached.cacheHit, 'Real WASM reference cache did not reuse smaller bounds');
  verify(cached, 5, 3, cached.bits);
  report('Production workers + WASM: validated references, precision growth, configuration, cache bounds and pixel equality passed.');
  testDone = true;
})().catch(error => { report(String(error.stack || error)); });
