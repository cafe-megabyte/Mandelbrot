// Optional Node/V8 4K renderer, independent of browser workers/canvas/PNG.
// node tests/performance-hotspot.mjs before|after [fixed|adaptive|compact] [cusp24|cusp32|cusp38|branch29]
// Optional arguments after preset: flags, output-label, wasm-path, minimum-pixels.
// Save the starting WASM as build/internal/cusp24/before/engine-simd.wasm first.
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {Worker,isMainThread,parentPort,workerData} from 'node:worker_threads';
import {performance} from 'node:perf_hooks';
import {createHash} from 'node:crypto';
const viewSource=readFileSync('web/view.js','utf8').replace(/^export /gm,'');
const {createView,writeCentre,renderBands}=new Function(viewSource+'\nreturn {createView,writeCentre,renderBands};')();
const regions={branch29:{"real": "-0.6371691916298639708578389897549417222078705562264555606333260584506206214427947998046875", "imag": "0.3787904817879933184372663067875681372972409242938507389908409095369279384613037109375", "zoom": 29.19252319335936, "width": 3840, "height": 2160},cusp24:{real:'0.250013003831570161123649567576785672333439247694286677869968116283416748046875',imag:'-0.0000000862687817968713428902967184298995750868499499119934625923633575439453125',zoom:24,width:3840,height:2160},cusp32:{real:'0.25001303030608202512367228146490787920114208693622703805203855154104530811309814453125',imag:'-0.0000000749182661172659014323139709291501879399356733646442307872348465025424957275390625',zoom:32.397396240234315,width:3840,height:2160},cusp38:{"real": "0.2500130302909066233189455074779471041381893800707269907845908818444513599388301372528076171875", "imag": "-0.000000075132663698447208529708670575067558725977190196843036318341546575538814067840576171875", "zoom": 38.170528564453065, "width": 3840, "height": 2160}};
const preset=isMainThread?(process.argv[4]||'cusp24'):workerData.preset;
if(!regions[preset])throw Error('Expected cusp24|cusp32|cusp38|branch29');
const region=regions[preset];
const counterNames=['skipped','fallbacks','dd_fallbacks','dd_iterations','fixed_iterations','reference_iterations','local_references','perturb_iterations','certified_pixels','certificate_iterations','retries','preserved_pixels'];
function countCardioidPixels(view){
 if(preset==='branch29')return null;
 // In this particular narrow region the cardioid begins below one boundary
 // per column. Evaluate that boundary with an exact integer polynomial.
 const d=new DataView(new ArrayBuffer(8));d.setFloat64(0,view.mantissa);
 const word=d.getBigUint64(0),mantissa=(word&((1n<<52n)-1n))|(1n<<52n);
 const scale=mantissa<<BigInt(view.bits+view.exponent+Number((word>>52n)&2047n)-1023-52);
 const one=1n<<BigInt(view.bits),cr=BigInt(view.real),ci=BigInt(view.imag);
 const inside=(px,py)=>{
  const x=cr+BigInt(2*px+1-region.width)*scale/2n-one/4n;
  const y=ci+BigInt(region.height-2*py-1)*scale/2n,yy=y*y,q=x*x+yy;
  return 4n*q*(q+x*one)<yy*one*one;
 };
 let pixels=0,firstRow=region.height,lastRow=0;
 for(let x=0;x<region.width;x++){
  let low=0,high=region.height;
  while(low<high){const m=(low+high)>>1;if(inside(x,m))high=m;else low=m+1;}
  pixels+=region.height-low;firstRow=Math.min(firstRow,low);lastRow=Math.max(lastRow,low);
 }
 return {pixels,percentage:100*pixels/(region.width*region.height),firstInteriorRowRange:[firstRow,lastRow]};
}
if(!isMainThread){
 const e=new WebAssembly.Instance(workerData.module,{}).exports;
 if(workerData.flags!==undefined)e.deep_set_options(workerData.flags);
 const v=createView();v.set(region);const view=v.snapshot(region.width,region.height);
 let bits=Math.max(view.bits,Math.ceil((-2*view.exponent+192)/32)*32);
 if(!e.deep_allocate(bits,view.iterations))throw Error('Allocation');writeCentre(e,view);
 e.deep_configure(region.width,region.height,view.mantissa,view.exponent,view.iterations,BigInt(view.real)<0n?-1:1,BigInt(view.imag)<0n?-1:1);
 // Warm a small, escaping part of this same numerical grid before the clock.
 for(let n=0;n<20;n++)e.deep_render_tile(0,0,16,8);
 const image=new Uint8Array(workerData.image);
 parentPort.on('message',job=>{
  const {x,y,width,height}=job,start=performance.now();
  if(job.precisionHint>bits){bits=job.precisionHint;if(!e.deep_grow_precision(bits))throw Error('Precision growth failed');}
  const stats=Object.fromEntries(counterNames.map(n=>[n,0]));let bytes;
  for(;;){
   bytes=(stats.retries?e.deep_render_tile_resume:e.deep_render_tile)(x,y,width,height);
   for(const name of counterNames)stats[name]+=e['deep_stat_'+name]?.()||0;
   if(bytes||!e.deep_needs_precision())break;
   ++stats.retries;stats.preserved_pixels=e.deep_tile_completed_pixels();bits+=64;
   if(!e.deep_grow_precision(bits))throw Error('Precision growth failed');
  }
  if(bytes!==width*height*4)throw Error('Unsettled tile: '+JSON.stringify(job));
  const computeMs=performance.now()-start;
  const src=new Uint8Array(e.memory.buffer,e.output_address(),width*height*4);
  for(let row=0;row<height;row++)image.set(src.subarray(row*width*4,(row+1)*width*4),((y+row)*region.width+x)*4);
  parentPort.postMessage({computeMs,pixels:width*height,stats,bits,tile:{x,y,width,height}});
 });
 parentPort.postMessage({ready:true});
}else{
 const variant=process.argv[2]||'before',mode=process.argv[3]||'fixed';
 if(!['before','after'].includes(variant)||!['fixed','adaptive','compact'].includes(mode))throw Error('Expected before|after fixed|adaptive|compact');
 mkdirSync(`build/internal/${preset}`,{recursive:true});
 const flags=process.argv[5]===undefined?undefined:Number(process.argv[5]);
 if(flags!==undefined&&(!Number.isSafeInteger(flags)||flags<0))throw Error('Invalid flags');
 const label=process.argv[6]||variant;
 if(!/^[a-z0-9-]+$/.test(label))throw Error('Invalid output label');
 const wasmPath=process.argv[7]||(variant==='before'?`build/internal/${preset}/before/engine-simd.wasm`:'build/internal/wasm/engine-simd.wasm');
 const wasm=readFileSync(wasmPath),module=new WebAssembly.Module(wasm),image=new SharedArrayBuffer(region.width*region.height*4);
 const v=createView();v.set(region);const view=v.snapshot(region.width,region.height);
 const queueSource=readFileSync('web/tile-queue.js','utf8').replace(/^import .*$/gm,'').replace(/^export /gm,'');
 const {createTileQueue}=new Function('renderBands',queueSource+'\nreturn {createTileQueue};')(renderBands);
 const minPixels=Number(process.argv[8]||1);
 if(!Number.isSafeInteger(minPixels)||minPixels<1)throw Error('Invalid minimum pixels');
 const queue=createTileQueue(region.width,region.height,view,{adaptive:mode!=='fixed',compact:mode==='compact',minPixels});
 const stats=Object.fromEntries(counterNames.map(n=>[n,0])),tiles=[];
 const count=8,workers=[],ready=[],done=[];let completed=0,lastReport=0,start;
 let precisionBits=Math.max(view.bits,Math.ceil((-2*view.exponent+192)/32)*32);
 for(let n=0;n<count;n++){
  const worker=new Worker(new URL(import.meta.url),{workerData:{module,image,preset,flags}});workers.push(worker);
  ready.push(new Promise((resolve,reject)=>{worker.once('error',reject);worker.once('message',resolve);}));
 }
 await Promise.all(ready);
 for(const worker of workers)done.push(new Promise((resolve,reject)=>{
  worker.once('error',reject);
  const dispatch=()=>{const job=queue.take();if(job)worker.postMessage({...job,precisionHint:precisionBits});else resolve();};
  worker.on('message',row=>{
   precisionBits=Math.max(precisionBits,row.bits);completed+=row.pixels;queue.observe(row.computeMs,row.pixels);tiles.push(row);
   for(const key of counterNames)stats[key]+=row.stats[key];
   const elapsed=performance.now()-start;
   if(elapsed-lastReport>10000){lastReport=elapsed;console.log(JSON.stringify({variant,mode,seconds:elapsed/1000,percent:100*completed/(region.width*region.height),tiles:tiles.length,queuedTotal:queue.total}));}
   dispatch();
  });
  worker.dispatch=dispatch;
 }));
 start=performance.now();for(const worker of workers)worker.dispatch();await Promise.all(done);
 const wallMs=performance.now()-start;
 await Promise.all(workers.map(w=>w.terminate()));
 const rgba=Buffer.from(image),blackPixels=new Uint32Array(image).reduce((sum,p)=>sum+(p===0xff000000),0);
 const prefix=`build/internal/${preset}/full-${label}-${mode}`;
 const result={preset,region,view,runtime:`Node ${process.version}, V8 ${process.versions.v8}, ${process.platform}/${process.arch}`,workers:count,variant,mode,flags,minPixels,precisionBits,
  scope:'Full 3840x2160 WASM image with 8 Node workers, each warmed on 20 small escaping tiles. Includes tile dispatch, local references, computation and copies to a shared image. Excludes compilation, worker startup, browser/Canvas/PNG. One frame; not a statistical median.',
  wasmSha256:createHash('sha256').update(wasm).digest('hex'),wallMs,computeMs:tiles.reduce((s,t)=>s+t.computeMs,0),tileCount:tiles.length,stats,blackPixels,exactCardioid:countCardioidPixels(view),
  rgbaSha256:createHash('sha256').update(rgba).digest('hex'),tiles};
 writeFileSync(prefix+'.rgba',rgba);writeFileSync(prefix+'.json',JSON.stringify(result,null,2)+'\n');
 console.log(JSON.stringify({...result,tiles:undefined}));
}
