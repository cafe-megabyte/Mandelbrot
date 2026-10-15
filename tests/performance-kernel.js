// Run after saving the old build under build/internal/performance/before/:
// build/internal/host-tools/js-runner build/internal/wasm/engine-simd.wasm tests/performance-kernel.js
// This measures JavaScriptCore, NOT browser frame latency. No DOM, workers or PNG.
const {createView,writeCentre}=new Function(readText('web/view.js').replace(/^export /gm,'')+'\nreturn {createView,writeCentre};')();
const override=readText('build/internal/performance/kernel-options.json');
const options=override?JSON.parse(override):{};
const now=typeof benchmarkNow==='function'?benchmarkNow:()=>Date.now();
const flags=options.flags||[0,11,15,27,43,75,139,267,299,511];
const variants=['before',...flags.map(n=>'flags'+n)], engines={}, records=[];
let passed=true;
for(const name of variants){
  const path=name==='before'?'build/internal/performance/before/engine-simd.wasm':'build/internal/wasm/engine-simd.wasm';
  const bytes=readBytes(path);if(!bytes)throw Error('Missing snapshot: '+path);
  engines[name]=new WebAssembly.Instance(new WebAssembly.Module(new Uint8Array(bytes)),{}).exports;
  if(name!=='before')engines[name].deep_set_options(+name.slice(5));
}
const fixtures=[
  {name:'cusp-18',real:'0.25',imag:'0',zoom:18,width:1024,height:768},
  {name:'interior-40',real:'0',imag:'0',zoom:40,width:1024,height:768},
  {name:'seahorse-24',real:'-0.743643887037151',imag:'0.13182590420533',zoom:24,width:256,height:128},
  {name:'preperiodic-40',real:'0',imag:'1',zoom:40,width:1024,height:768},
  {name:'preperiodic-400',real:'0',imag:'1',zoom:400,width:512,height:320},
  {name:'boundary-400',real:'-2',imag:'0',zoom:400,width:257,height:129},
  {name:'preperiodic-1600',real:'0',imag:'1',zoom:1600,width:33,height:17}
];
function configure(e,v,w,h){
  let bits=Math.max(v.bits,Math.ceil((-2*v.exponent+192)/32)*32);
  for(;;){if(!e.deep_allocate(bits,v.iterations))throw Error('Allocation');writeCentre(e,v);
    if(v.perturb){e.deep_begin(BigInt(v.real)<0n?-1:1,BigInt(v.imag)<0n?-1:1,v.mantissa,v.exponent,w,h);
      while(!e.deep_reference(128)){}if(e.deep_needs_precision()){bits+=64;continue;}e.deep_finish();}
    e.deep_configure(w,h,v.mantissa,v.exponent,v.iterations,BigInt(v.real)<0n?-1:1,BigInt(v.imag)<0n?-1:1);return;}
}
const median=a=>[...a].sort((a,b)=>a-b)[Math.floor(a.length/2)];
for(const f of fixtures.filter(f=>!options.only||options.only.includes(f.name))){
  const w=33,h=17,v=createView();v.set(f);const view=v.snapshot(f.width,f.height);
  if(f.zoom>=400)view.iterations=Math.min(view.iterations,4096);
  const x=Math.floor((f.width-w)/2),y=Math.floor((f.height-h)/2),times={},setup={},pixels={},stats={};
  for(const name of variants){const t=now();configure(engines[name],view,f.width,f.height);setup[name]=now()-t;times[name]=[];}
  for(let repeat=0;repeat<7;repeat++)for(const name of repeat%2?[...variants].reverse():variants){
    const e=engines[name],image=new Uint8Array(w*h*4),t=now();
    if(e.deep_render_tile(x,y,w,h)!==image.length)throw Error('Unsettled '+f.name+' '+name);
    image.set(new Uint8Array(e.memory.buffer,e.output_address(),image.length));
    if(repeat>=2)times[name].push(now()-t);pixels[name]=image;
    stats[name]={skipped:e.deep_stat_skipped(),fallbacks:e.deep_stat_fallbacks(),
      ddFallbacks:e.deep_stat_dd_fallbacks?.(),fixedIterations:e.deep_stat_fixed_iterations?.(),
      ddIterations:e.deep_stat_dd_iterations?.(),localReferences:e.deep_stat_local_references?.(),
      referenceBytes:e.deep_data_size(),memoryBytes:e.memory.buffer.byteLength};
  }
  const comparisons={};
  for(const name of variants.slice(1)){
    let differentPixels=0,maxChannelDifference=0,membershipDifferences=0;
    for(let p=0;p<pixels.before.length;p+=4){let differs=false;for(let c=0;c<4;c++){const d=Math.abs(pixels.before[p+c]-pixels[name][p+c]);differs ||= d>0;maxChannelDifference=Math.max(maxChannelDifference,d);}differentPixels+=differs;
      const black=a=>!a[p]&&!a[p+1]&&!a[p+2];membershipDifferences+=black(pixels.before)!==black(pixels[name]);}
    comparisons[name]={differentPixels,maxChannelDifference,membershipDifferences};
    if(membershipDifferences||maxChannelDifference>1)passed=false;
  }
  const row={fixture:f.name,width:w,height:h,frameWidth:f.width,frameHeight:f.height,x,y,zoom:f.zoom,iterations:view.iterations,
    setup,times,medians:Object.fromEntries(variants.map(n=>[n,median(times[n])])),stats,comparisons};
  records.push(row);report(JSON.stringify(row));
}
const result={date:new Date().toISOString(),runtime:typeof benchmarkRuntime==='string'?benchmarkRuntime:'macOS JavaScriptCore command-line',
  clock:typeof benchmarkNow==='function'?'performance.now':'Date.now, 1ms resolution',
  method:'Two warmups, five alternating samples; 33x17 centre ROI; tile computation plus RGBA copy, reference setup excluded; zoom>=400 capped at4096 iterations',flags,passed,records};
const resultName=typeof benchmarkRuntime==='string'?'kernel-v8.json':'kernel-jsc.json';
if(!writeBytes('build/internal/performance/'+resultName,Array.from(JSON.stringify(result,null,2),c=>c.charCodeAt(0))))throw Error('Result save failed');
if(!passed)throw Error('Pixel regression: see saved benchmark comparisons');
var testDone=true;
