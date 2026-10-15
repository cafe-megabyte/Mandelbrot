// Explicit retained allocations, not browser RSS, GC high-water or peak usage.
// Use the same js-runner and baseline snapshot as performance-kernel.js.
const {createView}=new Function(readText('web/view.js').replace(/^export /gm,'')+'\nreturn {createView};')();
const results=[];
for(const zoom of [400,1600]){
  const v=createView();v.set({real:'0',imag:'1',zoom});const view=v.snapshot(3840,2160);
  const bits=Math.max(view.bits,Math.ceil((-2*view.exponent+192)/32)*32)+32;
  const allocations={};
  for(const variant of ['before','after']){
    const path=variant==='before'?'build/internal/performance/before/engine-simd.wasm':'build/internal/wasm/engine-simd.wasm';
    const e=new WebAssembly.Instance(new WebAssembly.Module(new Uint8Array(readBytes(path))),{}).exports;
    if(!e.deep_allocate(bits,view.iterations))throw Error('Allocation');
    allocations[variant]={referenceBytes:e.deep_data_size(),wasmMemoryBytes:e.memory.buffer.byteLength};
  }
  const before=8*allocations.before.wasmMemoryBytes+9*allocations.before.referenceBytes+8*65536;
  const after=9*allocations.after.wasmMemoryBytes+16*65536;
  results.push({zoom,frameWidth:3840,frameHeight:2160,iterations:view.iterations,precisionBits:bits,workers:8,allocations,
    steadyReferencePayloadCopies:{before:17,after:9},
    steadyWorkersReferencesAndTransferBytes:{before,after,saved:before-after},
    excludes:'Canvas/decoded images, export, engine overhead outside linear memory, transient structured clones, validation snapshots, process RSS; assumes settled frame and completed reference cache. Fresh allocation at the reported precision; actual workers can retain larger memory from previous views or require additional precision.'});
}
for(const [width,height]of [[3840,2160],[7680,4320]]){
  const strips=Math.ceil(height/32),transfer=width*4*Math.min(32,height),filter=(width*4+1)*Math.min(32,height);
  const before=height*(width*8+1),after=transfer+filter;
  results.push({width,height,strips,kind:'PNG transfer and filter allocation volume',beforeBytes:before,afterBytes:after,savedBytes:before-after,
    transferBufferAllocations:{before:strips,after:1},filterBufferAllocations:{before:strips,after:1},
    unchangedReadbackBytes:width*height*4,note:'Allocation volume, not simultaneous peak. Encoded PNG chunks and compressed-payload copy removal excluded.'});
}
const result={date:new Date().toISOString(),method:'WASM memory byteLength/deep_data_size from real allocations plus source-verified ownership counts; PNG strip arithmetic',records:results};
report(JSON.stringify(result,null,2));
if(!writeBytes('build/internal/performance/memory.json',Array.from(JSON.stringify(result,null,2),c=>c.charCodeAt(0))))throw Error('Save failed');
var testDone=true;
