import {writeCentre} from './view.js';

let engine, configuration, configuredGeneration = -1, referenceGeneration = -1, precisionBits = 0;
const statExports = {
  skipped: 'deep_stat_skipped', fallbacks: 'deep_stat_fallbacks',
  ddFallbacks: 'deep_stat_dd_fallbacks', fixedIterations: 'deep_stat_fixed_iterations',
  ddIterations: 'deep_stat_dd_iterations', referenceIterations: 'deep_stat_reference_iterations',
  localReferences: 'deep_stat_local_references', perturbIterations: 'deep_stat_perturb_iterations',
  // Certificates cover the selected iteration limit, not set membership.
  certifiedPixels: 'deep_stat_certified_pixels', certificateIterations: 'deep_stat_certificate_iterations'
};

function requestedPrecision(value) {
  if (value === undefined) return 0;
  if (!Number.isSafeInteger(value) || value < 0 || value > 0x7fffffbf)
    throw new Error('Invalid precision hint');
  return Math.ceil(value / 32) * 32;
}

function growPrecision(bits) {
  if (bits <= precisionBits) return;
  // The core retains the reference, frame centre and completed output pixels.
  // Keeping a second reference-sized JavaScript buffer is unnecessary.
  if (!engine.deep_grow_precision(bits)) throw new Error('Deep zoom memory exhausted');
  precisionBits = bits;
}

function configure(data) {
  if (configuredGeneration === data.generation) return;
  if (configuration?.generation !== data.generation) {
    if (!data.frameWidth || !data.frameHeight) throw new Error('Missing viewport configuration');
    configuration = data; // Also accept the original self-contained render jobs.
  }
  const {view, frameWidth, frameHeight} = configuration;
  let valid;
  if (!view) valid = engine.configure(frameWidth, frameHeight);
  else if (view.deep) {
    if (view.perturb && referenceGeneration !== data.generation) throw new Error('Missing deep zoom reference');
    if (!view.perturb) {
      precisionBits = Math.max(view.bits, Math.ceil((-2 * view.exponent + 192) / 32) * 32,
        requestedPrecision(configuration.precisionHint), requestedPrecision(data.precisionHint));
      if (!engine.deep_allocate(precisionBits, view.iterations)) throw new Error('Deep zoom memory exhausted');
      writeCentre(engine, view);
    }
    valid = engine.deep_configure(frameWidth, frameHeight, view.mantissa, view.exponent, view.iterations,
      BigInt(view.real) < 0n ? -1 : 1, BigInt(view.imag) < 0n ? -1 : 1);
  } else valid = engine.configure_view(frameWidth, frameHeight, view.centreReal, view.centreImag,
    view.mantissa * 2 ** view.exponent, view.iterations);
  if (!valid) throw new Error('Invalid viewport');
  configuredGeneration = data.generation;
}

self.onmessage = ({data}) => {
  try {
    if (data.type === 'init') {
      if (WebAssembly.Module.imports(data.module).length) throw new Error('Unexpected WASM imports');
      engine = new WebAssembly.Instance(data.module, {}).exports;
      if (engine.abi_version() !== 1 || engine.tile_width() !== 256 || engine.tile_height() !== 64)
        throw new Error('Unsupported WASM ABI');
      if (data.engineOptions !== undefined) engine.deep_set_options(data.engineOptions);
      self.postMessage({type: 'ready'});
      return;
    }
    if (!engine) throw new Error('Render worker is not initialized');
    if (data.type === 'configure') {
      configuration = data;
      configuredGeneration = -1;
      return;
    }
    if (data.type === 'reference') {
      precisionBits = Math.max(data.bits, requestedPrecision(data.precisionHint));
      if (!engine.deep_allocate(precisionBits, data.view.iterations)) throw new Error('Deep zoom memory exhausted');
      if (data.buffer.byteLength !== engine.deep_data_size()) throw new Error('Invalid deep zoom reference size');
      new Uint8Array(engine.memory.buffer, engine.deep_data_address(), data.buffer.byteLength)
        .set(new Uint8Array(data.buffer));
      writeCentre(engine, data.view);
      referenceGeneration = data.generation;
      configuredGeneration = -1;
      return;
    }
    if (data.type !== 'render') return;
    const started = performance.now();
    configure(data);
    const view = configuration.view;
    if (view?.deep) growPrecision(Math.max(requestedPrecision(configuration.precisionHint),
      requestedPrecision(data.precisionHint)));
    const configuredAt = performance.now();
    const stats = Object.fromEntries(Object.keys(statExports).map(name => [name, 0]));
    stats.retries = stats.preservedPixels = stats.discardedPixels = 0;
    let bytes, retryMilliseconds = 0;
    for (;;) {
      const attemptStarted = performance.now();
      bytes = view?.deep ? (stats.retries ? engine.deep_render_tile_resume : engine.deep_render_tile)
        (data.x, data.y, data.width, data.height) : engine.render_tile(data.x, data.y, data.width, data.height);
      const attemptMilliseconds = performance.now() - attemptStarted;
      if (stats.retries) retryMilliseconds += attemptMilliseconds;
      if (view?.deep) for (const [name, exported] of Object.entries(statExports))
        stats[name] += engine[exported]?.() ?? 0;
      if (bytes || !view?.deep || !engine.deep_needs_precision()) break;
      stats.preservedPixels = engine.deep_tile_completed_pixels();
      ++stats.retries;
      const growthStarted = performance.now();
      growPrecision(precisionBits + 64);
      retryMilliseconds += performance.now() - growthStarted;
    }
    if (!bytes) throw new Error('Invalid render tile');
    const computedAt = performance.now();
    const buffer = data.buffer || new ArrayBuffer(256 * 64 * 4);
    new Uint8Array(buffer, 0, bytes).set(new Uint8Array(engine.memory.buffer, engine.output_address(), bytes));
    const copiedAt = performance.now();
    self.postMessage({type: 'tile', generation: data.generation, x: data.x, y: data.y,
      width: data.width, height: data.height, buffer, skipped: stats.skipped, fallbacks: stats.fallbacks,
      stats, precisionBits: view?.deep ? precisionBits : 0, memoryBytes: engine.memory.buffer.byteLength,
      referenceBytes: view?.deep ? engine.deep_data_size() : 0, retainedReferenceBytes: 0,
      timing: {configureMilliseconds: configuredAt - started, computeMilliseconds: computedAt - configuredAt,
        copyMilliseconds: copiedAt - computedAt, retryMilliseconds}}, [buffer]);
  } catch (error) {
    self.postMessage({type: 'error', generation: data.generation, message: String(error.message)});
  }
};
