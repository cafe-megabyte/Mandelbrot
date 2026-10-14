import {writeCentre} from './view.js';
let engine, configuredGeneration = -1, referenceGeneration = -1, precisionBits = 0, referenceData;
self.onmessage = ({data}) => {
  try {
    if (data.type === 'init') {
      if (WebAssembly.Module.imports(data.module).length) throw new Error('Unexpected WASM imports');
      engine = new WebAssembly.Instance(data.module, {}).exports;
      if (engine.abi_version() !== 1 || engine.tile_width() !== 256 || engine.tile_height() !== 64)
        throw new Error('Unsupported WASM ABI');
      self.postMessage({type: 'ready'}); return;
    }
    if(data.type==='reference'){
      if(!engine.deep_allocate(data.bits,data.view.iterations))throw new Error('Deep zoom memory exhausted');
      precisionBits=data.bits;
      referenceData=data.buffer;
      new Uint8Array(engine.memory.buffer,engine.deep_data_address(),data.buffer.byteLength).set(new Uint8Array(data.buffer));
      writeCentre(engine,data.view);referenceGeneration=data.generation;return;
    }
    if (data.type !== 'render' || !engine) return;
    const view=data.view;
    if (configuredGeneration !== data.generation) {
      let valid;
      if(!view)valid=engine.configure(data.frameWidth,data.frameHeight);
      else if(view.deep){
        if(view.perturb && referenceGeneration!==data.generation)throw new Error('Missing deep zoom reference');
        if(!view.perturb){
          precisionBits=Math.max(view.bits,Math.ceil((-2*view.exponent+192)/32)*32);
          if(!engine.deep_allocate(precisionBits,view.iterations))throw new Error('Deep zoom memory exhausted');
          writeCentre(engine,view);
        }
        valid=engine.deep_configure(data.frameWidth,data.frameHeight,view.mantissa,view.exponent,view.iterations,
          BigInt(view.real)<0n?-1:1,BigInt(view.imag)<0n?-1:1);
      }else valid=engine.configure_view(data.frameWidth,data.frameHeight,view.centreReal,view.centreImag,
        view.mantissa*2**view.exponent,view.iterations);
      if(!valid)throw new Error('Invalid viewport');
      configuredGeneration = data.generation;
    }
    let bytes = view?.deep?engine.deep_render_tile(data.x,data.y,data.width,data.height):
      engine.render_tile(data.x, data.y, data.width, data.height);
    while(view?.deep && !bytes && engine.deep_needs_precision()){
      precisionBits+=64;
      if(!engine.deep_allocate(precisionBits,view.iterations))throw new Error('Deep zoom memory exhausted');
      if(view.perturb)new Uint8Array(engine.memory.buffer,engine.deep_data_address(),referenceData.byteLength).set(new Uint8Array(referenceData));
      writeCentre(engine,view);
      engine.deep_configure(data.frameWidth,data.frameHeight,view.mantissa,view.exponent,view.iterations,
        BigInt(view.real)<0n?-1:1,BigInt(view.imag)<0n?-1:1);
      bytes=engine.deep_render_tile(data.x,data.y,data.width,data.height);
    }
    if (!bytes) throw new Error('Invalid render tile');
    const buffer = data.buffer || new ArrayBuffer(256 * 64 * 4);
    new Uint8Array(buffer, 0, bytes).set(new Uint8Array(engine.memory.buffer, engine.output_address(), bytes));
    self.postMessage({type: 'tile', generation: data.generation, x: data.x, y: data.y,
      width: data.width, height: data.height, buffer, skipped:view?.deep?engine.deep_stat_skipped():0,
      fallbacks:view?.deep?engine.deep_stat_fallbacks():0}, [buffer]);
  } catch (error) { self.postMessage({type: 'error', message: String(error.message)}); }
};
