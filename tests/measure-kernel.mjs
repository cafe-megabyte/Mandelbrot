// Nine alternating warmed samples, original 4K grid, fresh local reference on
// every render. Allocation/configuration is outside the clock; reference setup,
// compute and RGBA copy are inside. For global references use measure-regions.
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {performance} from 'node:perf_hooks';
import {createHash} from 'node:crypto';
import {resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';

const root=dirname(dirname(fileURLToPath(import.meta.url))),settings={},ids=[];
for(const arg of process.argv.slice(2)){
  if(arg.startsWith('--')){const [key,...rest]=arg.slice(2).split('=');settings[key]=rest.join('=');}
  else ids.push(arg);
}
const samples=Number(settings.samples||9),warmups=Number(settings.warmups||2);
const flags=settings.flags===undefined?undefined:Number(settings.flags);
if(!Number.isSafeInteger(samples)||samples<3||!Number.isSafeInteger(warmups)||warmups<2||
    (flags!==undefined&&(!Number.isSafeInteger(flags)||flags<0)))throw Error('Invalid kernel options');
const tileFilter=settings.tiles?settings.tiles.split(','):null;
const tiles=[{name:'upper-left',x:0,y:0},{name:'centre',x:1904,y:1076},{name:'lower-right',x:3808,y:2152}];
if(tileFilter?.some(name=>!tiles.some(tile=>tile.name===name)))throw Error('Unknown kernel tile');
const baseline=resolve(settings.baseline||'build/internal/reference-baseline');
const output=resolve(settings.output||'build/internal/kernel-'+Date.now());mkdirSync(output,{recursive:true});
const {createView,writeCentre}=new Function(readFileSync(resolve(root,'web/view.js'),'utf8').replace(/^export /gm,'')+
  '\nreturn {createView,writeCentre};')();
const variants=[
  {name:'baseline',path:resolve(baseline,'wasm/engine-simd.wasm'),flags:3851},
  {name:'current-base',path:resolve(root,'build/internal/wasm/engine-simd.wasm'),flags:3851},
  {name:'candidate',path:resolve(root,'build/internal/wasm/engine-simd.wasm'),flags}
];
for(const variant of variants){
  const bytes=readFileSync(variant.path);variant.sha256=createHash('sha256').update(bytes).digest('hex');
  variant.engine=new WebAssembly.Instance(new WebAssembly.Module(bytes),{}).exports;
  if(variant.flags===undefined)variant.flags=variant.engine.deep_default_options();
  variant.engine.deep_set_options(variant.flags);
}
const fixtures=JSON.parse(readFileSync(resolve(root,'tests/fixtures/regions.json'),'utf8')).fixtures
  .filter(f=>ids.length?ids.includes(f.id):['cusp24','cusp32','cusp38','branch29'].includes(f.id));
const results=[];
for(const fixture of fixtures){
  const selection=createView();selection.set(fixture);const view=selection.snapshot(3840,2160);
  if(view.perturb)throw Error('Kernel harness covers shallow/local-reference regions only');
  for(const {engine:e}of variants)if(view.deep){
    if(!e.deep_allocate(Math.max(view.bits,Math.ceil((-2*view.exponent+192)/32)*32),view.iterations))throw Error('Allocation failed');
  }
  const configure=e=>{
    if(view.deep){writeCentre(e,view);if(!e.deep_configure(3840,2160,view.mantissa,view.exponent,view.iterations,
      BigInt(view.real)<0n?-1:1,BigInt(view.imag)<0n?-1:1))throw Error('Configuration failed');}
    else if(!e.configure_view(3840,2160,view.centreReal,view.centreImag,view.mantissa*2**view.exponent,view.iterations))throw Error('Configuration failed');
  };
  for(const tile of tiles.filter(tile=>!tileFilter||tileFilter.includes(tile.name))){
    const times=Object.fromEntries(variants.map(v=>[v.name,[]])),stats={},pixels={};
    for(let round=0;round<samples+warmups;round++)for(const variant of round%2?[...variants].reverse():variants){
      const e=variant.engine;configure(e);let retries=0;
      const started=performance.now();
      let bytes=(view.deep?e.deep_render_tile:e.render_tile)(tile.x,tile.y,32,8);
      while(!bytes&&view.deep&&e.deep_needs_precision()){
        if(!e.deep_grow_precision(e.deep_digits()*32+32))throw Error('Growth failed');
        bytes=e.deep_render_tile_resume(tile.x,tile.y,32,8);++retries;
      }
      if(bytes!==1024)throw Error('Unsettled kernel tile');
      pixels[variant.name]=Buffer.from(new Uint8Array(e.memory.buffer,e.output_address(),bytes));
      const elapsed=performance.now()-started;if(round>=warmups)times[variant.name].push(elapsed);
      stats[variant.name]=view.deep?Object.fromEntries([
        'skipped','bla_skipped','series_skipped','f64_iterations','f64_fallbacks','f64_range_fallbacks',
        'dd_iterations','fixed_iterations','reference_iterations','local_references','perturb_iterations'
      ].map(name=>[name,e['deep_stat_'+name]?.()??null])):{};
      stats[variant.name].retries=retries;
    }
    const reference=pixels.baseline,comparisons={};
    for(const variant of variants.slice(1)){
      const bytes=pixels[variant.name];let differentPixels=0,maxChannelDifference=0,blackDifferences=0;
      for(let index=0;index<bytes.length;index+=4){
        let differs=false;
        for(let channel=0;channel<4;channel++){
          const delta=Math.abs(bytes[index+channel]-reference[index+channel]);
          if(delta)differs=true;maxChannelDifference=Math.max(maxChannelDifference,delta);
        }
        differentPixels+=differs;
        const black=a=>!a[index]&&!a[index+1]&&!a[index+2];blackDifferences+=black(bytes)!==black(reference);
      }
      comparisons[variant.name]={differentPixels,maxChannelDifference,blackDifferences};
    }
    const median=a=>[...a].sort((a,b)=>a-b)[Math.floor(a.length/2)];
    const row={fixture:fixture.id,tile:{...tile,width:32,height:8},view,times,
      medianMilliseconds:Object.fromEntries(variants.map(v=>[v.name,median(times[v.name])])),stats,comparisons};
    results.push(row);console.log(JSON.stringify(row));
  }
}
const result={runtime:process.version,v8:process.versions.v8,samples,warmups,
  method:'Alternating warmed 32x8 tiles on exact original 4K grids; frame reset before each sample, configuration/allocation excluded, local reference setup and RGBA copy included.',
  variants:variants.map(({engine,...v})=>v),results};
writeFileSync(resolve(output,'results.json'),JSON.stringify(result,null,2)+'\n');
