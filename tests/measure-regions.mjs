// Full production-budget 4K measurements. This optional Node harness executes
// the real worker sources. Normal builds and checks still need only Apple CLT.
// node tests/measure-regions.mjs --output=build/internal/measure-current cusp32
// node tests/measure-regions.mjs --snapshot=/absolute/frozen/baseline --output=...
import {readFileSync,writeFileSync,mkdirSync,existsSync} from 'node:fs';
import {Worker,isMainThread,parentPort,workerData,MessageChannel} from 'node:worker_threads';
import {performance} from 'node:perf_hooks';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {dirname,join,resolve} from 'node:path';
import os from 'node:os';
import {gzipSync} from 'node:zlib';

const project=dirname(dirname(fileURLToPath(import.meta.url)));
const settings={},requested=[];
if(isMainThread)for(const arg of process.argv.slice(2)){
  if(arg.startsWith('--')){
    const [key,...rest]=arg.slice(2).split('=');settings[key]=rest.length?rest.join('='):true;
    if(!['output','snapshot','wasm','flags','workers','fixtures','resume','image-format'].includes(key))throw Error('Unknown measurement option: '+key);
  }else requested.push(arg);
}
let codeRoot=isMainThread?null:workerData.codeRoot;
const read=name=>readFileSync(join(codeRoot,name),'utf8');
const loadView=()=>new Function(read('web/view.js').replace(/^export /gm,'')+
  '\nreturn {createView,writeCentre,renderBands};')();

if(!isMainThread){
  const api=loadView();globalThis.MessageChannel=MessageChannel;
  globalThis.self={onmessage:null,postMessage:(data,transfer)=>parentPort.postMessage(data,transfer)};
  new Function('writeCentre',read(workerData.kind==='reference'?'web/reference-worker.js':'web/engine-worker.js')
    .replace(/^import .*$/gm,''))(api.writeCentre);
  parentPort.on('message',data=>{
    self.onmessage({data});
    if(data.type==='configure'||data.type==='reference')
      parentPort.postMessage({type:'adapter-accepted',generation:data.generation});
  });
  self.onmessage({data:{type:'init',module:workerData.module,engineOptions:workerData.flags}});
  parentPort.postMessage({type:'adapter-ready'});
}else{
  const imageFormat=settings['image-format']||'raw';
  if(!['raw','gzip','hash'].includes(imageFormat))throw Error('Invalid image format');
  const output=resolve(settings.output||join(project,'build/internal/measure-'+Date.now()));
  mkdirSync(output,{recursive:true});
  const snapshot=settings.snapshot?resolve(settings.snapshot):null;
  const sourceRoot=snapshot?join(snapshot,'source'):project;
  const wasmPath=resolve(settings.wasm||(snapshot?join(snapshot,'wasm/engine-simd.wasm'):
    join(project,'build/internal/wasm/engine-simd.wasm')));
  const wasm=readFileSync(wasmPath),hash=data=>createHash('sha256').update(data).digest('hex');
  const module=new WebAssembly.Module(wasm);
  if(WebAssembly.Module.imports(module).length)throw Error('Measurement requires import-free WASM');
  const flags=settings.flags===undefined?new WebAssembly.Instance(module,{}).exports.deep_default_options():Number(settings.flags);
  if(!Number.isSafeInteger(flags)||flags<0||flags>0x7fffffff)throw Error('Invalid engine option mask');
  const workersCount=Number(settings.workers||8);
  if(!Number.isSafeInteger(workersCount)||workersCount<1||workersCount>8)throw Error('Invalid worker count');
  const inputDirectory=join(output,'inputs');codeRoot=join(inputDirectory,'source');
  const codeFiles=['web/view.js','web/engine-worker.js','web/reference-worker.js','web/app.js','web/tile-queue.js'];
  const sourceHashes={};
  for(const name of codeFiles){
    const bytes=readFileSync(join(sourceRoot,name));sourceHashes[name]=hash(bytes);
    const target=join(codeRoot,name);mkdirSync(dirname(target),{recursive:true});
    if(existsSync(target)&&hash(readFileSync(target))!==sourceHashes[name])
      throw Error('Refusing to mix source revisions in an existing measurement directory');
    if(!existsSync(target))writeFileSync(target,bytes);
  }
  const frozenWasm=join(inputDirectory,'engine-simd.wasm');
  if(existsSync(frozenWasm)&&hash(readFileSync(frozenWasm))!==hash(wasm))
    throw Error('Refusing to mix WASM revisions in an existing measurement directory');
  if(!existsSync(frozenWasm))writeFileSync(frozenWasm,wasm);
  const harnessBytes=readFileSync(fileURLToPath(import.meta.url));
  const frozenHarness=join(inputDirectory,'measure-regions.mjs');
  if(existsSync(frozenHarness)&&hash(readFileSync(frozenHarness))!==hash(harnessBytes))
    throw Error('Existing measurements use a different harness');
  if(!existsSync(frozenHarness))writeFileSync(frozenHarness,harnessBytes);
  const fixturePath=settings.fixtures?resolve(settings.fixtures):
    snapshot?join(snapshot,'fixtures.json'):join(project,'tests/fixtures/regions.json');
  const rawFixtures=JSON.parse(readFileSync(fixturePath,'utf8')).fixtures;
  const api=loadView();
  const fixtures=rawFixtures.map(f=>{
    const selection=f.selection||f,view=api.createView();view.set(selection);
    const actual=view.snapshot(3840,2160),expected=f.expectedRaster||f.view;
    if(expected && (actual.real!==expected.real || actual.imag!==expected.imag || actual.bits!==expected.bits ||
        actual.exponent!==expected.exponent || (f.iterations!==undefined&&actual.iterations!==f.iterations)))
      throw Error('Reference grid or iteration budget changed: '+f.id);
    if(f.expectedRaster){
      const bytes=new DataView(new ArrayBuffer(8));bytes.setFloat64(0,actual.mantissa);
      const binary=bytes.getBigUint64(0).toString(16).padStart(16,'0');
      if(binary!==f.expectedRaster.mantissaBits)throw Error('Spacing mantissa changed: '+f.id);
    }else if(expected&&actual.mantissa!==expected.mantissa)throw Error('Spacing changed: '+f.id);
    return {id:f.id,aliases:f.aliases||[],name:f.name||f.id,selection,view:actual};
  });
  if(requested.some(id=>!fixtures.some(f=>f.id===id)))throw Error('Unknown requested reference');
  const selected=fixtures.filter(f=>!requested.length||requested.includes(f.id));
  const appPrefix=read('web/app.js').replace(/^import .*$/gm,'').split('export async function start')[0];
  const policy=new Function(appPrefix+'\nreturn {useCompactTiles,minimumTilePixels};')();
  const {createTileQueue}=new Function('renderBands',read('web/tile-queue.js').replace(/^import .*$/gm,'')
    .replace(/^export /gm,'')+'\nreturn {createTileQueue};')(api.renderBands);
  const manifest={version:1,createdUTC:new Date().toISOString(),pid:process.pid,runtime:process.version,
    v8:process.versions.v8,cpu:os.cpus()[0]?.model,logicalProcessors:os.cpus().length,
    memoryBytes:os.totalmem(),width:3840,height:2160,workers:workersCount,flags,
    wasmSha256:hash(wasm),harnessSha256:hash(harnessBytes),sourceHashes,fixtures:selected,
    method:'One complete 4K frame per case, production iteration budget and scheduling, actual production workers. '
      +'Twenty small shallow overview warmups per worker, then a fresh target frame. Includes configuration, '
      +'validated global reference setup, compute, dispatch and pixel copies/transfers. Excludes compilation, '
      +'worker startup, preview, Canvas and PNG. Interrupted cases restart; partial frames are not timings.'};
  const manifestPath=join(output,'manifest.json');
  if(existsSync(manifestPath)){
    const previous=JSON.parse(readFileSync(manifestPath,'utf8'));
    if(previous.flags!==flags||previous.workers!==workersCount||previous.wasmSha256!==manifest.wasmSha256)
      throw Error('Existing measurements have different flags, workers or WASM');
  }
  writeFileSync(manifestPath,JSON.stringify(manifest,null,2)+'\n');
  const resultDirectory=join(output,'results');mkdirSync(resultDirectory,{recursive:true});
  const call=(worker,data,type,transfer=[])=>new Promise((resolveCall,reject)=>{
    const cleanup=()=>{worker.off('message',message);worker.off('error',error);worker.off('exit',exit);};
    const message=row=>{
      if(row.type==='error'){cleanup();reject(Error(row.message));}
      else if(row.type===type){cleanup();resolveCall(row);}
    };
    const error=e=>{cleanup();reject(e);};
    const exit=code=>{cleanup();reject(Error('Worker exited before '+type+': '+code));};
    worker.on('message',message);worker.on('error',error);worker.on('exit',exit);worker.postMessage(data,transfer);
  });
  const spawn=kind=>new Promise((resolveWorker,reject)=>{
    const worker=new Worker(frozenHarness,{workerData:{kind,module,codeRoot,flags}});
    const listener=row=>{
      if(row.type==='adapter-ready'){worker.off('message',listener);resolveWorker(worker);}
      else if(row.type==='error')reject(Error(row.message));
    };
    worker.on('message',listener);worker.once('error',reject);
  });
  const all=[];
  for(const fixture of selected){
    const resultPath=join(resultDirectory,fixture.id+'.json');
    if(settings.resume&&existsSync(resultPath)){
      const saved=JSON.parse(readFileSync(resultPath,'utf8'));
      if(saved.status==='complete'){all.push(saved);console.log(JSON.stringify({event:'already-complete',id:fixture.id}));continue;}
    }
    const workers=[],view=fixture.view;let referenceWorker,heartbeat,start,completedPixels=0;
    console.log(JSON.stringify({event:'starting',id:fixture.id,iterations:view.iterations}));
    try{
      workers.push(...await Promise.all(Array.from({length:workersCount},()=>spawn('render'))));
      if(view.perturb)referenceWorker=await spawn('reference');
      const warm=api.createView().snapshot(3840,2160);
      await Promise.all(workers.map(async worker=>{
        await call(worker,{type:'configure',generation:1000,view:warm,frameWidth:3840,frameHeight:2160},'adapter-accepted');
        for(let n=0;n<20;n++)await call(worker,{type:'render',generation:1000,x:0,y:0,width:16,height:8,
          buffer:new ArrayBuffer(65536)},'tile');
      }));
      const options={engineOptions:flags},compact=policy.useCompactTiles(view,options);
      const minPixels=policy.minimumTilePixels(view,options,compact);
      const queue=createTileQueue(3840,2160,view,{adaptive:true,compact,minPixels});
      const image=new Uint8Array(3840*2160*4),tiles=[],stats={},memories=Array(workersCount).fill(0);
      let referenceDetails=null,precisionBits=view.deep?Math.max(view.bits,Math.ceil((-2*view.exponent+192)/32)*32):0;
      start=performance.now();
      const progress=()=>{
        const row={event:'progress',status:'running',id:fixture.id,seconds:(performance.now()-start)/1000,
          percent:100*completedPixels/(3840*2160),completedTiles:tiles.length,totalTiles:queue.total};
        writeFileSync(join(output,'progress.json'),JSON.stringify(row)+'\n');console.log(JSON.stringify(row));
      };
      heartbeat=setInterval(progress,20000);
      if(view.perturb){
        let reference=await call(referenceWorker,{type:'prepare',generation:1,view,width:3840,height:2160},'reference');
        precisionBits=reference.bits;const {buffer,...details}=reference;referenceDetails=details;
        await Promise.all(workers.map(worker=>call(worker,{...reference,type:'reference',view,
          precisionHint:precisionBits},'adapter-accepted')));reference=null;
      }
      await Promise.all(workers.map(worker=>call(worker,{type:'configure',generation:1,view,
        frameWidth:3840,frameHeight:2160,precisionHint:precisionBits},'adapter-accepted')));
      await Promise.all(workers.map(async(worker,slot)=>{
        let buffer=new ArrayBuffer(65536);
        for(;;){
          const job=queue.take();if(!job)break;
          const sent=performance.now();
          const row=await call(worker,{...job,type:'render',generation:1,precisionHint:precisionBits,buffer},'tile',[buffer]);
          precisionBits=Math.max(precisionBits,row.precisionBits);
          queue.observe(row.timing.computeMilliseconds,job.width*job.height);
          const pixels=new Uint8Array(row.buffer,0,job.width*job.height*4);
          for(let y=0;y<job.height;y++){
            const strip=pixels.subarray(y*job.width*4,(y+1)*job.width*4);
            image.set(strip,((job.y+y)*3840+job.x)*4);
            if(job.mirrorY!==null)image.set(strip,((job.mirrorY+job.height-1-y)*3840+job.x)*4);
          }
          buffer=row.buffer;completedPixels+=job.width*job.height*(job.mirrorY!==null?2:1);
          memories[slot]=Math.max(memories[slot],row.memoryBytes);
          for(const[key,value]of Object.entries(row.stats))stats[key]=(stats[key]||0)+value;
          tiles.push({...job,slot,roundTripMs:performance.now()-sent,timing:row.timing,precisionBits:row.precisionBits});
        }
      }));
      const wallMs=performance.now()-start;clearInterval(heartbeat);heartbeat=null;
      if(completedPixels!==3840*2160)throw Error('Incomplete or duplicate physical pixel count');
      const coverage=new Uint8Array(3840*2160);
      for(const job of tiles)for(let y=0;y<job.height;y++)for(let x=0;x<job.width;x++){
        if(++coverage[(job.y+y)*3840+job.x+x]!==1)throw Error('Tile overlap');
        if(job.mirrorY!==null&&++coverage[(job.mirrorY+job.height-1-y)*3840+job.x+x]!==1)throw Error('Mirror overlap');
      }
      if(!coverage.every(value=>value===1))throw Error('Uncovered physical pixel');
      const times=tiles.map(t=>t.timing.computeMilliseconds).sort((a,b)=>a-b);
      const result={status:'complete',id:fixture.id,name:fixture.name,selection:fixture.selection,view,
        measuredUTC:new Date().toISOString(),width:3840,height:2160,workers:workersCount,flags,
        compactTiles:compact,minTilePixels:minPixels,wasmSha256:manifest.wasmSha256,sourceHashes,
        wallMs,imageFormat,reference:referenceDetails,workerComputeMs:tiles.reduce((sum,t)=>sum+t.timing.computeMilliseconds,0),
        tileCount:tiles.length,tileMilliseconds:{median:times[Math.floor(times.length/2)],
          p95:times[Math.floor(times.length*.95)],max:times.at(-1)},stats,precisionBits,
        workerMemoryBytes:memories,rgbaSha256:hash(image),coverage:'every physical pixel exactly once'};
      // Retention/compression happens after the measured interval. Hash-only
      // repeats still compute and hash the entire frame and verify coverage.
      if(imageFormat==='raw')writeFileSync(join(resultDirectory,fixture.id+'.rgba'),image);
      else if(imageFormat==='gzip')writeFileSync(join(resultDirectory,fixture.id+'.rgba.gz'),gzipSync(image));
      writeFileSync(resultPath,JSON.stringify(result,null,2)+'\n');
      writeFileSync(join(resultDirectory,fixture.id+'-tiles.json'),JSON.stringify(tiles)+'\n');all.push(result);
      writeFileSync(join(output,'summary.json'),JSON.stringify({manifest,results:all},null,2)+'\n');
      console.log(JSON.stringify({event:'complete',id:fixture.id,wallSeconds:wallMs/1000,rgbaSha256:result.rgbaSha256}));
    }catch(error){
      writeFileSync(resultPath,JSON.stringify({status:'failed',id:fixture.id,
        elapsedMs:start?performance.now()-start:null,message:String(error.stack||error)},null,2)+'\n');throw error;
    }finally{
      if(heartbeat)clearInterval(heartbeat);
      await Promise.all([...workers,...(referenceWorker?[referenceWorker]:[])].map(worker=>worker.terminate()));
    }
  }
  writeFileSync(join(output,'progress.json'),JSON.stringify({status:'complete',cases:all.length})+'\n');
  console.log(JSON.stringify({event:'all-complete',fixtures:all.length,output}));
}
