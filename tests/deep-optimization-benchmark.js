// Optional before/after check in JavaScriptCore. Before changing the core:
//   make web
//   cp build/internal/wasm/engine-scalar.wasm build/internal/tests/engine-before-scalar.wasm
//   cp build/internal/wasm/engine-simd.wasm build/internal/tests/engine-before-simd.wasm
// After rebuilding, run with build/internal/host-tools/js-runner and the current
// engine-simd.wasm as its first argument. This script is the second argument.
// Tile timings cap the iteration budget at 4096; they are not full-frame timings.
const {createView,writeCentre}=new Function(readText('web/view.js').replace(/^export /gm,'')+'\nreturn {createView,writeCentre};')();
const results=[];
function engine(path){
  const bytes=readBytes(path);if(!bytes)throw new Error(`Missing benchmark snapshot: ${path}`);
  return new WebAssembly.Instance(new WebAssembly.Module(new Uint8Array(bytes)),{}).exports;
}
function configure(e,view,w,h){
  const bits=Math.max(view.bits,Math.ceil((-2*view.exponent+192)/32)*32);
  if(!e.deep_allocate(bits,view.iterations))throw new Error('Allocation failed');writeCentre(e,view);
  if(view.perturb){e.deep_begin(BigInt(view.real)<0n?-1:1,BigInt(view.imag)<0n?-1:1,view.mantissa,view.exponent,w,h);
    while(!e.deep_reference(128)){}if(e.deep_needs_precision())throw new Error('Reference needs precision');e.deep_finish();}
  e.deep_configure(w,h,view.mantissa,view.exponent,view.iterations,BigInt(view.real)<0n?-1:1,BigInt(view.imag)<0n?-1:1);
}
for(const variant of ['scalar','simd']){
  const old=engine(`build/internal/tests/engine-before-${variant}.wasm`),next=engine(`build/internal/wasm/engine-${variant}.wasm`);
  for(const fixture of [
    {name:'seahorse',real:'-0.743643887037151',imag:'0.13182590420533',zoom:24},
    {name:'preperiodic intermediate',real:'0',imag:'1',zoom:40},
    {name:'preperiodic deep',real:'0',imag:'1',zoom:400},
    {name:'real-axis boundary',real:'-2',imag:'0',zoom:400},
    {name:'extended exponent',real:'0',imag:'1',zoom:1600}
  ]){
    const w=33,h=17,v=createView();v.set(fixture);const view=v.snapshot(w,h);view.iterations=Math.min(4096,view.iterations);
    configure(old,view,w,h);configure(next,view,w,h);
    let pixels=0,skipped=0,fallbacks=0;
    for(let y=0;y<h;y+=64){const height=Math.min(64,h-y);
      for(const e of [old,next])if(e.deep_render_tile(0,y,w,height)!==w*height*4)throw new Error('Tile needs precision');
      const a=new Uint8Array(old.memory.buffer,old.output_address(),w*height*4),b=new Uint8Array(next.memory.buffer,next.output_address(),w*height*4);
      for(let j=0;j<a.length;++j)if(a[j]!==b[j])throw new Error(`${variant} ${fixture.name} differs at byte ${j}`);
      pixels+=w*height;skipped+=next.deep_stat_skipped();fallbacks+=next.deep_stat_fallbacks();
    }
    const times={before:[],after:[]};
    // Alternate order to reduce warm-up and drift bias. Report medians of five
    // batches; reference/BLA preparation is deliberately outside these timings.
    for(let repeat=0;repeat<6;++repeat){
      const order=repeat%2?[['before',old],['after',next]]:[['after',next],['before',old]];
      for(const [name,e]of order){const start=Date.now();
        for(let y=0;y<h;y+=64)
          if(!e.deep_render_tile(0,y,w,Math.min(64,h-y)))throw new Error('Render failed');
        if(repeat)times[name].push(Date.now()-start);
      }
    }
    const median=a=>[...a].sort((a,b)=>a-b)[2];
    const row={variant,view:fixture.name,zoom:fixture.zoom,width:w,height:h,iterations:view.iterations,pixelsCompared:pixels,
      identical:true,skippedIterations:skipped,preciseFallbacks:fallbacks,beforeMilliseconds:median(times.before),afterMilliseconds:median(times.after),samples:times};
    results.push(row);report(JSON.stringify(row));
  }
}
writeBytes('build/internal/tests/deep-optimization-benchmark.json',Array.from(JSON.stringify(results,null,2),c=>c.charCodeAt(0)));
var testDone=true;
