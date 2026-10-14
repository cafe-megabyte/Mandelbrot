const sizes = [[1,1],[1,129],[129,1],[31,29],[257,65],[513,129],[320,180]];
for (const variant of ['scalar','simd']) {
  const bytes = new Uint8Array(readBytes(`build/internal/wasm/engine-${variant}.wasm`));
  const module = new WebAssembly.Module(bytes);
  if (WebAssembly.Module.imports(module).length) throw new Error('Unexpected WASM import');
  const e = new WebAssembly.Instance(module, {}).exports;
  for (const [w,h] of sizes) {
    const expected = readBytes(`build/internal/tests/reference-${w}-${h}.rgba`);
    if (!expected || expected.length !== w*h*4) throw new Error('Missing reference');
    e.configure(w,h);
    let checked = 0;
    for (let y=0; y<h; y+=64) for (let x=0; x<w; x+=256) {
      const tw=Math.min(256,w-x), th=Math.min(64,h-y), length=e.render_tile(x,y,tw,th);
      if (length !== tw*th*4) throw new Error('Wrong tile length');
      const actual = new Uint8Array(e.memory.buffer,e.output_address(),length);
      for (let row=0; row<th; ++row) for (let col=0; col<tw*4; ++col) {
        const offset=((y+row)*w+x)*4+col;
        if (actual[row*tw*4+col] !== expected[offset]) throw new Error(`${variant} ${w}x${h} byte ${offset} differs`);
        ++checked;
      }
    }
    if (checked !== w*h*4) throw new Error('Incomplete pixel coverage');
  }
  for (const [w,h,x,y] of [[3840,2160,2440,384],[7680,4320,4880,800],[7680,4320,3800,2000]]) {
    const expected=readBytes(`build/internal/tests/tile-${w}-${h}-${x}-${y}.rgba`);
    e.configure(w,h);const length=e.render_tile(x,y,256,64);
    const actual=new Uint8Array(e.memory.buffer,e.output_address(),length);
    if(!expected || expected.length!==length)throw new Error('Missing boundary reference');
    for(let i=0;i<length;++i)if(actual[i]!==expected[i])throw new Error(`${variant}: high-resolution boundary differs at ${i}`);
  }
  report(`${variant}: seven full images and three 4K/8K boundary tiles match the independent native orbit byte for byte.`);
}
var testDone = true;
