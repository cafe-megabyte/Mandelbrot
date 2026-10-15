// Sequential full-frame A/B measurements. Each child freezes its complete
// product inputs; never run another CPU benchmark concurrently with this file.
// node tests/measure-ab.mjs --baseline=/frozen/baseline --candidate=/frozen/new
//   --output=build/internal/ab --pairs=3 cusp38
import {spawn} from 'node:child_process';
import {readFileSync,writeFileSync,mkdirSync,existsSync} from 'node:fs';
import {resolve,dirname,join} from 'node:path';
import {fileURLToPath} from 'node:url';

const root=dirname(dirname(fileURLToPath(import.meta.url))),settings={},ids=[];
for(const arg of process.argv.slice(2)){
  if(arg.startsWith('--')){
    const [key,...rest]=arg.slice(2).split('=');
    if(!['baseline','candidate','output','flags','pairs','first-pair','resume','image-format'].includes(key))throw Error('Unknown A/B option: '+key);
    settings[key]=rest.join('=');
  }else ids.push(arg);
}
if(!settings.baseline||!settings.candidate||!settings.output||!ids.length)
  throw Error('A/B measurement requires baseline, candidate, output and fixture IDs');
const pairs=Number(settings.pairs||3),firstPair=Number(settings['first-pair']||1);
if(!Number.isSafeInteger(pairs)||pairs<1||!Number.isSafeInteger(firstPair)||firstPair<1)
  throw Error('Invalid pair range');
const output=resolve(settings.output);mkdirSync(output,{recursive:true});
const candidateSnapshot=resolve(settings.candidate);
const candidateFlags=settings.flags===undefined?
  new WebAssembly.Instance(new WebAssembly.Module(readFileSync(join(candidateSnapshot,'wasm/engine-simd.wasm'))),{}).exports.deep_default_options():
  Number(settings.flags);
const variants={
  baseline:{snapshot:resolve(settings.baseline),flags:3851},
  candidate:{snapshot:candidateSnapshot,flags:candidateFlags}
};
let manifest={version:1,createdUTC:new Date().toISOString(),pid:process.pid,pairs,firstPair,ids,variants,
  method:'Sequential full production 4K frames. Alternate A/B then B/A order between pairs. '
    +'Each child uses frozen original worker/scheduler/WASM sources, no mixed builds. '
    +'No partial frame contributes a timing. Historical single-frame measurements are excluded from paired statistics.'};
const manifestPath=join(output,'ab-manifest.json');
if(existsSync(manifestPath)){
  if(settings.resume===undefined)throw Error('A/B output already exists; use --resume or a fresh output');
  const saved=JSON.parse(readFileSync(manifestPath,'utf8'));
  for(const key of ['pairs','firstPair','ids','variants'])
    if(JSON.stringify(saved[key])!==JSON.stringify(manifest[key]))throw Error('Cannot resume different A/B inputs: '+key);
  manifest=saved;
  writeFileSync(join(output,'ab-resume.json'),JSON.stringify({pid:process.pid,resumedUTC:new Date().toISOString()})+'\n');
}
writeFileSync(manifestPath,JSON.stringify(manifest,null,2)+'\n');
const completed=[];
for(let pair=firstPair;pair<firstPair+pairs;pair++){
  const order=pair%2?['baseline','candidate']:['candidate','baseline'];
  for(const name of order){
    const directory=join(output,'pair-'+pair+'-'+name),variant=variants[name];
    const args=[join(root,'tests/measure-regions.mjs'),'--snapshot='+variant.snapshot,
      '--flags='+variant.flags,'--output='+directory,
      '--image-format='+(settings['image-format']|| (pair===firstPair?'gzip':'hash')),...ids];
    if(settings.resume!==undefined)args.push('--resume');
    console.log(JSON.stringify({event:'ab-start',pair,variant:name,directory}));
    writeFileSync(join(output,'ab-progress.json'),JSON.stringify({status:'running',pair,variant:name,directory})+'\n');
    await new Promise((resolveChild,reject)=>{
      const child=spawn(process.execPath,args,{cwd:root,stdio:['ignore','pipe','pipe']});
      const chunks=[];
      for(const stream of [child.stdout,child.stderr])stream.on('data',bytes=>{chunks.push(bytes);process.stdout.write(bytes);});
      child.on('error',reject);
      child.on('exit',(code,signal)=>{
        mkdirSync(directory,{recursive:true});writeFileSync(join(directory,'run.log'),Buffer.concat(chunks));
        if(code===0)resolveChild();else reject(Error('A/B child failed: '+name+' code='+code+' signal='+signal));
      });
    });
    const summary=JSON.parse(readFileSync(join(directory,'summary.json'),'utf8'));
    completed.push({pair,variant:name,directory,results:summary.results});
    writeFileSync(join(output,'ab-results.json'),JSON.stringify({manifest,completed},null,2)+'\n');
  }
}
writeFileSync(join(output,'ab-progress.json'),JSON.stringify({status:'complete',pairs,firstPair})+'\n');
console.log(JSON.stringify({event:'ab-complete',pairs,firstPair,output}));
