// Optional: node tests/performance-node.mjs tests/performance-cusp32.js
// Preserve the starting WASM in build/internal/cusp32/before/ first.
// Optional second host argument selects an options JSON file.
// options.outputDirectory selects a directory under build/internal.
// resetBeforeRender resets the frame outside each individual render clock.
// options.region: 'cusp24', 'cusp32', 'cusp38', 'branch29', 'seahorse', 'overview', or a custom
// {real,imag,zoom,width,height}; options.fixtures supplies custom tile rectangles.
// Regression presets compare before-turn / current flags267 / current flags779.
// Stable small-ROI run: region:'seahorse', only:['upper-left'], fixtureWarmups:1000,
// samples:9, batchSize:100. Timings are milliseconds per render, including copy.
const {createView,writeCentre}=new Function(readText('web/view.js').replace(/^export /gm,'')+'\nreturn {createView,writeCentre};')();
const options=JSON.parse(readText(typeof benchmarkOptionsPath==='string'?benchmarkOptionsPath:'build/internal/cusp32/options.json')||'{}');
const regions={
 branch29:{"real": "-0.6371691916298639708578389897549417222078705562264555606333260584506206214427947998046875", "imag": "0.3787904817879933184372663067875681372972409242938507389908409095369279384613037109375", "zoom": 29.19252319335936, "width": 3840, "height": 2160},
 cusp38:{
  "real": "0.2500130302909066233189455074779471041381893800707269907845908818444513599388301372528076171875",
  "imag": "-0.000000075132663698447208529708670575067558725977190196843036318341546575538814067840576171875",
  "zoom": 38.170528564453065,
  "width": 3840,
  "height": 2160
},
 cusp32:{real:'0.25001303030608202512367228146490787920114208693622703805203855154104530811309814453125',imag:'-0.0000000749182661172659014323139709291501879399356733646442307872348465025424957275390625',zoom:32.397396240234315,width:3840,height:2160},
 cusp24:{real:'0.250013003831570161123649567576785672333439247694286677869968116283416748046875',imag:'-0.0000000862687817968713428902967184298995750868499499119934625923633575439453125',zoom:24,width:3840,height:2160},
 seahorse:{real:'-0.743643887037151',imag:'0.13182590420533',zoom:18,width:3840,height:2160},
 overview:{real:'-0.75',imag:'0',zoom:0,width:512,height:320}
};
const custom=options.region && typeof options.region==='object';
const regionName=custom?'custom':options.region||'cusp32';
if(!custom && !regions[regionName])throw Error('Unknown region preset: '+regionName);
const region=custom?{...regions.cusp32,...options.region}:regions[regionName];
if(!Number.isSafeInteger(region.width)||region.width<1||!Number.isSafeInteger(region.height)||region.height<1)
 throw Error('Invalid region dimensions');
const v=createView();v.set(region);const view=v.snapshot(region.width,region.height);
if(region.iterations!==undefined){
 if(!Number.isSafeInteger(region.iterations)||region.iterations<1||region.iterations>0x7fffffbf)throw Error('Invalid iteration limit');
 view.iterations=region.iterations;
}
if(view.perturb)throw Error('This harness covers shallow and local-reference regions; use performance-kernel.js for global references');
const currentPath='build/internal/wasm/engine-simd.wasm';
const variants=options.variants||[{name:'before',path:'build/internal/cusp32/before/engine-simd.wasm'},
 ...(regionName==='cusp32'?[{name:'after',path:currentPath}]:[
  {name:'flags267',path:currentPath,flags:267},{name:'flags779',path:currentPath,flags:779}])],engines={},records=[];
if(variants.length<2||new Set(variants.map(variant=>variant.name)).size!==variants.length)
 throw Error('At least two uniquely named variants are required');
const render=(engine,fixture)=>(view.deep?engine.deep_render_tile:engine.render_tile)(fixture.x,fixture.y,fixture.width,fixture.height);
for(const variant of variants){
 const bytes=readBytes(variant.path);if(!bytes)throw Error('Missing WASM: '+variant.path);
 const e=new WebAssembly.Instance(new WebAssembly.Module(new Uint8Array(bytes)),{}).exports;
 if((variant.flags&512) && (!e.deep_stat_certified_pixels||!e.deep_stat_certificate_iterations))
  throw Error('Rebuild certificate-enabled WASM before measuring '+variant.name);
 if(variant.flags!==undefined)e.deep_set_options(variant.flags);
 if(view.deep){
  const bits=Math.max(view.bits,Math.ceil((-2*view.exponent+192)/32)*32);
  if(!e.deep_allocate(bits,view.iterations))throw Error('Allocation');writeCentre(e,view);
  if(!e.deep_configure(region.width,region.height,view.mantissa,view.exponent,view.iterations,
   BigInt(view.real)<0n?-1:1,BigInt(view.imag)<0n?-1:1))throw Error('Deep configuration');
 }else if(!e.configure_view(region.width,region.height,view.centreReal,view.centreImag,
  view.mantissa*2**view.exponent,view.iterations))throw Error('Shallow configuration');
 engines[variant.name]=e;
 const warmup={x:0,y:0,width:Math.min(8,region.width),height:Math.min(4,region.height)};
 for(let warm=0;warm<3;warm++)if(render(e,warmup)!==warmup.width*warmup.height*4)throw Error('Unsettled warmup: '+variant.name);
}
const counters=['skipped','fallbacks','dd_fallbacks','dd_iterations','fixed_iterations','reference_iterations','local_references','perturb_iterations','certified_pixels','certificate_iterations'];
const presets={cusp32:[
 {name:'escaping',x:0,y:0,width:256,height:8},
 {name:'wide-centre',x:1792,y:1076,width:256,height:8},
 {name:'compact-centre',x:1904,y:1076,width:32,height:8},
 {name:'compact-right',x:2880,y:1620,width:64,height:32},
 {name:'bottom-right',x:3584,y:2096,width:256,height:64}
],cusp24:[
 {name:'escaping',x:0,y:0,width:32,height:8},
 {name:'transition',x:1904,y:1184,width:32,height:16},
 {name:'analytic-interior',x:1904,y:1600,width:32,height:8}
],seahorse:[
 {name:'upper-left',x:0,y:0,width:32,height:8},
 {name:'centre',x:1904,y:1076,width:32,height:8},
 {name:'lower-right',x:2880,y:1620,width:32,height:8}
],overview:[
 {name:'escaping',x:0,y:0,width:64,height:32},
 {name:'boundary',x:352,y:144,width:64,height:32},
 {name:'analytic-interior',x:288,y:144,width:64,height:32}
]};
const width=Math.min(32,region.width),height=Math.min(8,region.height);
presets.cusp38=presets.cusp32;presets.branch29=presets.cusp32;
const fixtures=(options.fixtures||(custom?[{name:'centre',x:Math.floor((region.width-width)/2),
 y:Math.floor((region.height-height)/2),width,height}]:presets[regionName])).filter(f=>!options.only||options.only.includes(f.name));
if(!fixtures.length)throw Error('No fixtures selected');
for(const f of fixtures)if(![f.x,f.y,f.width,f.height].every(Number.isSafeInteger)||f.x<0||f.y<0||
 f.width<1||f.height<1||f.width>256||f.height>64||f.x+f.width>region.width||f.y+f.height>region.height)
 throw Error('Invalid fixture: '+f.name);
const samples=options.samples??3;
if(!Number.isSafeInteger(samples)||samples<1)throw Error('Invalid sample count');
const fixtureWarmups=options.fixtureWarmups??1,batchSize=options.batchSize??1;
if(!Number.isSafeInteger(fixtureWarmups)||fixtureWarmups<0)throw Error('Invalid fixture warmup count');
if(!Number.isSafeInteger(batchSize)||batchSize<1||!Number.isSafeInteger(samples*batchSize))throw Error('Invalid batch size');
const median=a=>[...a].sort((a,b)=>a-b)[Math.floor(a.length/2)];
let passed=true;
for(const f of fixtures){
 const times=Object.fromEntries(variants.map(v=>[v.name,[]])),stats={},pixels={};
 const comparisons=Object.fromEntries(variants.slice(1).map(v=>[v.name,{comparedPixels:0,differentPixels:0,maxChannelDifference:0,membershipDifferences:0}]));
 for(let round=0;round<fixtureWarmups+samples;round++){
  const timed=round>=fixtureWarmups,repeats=timed?batchSize:1;
  for(const variant of round%2?[...variants].reverse():variants){
   const name=variant.name,e=engines[name],dst=new Uint8Array(f.width*f.height*4);
   const batchStart=benchmarkNow();let renderMs=0;
   for(let repeat=0;repeat<repeats;repeat++){
    if(options.resetBeforeRender && view.deep){writeCentre(e,view);if(!e.deep_configure(region.width,region.height,view.mantissa,view.exponent,view.iterations,BigInt(view.real)<0n?-1:1,BigInt(view.imag)<0n?-1:1))throw Error('Reset failed');}
    const start=options.resetBeforeRender?benchmarkNow():0;
    if(render(e,f)!==dst.length)throw Error('Unsettled '+f.name+' '+name);
    dst.set(new Uint8Array(e.memory.buffer,e.output_address(),dst.length));
    if(options.resetBeforeRender)renderMs+=benchmarkNow()-start;
   }
   if(timed)times[name].push((options.resetBeforeRender?renderMs:benchmarkNow()-batchStart)/repeats);
   stats[name]=view.deep?Object.fromEntries(counters.map(n=>[n,e['deep_stat_'+n]?.()??null])):{};pixels[name]=dst;
  }
  if(!timed && round!==fixtureWarmups-1)continue;
  const before=pixels[variants[0].name];
  for(const variant of variants.slice(1)){
   const after=pixels[variant.name],c=comparisons[variant.name];
   for(let p=0;p<before.length;p+=4){let differs=false;for(let ch=0;ch<4;ch++){const d=Math.abs(before[p+ch]-after[p+ch]);differs||=d>0;c.maxChannelDifference=Math.max(c.maxChannelDifference,d);}c.differentPixels+=differs;++c.comparedPixels;c.membershipDifferences+=(!before[p]&&!before[p+1]&&!before[p+2])!==(!after[p]&&!after[p+1]&&!after[p+2]);}
  }
 }
 if(Object.values(comparisons).some(c=>c.differentPixels))passed=false;
 const mediansMs=Object.fromEntries(variants.map(v=>[v.name,median(times[v.name])]));
 const baseline=variants.find(v=>v.flags===267),candidate=variants.find(v=>v.flags===779);
 const certificateOverheadPercent=baseline&&candidate&&mediansMs[baseline.name]>0?
  100*(mediansMs[candidate.name]/mediansMs[baseline.name]-1):null;
 const row={...f,times,mediansMs,certificateOverheadPercent,stats,comparisons};records.push(row);report(JSON.stringify(row));
}
const result={regionName,region,view,runtime:benchmarkRuntime,samples,fixtureWarmups,batchSize,
 resetBeforeRender:!!options.resetBeforeRender,initialWarmupsPerVariant:3,timedRendersPerFixtureVariant:samples*batchSize,
 totalRendersPerFixtureVariant:fixtureWarmups+samples*batchSize,timeUnit:'milliseconds per render',
 method:'Three small initial warmups per variant, then fixtureWarmups individual renders and samples alternating timed batches per fixture/variant. Each batch executes batchSize renders with an RGBA copy after every render; times and medians are batch elapsed milliseconds divided by batchSize. With resetBeforeRender, the frame is reset before each individual render (outside its clock), preventing repeated-fixture reference reuse; render times are summed per batch. Includes local reference preparation when applicable; initial allocation/configuration and pixel comparisons excluded. Every pixel from the final fixture warmup and each final batch output is compared byte-for-byte with the first variant; earlier deterministic batch outputs are not compared. Statistics describe the final individual render of the last batch. Certificate overhead compares flags779/flags267 when present; certificates prove nonescape only through the selected limit.',variants,passed,records};
const resultName=options.result||(regionName==='cusp32'?'kernel':'regression-'+regionName);
if(!writeBytes((options.outputDirectory||'build/internal/cusp32')+'/'+resultName+'.json',Array.from(JSON.stringify(result,null,2),c=>c.charCodeAt(0))))throw Error('Result save failed');
if(!passed)throw Error('Pixel mismatch');
var testDone=true;
