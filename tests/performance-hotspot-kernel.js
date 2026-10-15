// Optional diagnostic: node tests/performance-node.mjs tests/performance-hotspot-kernel.js
// Requires the pre-fix WASM snapshot used by performance-hotspot.mjs.
const {createView,writeCentre}=new Function(readText('web/view.js').replace(/^export /gm,'')+'\nreturn {createView,writeCentre};')();
const region={real:'0.250013003831570161123649567576785672333439247694286677869968116283416748046875',imag:'-0.0000000862687817968713428902967184298995750868499499119934625923633575439453125',zoom:24,width:3840,height:2160};
const v=createView();v.set(region);const view=v.snapshot(region.width,region.height);
const variants=['before','after'],engines={},records=[];
for(const name of variants){
 const path=name==='before'?'build/internal/cusp24/before/engine-simd.wasm':'build/internal/wasm/engine-simd.wasm';
 const e=new WebAssembly.Instance(new WebAssembly.Module(new Uint8Array(readBytes(path))),{}).exports;
 const bits=Math.max(view.bits,Math.ceil((-2*view.exponent+192)/32)*32);
 if(!e.deep_allocate(bits,view.iterations))throw Error('Allocation');writeCentre(e,view);
 e.deep_configure(region.width,region.height,view.mantissa,view.exponent,view.iterations,1,-1);engines[name]=e;
 for(let warmup=0;warmup<40;warmup++)e.deep_render_tile(0,0,16,8);
}
const counterNames=['skipped','fallbacks','dd_fallbacks','dd_iterations','fixed_iterations','reference_iterations','local_references','perturb_iterations'];
const fixtures=[{name:'escaping-top',x:1912,y:0},{name:'transition-left',x:956,y:1076},{name:'transition-centre',x:1912,y:1076},{name:'cardioid-interior',x:1912,y:1614},{name:'cardioid-bottom',x:1912,y:2152}];
const median=a=>[...a].sort((a,b)=>a-b)[Math.floor(a.length/2)];
let passed=true;
for(const f of fixtures){
 const w=16,h=8,times={before:[],after:[]},stats={},pixels={};let comparedPixels=0,differentPixels=0,maxChannelDifference=0;
 for(let round=0;round<7;round++){
  for(const name of round%2?[...variants].reverse():variants){
   const e=engines[name],dst=new Uint8Array(w*h*4),start=benchmarkNow();
   if(e.deep_render_tile(f.x,f.y,w,h)!==dst.length)throw Error('Unsettled');
   dst.set(new Uint8Array(e.memory.buffer,e.output_address(),dst.length));
   if(round>=2)times[name].push(benchmarkNow()-start);
   stats[name]=Object.fromEntries(counterNames.map(n=>[n,e['deep_stat_'+n]()]));pixels[name]=dst;
  }
  for(let p=0;p<pixels.before.length;p+=4){let differs=false;for(let c=0;c<4;c++){const d=Math.abs(pixels.before[p+c]-pixels.after[p+c]);differs||=d>0;maxChannelDifference=Math.max(maxChannelDifference,d);}differentPixels+=differs;++comparedPixels;}
 }
 if(differentPixels)passed=false;
 const row={...f,width:w,height:h,times,mediansMs:Object.fromEntries(variants.map(n=>[n,median(times[n])])),stats,comparedPixels,differentPixels,maxChannelDifference};records.push(row);report(JSON.stringify(row));
}
const result={region,view,runtime:benchmarkRuntime,method:'40 small escaping warmup tiles per engine, then two warmups and five alternating samples per region/variant; identical 16x8 regions at actual 4K pixel spacing. Tile computation, local reference setup and RGBA copy included. Every output compared exactly.',passed,records};
writeBytes('build/internal/cusp24/kernel.json',Array.from(JSON.stringify(result,null,2),c=>c.charCodeAt(0)));
if(!passed)throw Error('Pixel mismatch');
var testDone=true;
