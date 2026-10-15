// Optional Node/V8 timing host; normal builds/checks still need only Apple CLT.
// Usage: node tests/performance-node.mjs [tests/performance-kernel.js] [options.json]
import {readFileSync,writeFileSync} from 'node:fs';
import {resolve,sep} from 'node:path';
import {runInNewContext} from 'node:vm';
import {performance} from 'node:perf_hooks';
const script=process.argv[2]||'tests/performance-kernel.js';
const internal=resolve('build/internal')+sep;
const context={
  benchmarkOptionsPath:process.argv[3],
  report:console.log,benchmarkNow:()=>performance.now(),
  benchmarkRuntime:`Node ${process.version}, V8 ${process.versions.v8}, ${process.platform}/${process.arch}`,
  readText:path=>{try{return readFileSync(path,'utf8');}catch{return null;}},
  readBytes:path=>{try{return Array.from(readFileSync(path));}catch{return null;}},
  writeBytes:(path,values)=>{
    if(!resolve(path).startsWith(internal))return false;
    writeFileSync(path,Buffer.from(values));return true;
  }
};
runInNewContext(readFileSync(script,'utf8'),context,{filename:script});
if(!context.testDone)throw Error('Benchmark did not complete');
