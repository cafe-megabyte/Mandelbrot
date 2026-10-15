const {createView,decimalFixed,writeCentre,previewTransform}=new Function(readText('web/view.js').replace(/^export /gm,'')+'\nreturn {createView,decimalFixed,writeCentre,previewTransform};')();
const require=(c,m)=>{if(!c)throw new Error(m);};
const engines=['scalar','simd'].map(v=>new WebAssembly.Instance(new WebAssembly.Module(new Uint8Array(readBytes(`build/internal/wasm/engine-${v}.wasm`))),{}).exports);
const stops=[[0,0,7,100],[655,32,107,203],[1638,180,255,255],[1966,255,245,208],[2703,255,170,0],[3522,55,13,91],[4096,0,7,100]];
function independent(real,imag,bits,exponent,x,y,limit,mantissa=1){
  // Decode the binary64 spacing exactly, then multiply the half-integer grid
  // offset in BigInt. A Number multiplication here would reproduce the core's
  // former local-reference rounding bug instead of independently detecting it.
  const binary=new DataView(new ArrayBuffer(8));binary.setFloat64(0,mantissa);
  const high=binary.getUint32(0),low=binary.getUint32(4),encodedExponent=(high>>>20)&2047;
  const significand=(BigInt(high&0xfffff)<<32n)|BigInt(low)|(encodedExponent?1n<<52n:0n);
  const binaryExponent=encodedExponent?encodedExponent-1075:-1074;
  const precision=Math.max(bits+96,Math.ceil((-2*exponent+288)/32)*32),S=1n<<BigInt(precision);
  const shift=precision+exponent+binaryExponent-1;
  require(shift>=0 && Number.isSafeInteger(2*x) && Number.isSafeInteger(2*y),'Oracle cannot exactly represent this grid');
  const offset=value=>(BigInt(2*value)*significand)<<BigInt(shift);
  const cx=(BigInt(real)<<BigInt(precision-bits))+offset(x),
    cy=(BigInt(imag)<<BigInt(precision-bits))+offset(y);
  let r=0n,i=0n,n=0;
  while(n<limit && r*r+i*i<=4n*S*S){const next=(r*r-i*i)/S+cx;i=2n*r*i/S+cy;r=next;++n;}
  if(r*r+i*i<=4n*S*S)return [0,0,0,255];
  function double(a){const sign=a<0n?-1:1;a=a<0n?-a:a;const shift=Math.max(0,a.toString(2).length-53);return sign*Number(a>>BigInt(shift))*2**(shift-precision);}
  const magnitude=double(r)**2+double(i)**2,smooth=n+1-Math.log2(0.5*Math.log2(magnitude)),index=Math.floor(smooth*96)&4095;
  let segment=0;while(index>=stops[segment+1][0])++segment;
  const a=stops[segment],b=stops[segment+1],t=(index-a[0])/(b[0]-a[0]);
  return [1,2,3].map(k=>Math.floor(a[k]+t*(b[k]-a[k])+0.5)).concat(255);
}
let checked=0;
for(const fixture of [
  {r:'-0.743643887037151',i:'0.13182590420533',e:-32,limit:4096},
  {r:'-2',i:'0',e:-400,limit:2048},
  {r:'0',i:'1',e:-1600,limit:4096}
]){
  const bits=Math.ceil((-2*fixture.e+192)/32)*32,view={bits,real:decimalFixed(fixture.r,bits).toString(),imag:decimalFixed(fixture.i,bits).toString(),iterations:fixture.limit};
  let reference;
  for(const engine of engines){
    require(engine.deep_allocate(bits,view.iterations),'Deep allocation rejected');writeCentre(engine,view);
    engine.deep_begin(BigInt(view.real)<0n?-1:1,1,1,fixture.e,33,17);while(!engine.deep_reference(128)){}engine.deep_finish();
    const data=new Uint8Array(engine.memory.buffer,engine.deep_data_address(),engine.deep_data_size());
    if(reference)require(data.every((b,j)=>b===reference[j]),'Scalar/SIMD reference mismatch');else reference=data.slice();
    engine.deep_configure(33,17,1,fixture.e,view.iterations,BigInt(view.real)<0n?-1:1,1);
    let rendered=engine.deep_render_tile(0,0,33,17),actualBits=bits;
    while(!rendered && engine.deep_needs_precision()){
      actualBits+=64;require(engine.deep_allocate(actualBits,view.iterations),'Precision retry allocation failed');writeCentre(engine,view);
      engine.deep_begin(BigInt(view.real)<0n?-1:1,1,1,fixture.e,33,17);while(!engine.deep_reference(128)){}
      if(engine.deep_needs_precision())continue;
      engine.deep_finish();engine.deep_configure(33,17,1,fixture.e,view.iterations,BigInt(view.real)<0n?-1:1,1);
      rendered=engine.deep_render_tile(0,0,33,17);
    }
    require(rendered===33*17*4,'Deep tile could not settle at higher precision');
    const full=new Uint8Array(engine.memory.buffer,engine.output_address(),33*17*4).slice();
    for(const [x,y]of[[0,0],[1,8],[16,0],[16,8],[32,8],[32,16],[3,13],[22,7]]){
      const actual=full.subarray((y*33+x)*4,(y*33+x)*4+4);
      const expected=independent(view.real,view.imag,bits,fixture.e,x-16,8-y,view.iterations);
      require(actual.every((v,j)=>Math.abs(v-expected[j])<=1),`Independent BigInt mismatch: exponent ${fixture.e}, pixel ${x},${y}: ${actual} / ${expected}`);++checked;
    }
  }
}
// Use actual createView mantissas and an ROI away from the frame origin. The
// integer -2 centre exposes real-axis cancellation after an adaptive reference;
// c=i exercises the same conversion below the binary64 exponent range.
for(const fixture of [
  {name:'real-axis adaptive ROI',real:'-2',imag:'0',zoom:400,width:257,height:129,tx:112,ty:56,limit:2048},
  {name:'extended adaptive frame',real:'0',imag:'1',zoom:1600,width:33,height:17,tx:0,ty:0,limit:4096}
]){
  const selection=createView();selection.set(fixture);
  const view=selection.snapshot(fixture.width,fixture.height);view.iterations=fixture.limit;
  require(view.mantissa!==1,'Adaptive fixture lost its nontrivial spacing mantissa');
  const samples=[[0,8],[1,8],[16,8],[32,8],[16,0],[16,16],[0,0],[32,16],[3,13],[22,7],[31,1],[1,15]];
  const expected=samples.map(([x,y])=>independent(view.real,view.imag,view.bits,view.exponent,
    fixture.tx+x+0.5-fixture.width/2,fixture.height/2-fixture.ty-y-0.5,view.iterations,view.mantissa));
  const black=rgba=>rgba[0]===0 && rgba[1]===0 && rgba[2]===0;
  if(fixture.real==='-2')require(!black(expected[0]) && black(expected[2]) && black(expected[3]),
    'Independent real-axis fixture did not straddle the boundary');
  for(const [variant,engine]of engines.entries())for(const options of [27,511]){
    engine.deep_set_options(options);
    let actualBits=Math.max(view.bits,Math.ceil((-2*view.exponent+192)/32)*32),rendered;
    const rs=BigInt(view.real)<0n?-1:1,is=BigInt(view.imag)<0n?-1:1;
    for(;;){
      require(engine.deep_allocate(actualBits,view.iterations),'Adaptive reference allocation rejected');writeCentre(engine,view);
      engine.deep_begin(rs,is,view.mantissa,view.exponent,fixture.width,fixture.height);
      while(!engine.deep_reference(128)){}
      if(engine.deep_needs_precision()){actualBits+=64;continue;}
      engine.deep_finish();
      require(engine.deep_configure(fixture.width,fixture.height,view.mantissa,view.exponent,view.iterations,rs,is),
        'Adaptive viewport rejected');
      rendered=engine.deep_render_tile(fixture.tx,fixture.ty,33,17);
      break;
    }
    let localReferences=engine.deep_stat_local_references();
    while(!rendered && engine.deep_needs_precision()){
      actualBits+=64;require(engine.deep_grow_precision(actualBits),'Adaptive precision growth rejected');
      rendered=engine.deep_render_tile_resume(fixture.tx,fixture.ty,33,17);
      localReferences+=engine.deep_stat_local_references();
    }
    require(rendered===33*17*4,'Adaptive tile could not settle at higher precision');
    require(localReferences>0,`Adaptive fixture did not build a local reference: ${fixture.name}, options ${options}`);
    const full=new Uint8Array(engine.memory.buffer,engine.output_address(),rendered);
    for(let sample=0;sample<samples.length;++sample){
      const [x,y]=samples[sample],actual=full.subarray((y*33+x)*4,(y*33+x)*4+4),target=expected[sample];
      require(black(actual)===black(target) && actual.every((value,channel)=>Math.abs(value-target[channel])<=1),
        `Independent adaptive BigInt mismatch: ${fixture.name}, ${variant?'simd':'scalar'}, options ${options}, `+
        `frame pixel ${fixture.tx+x},${fixture.ty+y}: ${actual} / ${target}`);
      ++checked;
    }
    engine.deep_set_options(engine.deep_default_options());
  }
}
// Keep the actual 4K spacing and exact fixed centre of the slow cusp view.
// These are finite-budget black certificates, not permanent set membership.
// A BigInt orbit computes each selected pixel independently of the reference
// and its degree-eight polynomial; complete tiles also match options 267.
const certificateRegion={
  real:'0.25001303030608202512367228146490787920114208693622703805203855154104530811309814453125',
  imag:'-0.0000000749182661172659014323139709291501879399356733646442307872348465025424957275390625',
  zoom:32.397396240234315,width:3840,height:2160
};
const certificateSelection=createView();certificateSelection.set(certificateRegion);
const certificateView=certificateSelection.snapshot(certificateRegion.width,certificateRegion.height);
require(certificateView.exponent===-43 && certificateView.iterations===9216,
  'Certificate fixture lost its real 4K scale or finite iteration budget');
for(const fixture of [
  {name:'scalar black disk',tx:960,ty:540,width:8,height:4,certificate:'scalar'},
  {name:'degree-eight black bound',tx:1920,ty:1080,width:32,height:8,certificate:'series'},
  {name:'escaping reference',tx:0,ty:0,width:8,height:4,certificate:'none'},
  {name:'mixed black and escaping pixels',tx:0,ty:1078,width:8,height:4,certificate:'failed'}
]){
  const {width,height}=fixture,view=certificateView;
  const samples=[[0,0],[width-1,0],[0,height-1],[width-1,height-1],[Math.floor(width/2),Math.floor(height/2)]];
  const expected=samples.map(([x,y])=>independent(view.real,view.imag,view.bits,view.exponent,
    fixture.tx+x+0.5-certificateRegion.width/2,certificateRegion.height/2-fixture.ty-y-0.5,
    view.iterations,view.mantissa));
  const black=rgba=>rgba[0]===0 && rgba[1]===0 && rgba[2]===0;
  if(fixture.certificate==='scalar' || fixture.certificate==='series')
    require(expected.every(black),'Independent certificate fixture was not black through its budget');
  if(fixture.certificate==='failed')
    require(expected.some(black) && expected.some(pixel=>!black(pixel)),
      'Independent failed-certificate fixture did not straddle the finite-budget boundary');
  for(const [variant,engine]of engines.entries()){
    let baseline;
    for(const options of [267,779]){
      engine.deep_set_options(options);
      const bits=Math.max(view.bits,Math.ceil((-2*view.exponent+192)/32)*32);
      require(engine.deep_allocate(bits,view.iterations),'Certificate allocation rejected');writeCentre(engine,view);
      require(engine.deep_configure(certificateRegion.width,certificateRegion.height,view.mantissa,view.exponent,
        view.iterations,1,-1),'Certificate viewport rejected');
      const rendered=engine.deep_render_tile(fixture.tx,fixture.ty,width,height);
      require(rendered===width*height*4 && !engine.deep_needs_precision(),'Certificate tile could not settle');
      const full=new Uint8Array(engine.memory.buffer,engine.output_address(),rendered).slice();
      const certified=engine.deep_stat_certified_pixels(),work=engine.deep_stat_certificate_iterations();
      if(options===267){
        baseline=full;require(!certified && !work,'Disabled certificate performed work');
      }else{
        require(full.every((value,index)=>value===baseline[index]),
          `Certificate changed full tile bytes: ${fixture.name}, ${variant?'simd':'scalar'}`);
        if(fixture.certificate==='scalar' || fixture.certificate==='series'){
          require(certified===width*height && engine.deep_stat_perturb_iterations()===0 &&
            engine.deep_stat_dd_iterations()===0 && engine.deep_stat_fixed_iterations()===0,
            `Successful certificate did not replace pixel orbits: ${fixture.name}`);
          require(fixture.certificate==='scalar'?work===view.iterations:work>view.iterations && work<2*view.iterations,
            `Certificate did not exercise its intended bound: ${fixture.name}`);
        }else{
          require(certified===0 && engine.deep_stat_perturb_iterations()>0,
            `Uncertain or escaping tile was certified: ${fixture.name}`);
          require(fixture.certificate==='none'?work===0:work>0,
            `Certificate failure did not exercise its intended path: ${fixture.name}`);
        }
      }
      for(let sample=0;sample<samples.length;++sample){
        const [x,y]=samples[sample],actual=full.subarray((y*width+x)*4,(y*width+x)*4+4),target=expected[sample];
        require(black(actual)===black(target) && actual.every((value,channel)=>Math.abs(value-target[channel])<=1),
          `Independent certificate BigInt mismatch: ${fixture.name}, ${variant?'simd':'scalar'}, options ${options}, `+
          `frame pixel ${fixture.tx+x},${fixture.ty+y}: ${actual} / ${target}`);
        ++checked;
      }
    }
    engine.deep_set_options(engine.deep_default_options());
  }
}
// Accurate prefixes retain the original colour/escape tolerances. These actual
// 4K grids exercise both a long parabolic passage and a different branch whose
// difficult pixels can fall back through DD to independent fixed arithmetic.
for(const fixture of [
  {name:'cusp38 exterior',real:'0.2500130302909066233189455074779471041381893800707269907845908818444513599388301372528076171875',
    imag:'-0.000000075132663698447208529708670575067558725977190196843036318341546575538814067840576171875',
    zoom:38.170528564453065,tx:0,ty:0},
  {name:'cusp38 difficult centre',real:'0.2500130302909066233189455074779471041381893800707269907845908818444513599388301372528076171875',
    imag:'-0.000000075132663698447208529708670575067558725977190196843036318341546575538814067840576171875',
    zoom:38.170528564453065,tx:1920,ty:1080},
  {name:'branch29 difficult centre',real:'-0.6371691916298639708578389897549417222078705562264555606333260584506206214427947998046875',
    imag:'0.3787904817879933184372663067875681372972409242938507389908409095369279384613037109375',
    zoom:29.19252319335936,tx:1920,ty:1080}
]){
  const selection=createView();selection.set(fixture);
  const view=selection.snapshot(3840,2160),width=32,height=8,samples=[[0,0],[31,7],[16,4]];
  const expected=samples.map(([x,y])=>independent(view.real,view.imag,view.bits,view.exponent,
    fixture.tx+x+0.5-1920,1080-fixture.ty-y-0.5,view.iterations,view.mantissa));
  const black=rgba=>rgba[0]===0 && rgba[1]===0 && rgba[2]===0;
  for(const [variant,engine]of engines.entries()){
    let baseline;
    for(const options of [779,779|1024,779|4096]){
      engine.deep_set_options(options);
      const bits=Math.max(view.bits,Math.ceil((-2*view.exponent+192)/32)*32);
      require(engine.deep_allocate(bits,view.iterations),'Accurate-prefix allocation rejected');writeCentre(engine,view);
      require(engine.deep_configure(3840,2160,view.mantissa,view.exponent,view.iterations,
        BigInt(view.real)<0n?-1:1,BigInt(view.imag)<0n?-1:1),'Accurate-prefix viewport rejected');
      const rendered=engine.deep_render_tile(fixture.tx,fixture.ty,width,height);
      require(rendered===width*height*4 && !engine.deep_needs_precision(),'Accurate-prefix tile failed');
      const full=new Uint8Array(engine.memory.buffer,engine.output_address(),rendered).slice();
      if(!baseline)baseline=full;
      else require(full.every((value,index)=>value===baseline[index]),
        `Accurate prefix changed tile bytes: ${fixture.name}, options ${options}, ${variant?'simd':'scalar'}`);
      for(let sample=0;sample<samples.length;++sample){
        const [x,y]=samples[sample],actual=full.subarray((y*width+x)*4,(y*width+x)*4+4),target=expected[sample];
        require(black(actual)===black(target) && actual.every((value,channel)=>Math.abs(value-target[channel])<=1),
          `Independent prefix BigInt mismatch: ${fixture.name}, options ${options}, ${variant?'simd':'scalar'}, `+
          `frame pixel ${fixture.tx+x},${fixture.ty+y}: ${actual} / ${target}`);
        ++checked;
      }
    }
    engine.deep_set_options(engine.deep_default_options());
  }
}
const view=createView(),initial=view.snapshot(1000,800,2000,1600),anchor={x:743,y:297};
view.change(4,anchor,anchor,1000,800);const next=view.snapshot(1000,800,2000,1600);
require(next.zoom===2 && next.revision!==initial.revision,'Zoom state did not advance');
require(previewTransform(initial,next,1000,800).includes('scale(4)'),'Preview scale incorrect');
view.set({real:'-2',imag:'1e-450',zoom:1600});const deep=view.snapshot(1000,800,2000,1600);
require(BigInt(deep.imag)!==0n && deep.exponent< -1600 && deep.bits>1600,'Deep coordinates lost precision');
const before=BigInt(deep.real);view.change(1,{x:500,y:400},{x:501,y:400},1000,800);
require(BigInt(view.snapshot(1000,800,2000,1600).real)!==before,'Deep panning rounded away');
view.reset();require(view.snapshot(1000,800).zoom===0,'Reset failed');
report(`Deep WASM matches independent BigInt orbits (${checked} samples, scalar/SIMD, through 2^1600, adaptive options 27/511, certificate options 267/779, accurate-prefix options 1803/4875 and exact non-unit grids); 4K finite-budget certificates, accurate prefixes, adaptive coordinates and deep panning passed.`);
var testDone=true;
