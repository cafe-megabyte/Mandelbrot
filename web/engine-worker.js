let engine;
let configuredGeneration = -1;
self.onmessage = ({data}) => {
  try {
    if (data.type === 'init') {
      if (WebAssembly.Module.imports(data.module).length) throw new Error('Unexpected WASM imports');
      engine = new WebAssembly.Instance(data.module, {}).exports;
      if (engine.abi_version() !== 1 || engine.tile_width() !== 256 || engine.tile_height() !== 64)
        throw new Error('Unsupported WASM ABI');
      self.postMessage({type: 'ready'});
      return;
    }
    if (data.type !== 'render' || !engine) return;
    if (configuredGeneration !== data.generation) {
      if (!engine.configure(data.frameWidth, data.frameHeight)) throw new Error('Invalid viewport');
      configuredGeneration = data.generation;
    }
    const bytes = engine.render_tile(data.x, data.y, data.width, data.height);
    if (!bytes) throw new Error('Invalid render tile');
    const buffer = data.buffer || new ArrayBuffer(256 * 64 * 4);
    new Uint8Array(buffer, 0, bytes).set(new Uint8Array(engine.memory.buffer, engine.output_address(), bytes));
    self.postMessage({type: 'tile', generation: data.generation, x: data.x, y: data.y,
      width: data.width, height: data.height, buffer}, [buffer]);
  } catch (error) {
    self.postMessage({type: 'error', message: String(error.message)});
  }
};
