import {writeCentre} from './view.js';

let engine, initializationError, token = 0, pending, running = false, cached;
const channel = new MessageChannel(), yieldQueue = [];
channel.port1.onmessage = () => yieldQueue.shift()?.();
const yieldTask = () => new Promise(resolve => { yieldQueue.push(resolve); channel.port2.postMessage(null); });
const HEADER_BYTES = 232, SAMPLE_BYTES = 24;

function radius(view, width, height) {
  let mantissa = view.mantissa * (0.5 * (width + height) + 2), exponent = view.exponent;
  // Scaling by powers of two retains the same bound as the core's Extended
  // representation, including zooms whose radius is below Number.MIN_VALUE.
  while (mantissa >= 1) { mantissa *= 0.5; ++exponent; }
  while (mantissa > 0 && mantissa < 0.5) { mantissa *= 2; --exponent; }
  return {mantissa, exponent};
}

function contained(inner, outer) {
  return inner.exponent < outer.exponent ||
    (inner.exponent === outer.exponent && inner.mantissa <= outer.mantissa);
}

function publish(data, bits, started, details) {
  const buffer = new Uint8Array(engine.memory.buffer, engine.deep_data_address(), engine.deep_data_size()).slice().buffer;
  self.postMessage({type: 'reference', generation: data.generation, bits, buffer,
    milliseconds: performance.now() - started, memoryBytes: engine.memory.buffer.byteLength,
    referenceBytes: buffer.byteLength, retainedReferenceBytes: 0, ...details}, [buffer]);
}

async function prepare(data, id) {
  if (initializationError) throw new Error(initializationError);
  if (!engine) throw new Error('Reference worker is not initialized');
  const started = performance.now(), view = data.view;
  const minimumBits = Math.max(view.bits, Math.ceil((-2 * view.exponent + 192) / 32) * 32);
  const key = JSON.stringify([view.real, view.imag, view.bits, view.iterations]);
  const requestedRadius = radius(view, data.width, data.height);
  // Orbit and BLA data stay in WASM. A smaller footprint can safely use the
  // previous conservative radius; a larger footprint must rebuild its bounds.
  if (cached?.key === key && cached.bits >= minimumBits + 32 && contained(requestedRadius, cached.radius)) {
    publish(data, cached.bits, started, {cacheHit: true, attempts: 0, orbitSnapshotBytes: 0});
    return;
  }
  cached = null;
  let previous, attempt = 0, orbitSnapshotBytes = 0;
  for (;;) {
    if (id !== token) return;
    const bits = minimumBits + 32 * attempt;
    if (!engine.deep_allocate(bits, view.iterations)) throw new Error('Deep zoom memory exhausted');
    writeCentre(engine, view);
    engine.deep_begin(BigInt(view.real) < 0n ? -1 : 1, BigInt(view.imag) < 0n ? -1 : 1,
      view.mantissa, view.exponent, data.width, data.height);
    let done = false;
    while (!done) {
      done = engine.deep_reference(128);
      await yieldTask();
      if (id !== token) return;
    }
    if (engine.deep_needs_precision()) { previous = null; ++attempt; continue; }
    const address = engine.deep_data_address();
    const count = new DataView(engine.memory.buffer, address, HEADER_BYTES).getUint32(0, true);
    const current = new DataView(engine.memory.buffer, address + HEADER_BYTES, (count + 1) * SAMPLE_BYTES);
    // Compare every reference sample at two precisions, including tiny nonzero
    // iterates. Only the previous orbit needs a copy; margins and BLA do not.
    let stable = previous?.byteLength === current.byteLength;
    if (stable) for (let j = 0; stable && j <= count; ++j) {
      const offset = j * SAMPLE_BYTES;
      const ar = previous.getFloat64(offset, true), ai = previous.getFloat64(offset + 8, true);
      const br = current.getFloat64(offset, true), bi = current.getFloat64(offset + 8, true);
      const ae = previous.getInt32(offset + 16, true), be = current.getInt32(offset + 16, true);
      const magnitude = Math.max(Math.abs(br), Math.abs(bi));
      stable = ae === be && Math.max(Math.abs(ar - br), Math.abs(ai - bi)) <= magnitude * 2 ** -40;
    }
    if (stable) {
      engine.deep_finish();
      cached = {key, bits, radius: requestedRadius};
      publish(data, bits, started, {cacheHit: false, attempts: attempt + 1, orbitSnapshotBytes});
      return;
    }
    const snapshot = new Uint8Array(current.buffer, current.byteOffset, current.byteLength).slice();
    previous = new DataView(snapshot.buffer);
    orbitSnapshotBytes += snapshot.byteLength;
    ++attempt;
  }
}

async function drain() {
  if (running) return;
  running = true;
  try {
    while (pending) {
      const {data, id} = pending;
      pending = null;
      try { await prepare(data, id); }
      catch (error) {
        if (id === token) self.postMessage({type: 'error', generation: data.generation, message: String(error.message)});
      }
    }
  } finally { running = false; }
}

self.onmessage = ({data}) => {
  if (data.type === 'init') {
    try {
      if (WebAssembly.Module.imports(data.module).length) throw new Error('Unexpected WASM imports');
      engine = new WebAssembly.Instance(data.module, {}).exports;
      if (engine.abi_version() !== 1) throw new Error('Unsupported WASM ABI');
      if (data.engineOptions !== undefined) engine.deep_set_options(data.engineOptions);
    } catch (error) {
      initializationError = String(error.message);
      self.postMessage({type: 'error', message: initializationError});
    }
    return;
  }
  ++token;
  pending = data.type === 'prepare' ? {data, id: token} : null;
  if (pending) drain();
};
