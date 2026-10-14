const {createView,decimalFixed,writeCentre,previewTransform}=new Function(readText('web/view.js').replace(/^export /gm,'')+'\nreturn {createView,decimalFixed,writeCentre,previewTransform};')();
const require=(c,m)=>{if(!c)throw new Error(m);};
const engines=['scalar','simd'].map(v=>new WebAssembly.Instance(new WebAssembly.Module(new Uint8Array(readBytes(`build/internal/wasm/engine-${v}.wasm`))),{}).exports);
const stops=[[0,0,7,100],[655,32,107,203],[1638,180,255,255],[1966,255,245,208],[2703,255,170,0],[3522,55,13,91],[4096,0,7,100]];
function independent(real,imag,bits,exponent,x,y,limit){
  const precision=bits+96,S=1n<<BigInt(precision),cx=(BigInt(real)<<96n)+(BigInt(x)<<BigInt(precision+exponent)),
    cy=(BigInt(imag)<<96n)+(BigInt(y)<<BigInt(precision+exponent));
  let r=0n,i=0n,n=0;
  while(n<limit && r*r+i*i<=4n*S*S){const next=(r*r-i*i)/S+cx;i=2n*r*i/S+cy;r=next;++n;}
  if(n===limit)return [0,0,0,255];
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
const view=createView(),initial=view.snapshot(1000,800,2000,1600),anchor={x:743,y:297};
view.change(4,anchor,anchor,1000,800);const next=view.snapshot(1000,800,2000,1600);
require(next.zoom===2 && next.revision!==initial.revision,'Zoom state did not advance');
require(previewTransform(initial,next,1000,800).includes('scale(4)'),'Preview scale incorrect');
view.set({real:'-2',imag:'1e-450',zoom:1600});const deep=view.snapshot(1000,800,2000,1600);
require(BigInt(deep.imag)!==0n && deep.exponent< -1600 && deep.bits>1600,'Deep coordinates lost precision');
const before=BigInt(deep.real);view.change(1,{x:500,y:400},{x:501,y:400},1000,800);
require(BigInt(view.snapshot(1000,800,2000,1600).real)!==before,'Deep panning rounded away');
view.reset();require(view.snapshot(1000,800).zoom===0,'Reset failed');
report(`Deep WASM matches independent BigInt orbits (${checked} samples, scalar/SIMD, through 2^1600); adaptive coordinates and deep panning passed.`);
var testDone=true;
