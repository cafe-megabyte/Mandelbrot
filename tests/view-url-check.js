const {createView,decimalFixed,fixedDecimal,viewFragment,viewFromFragment}=new Function(
  readText('web/view.js').replace(/^export /gm,'')+
  '\nreturn {createView,decimalFixed,fixedDecimal,viewFragment,viewFromFragment};')();
const assert=(ok,message)=>{if(!ok)throw new Error(message);};
const snapshot=view=>view.snapshot(1000,800,2000,1600);
function samePoint(a,b){
  const bits=Math.max(a.bits,b.bits);
  for(const key of ['real','imag'])assert(
    (BigInt(a[key])<<BigInt(bits-a.bits))===(BigInt(b[key])<<BigInt(bits-b.bits)),`Lost ${key} coordinate`);
  assert(a.zoom===b.zoom,'Lost zoom level');
  assert(a.mantissa===b.mantissa && a.exponent===b.exponent && a.iterations===b.iterations,'Changed rendering scale');
}
let checks=0;
function roundtrip(view){
  const before=snapshot(view),fragment=viewFragment(before),restored=createView();
  const target=viewFromFragment(fragment);if(target)restored.set(target);
  samePoint(before,snapshot(restored));++checks;
  assert(!/[eE]/.test(fragment.split('&zoom=')[0]),'Coordinate is not a plain decimal');
  return fragment;
}
const view=createView();
assert(viewFragment(snapshot(view))==='','Default view should have a clean URL');roundtrip(view);
for(const target of [
  {real:'-0.75',imag:'0.1',zoom:7},
  {real:'-0.743643887037151',imag:'0.13182590420533',zoom:40.125},
  {real:'-2',imag:'1e-450',zoom:1600},
  {real:'0',imag:'-1e-1200',zoom:4000}
]){
  view.set(target);roundtrip(view);
  view.change(1,{x:500,y:400},{x:501,y:399},1000,800);roundtrip(view);
}
// A previous deep zoom leaves extra coordinate bits even after zooming out.
// All of them must survive without a separate precision parameter in the URL.
view.set({real:'-0.75',imag:'0.1',zoom:1600});
view.change(1,{x:500,y:400},{x:501,y:400},1000,800);
view.change(2**-1000,{x:500,y:400},{x:500,y:400},1000,800);roundtrip(view);
view.set({real:'-0.75',imag:'0.1',zoom:7});const compact=viewFragment(snapshot(view));
assert(viewFromFragment(compact).zoom===7,'URL reload failed');
for(const fragment of ['', '#other=1', '#x=0&y=0', '#x=&y=0&zoom=7',
  '#x=NaN&y=0&zoom=7', '#x=0&y=Infinity&zoom=7', '#x=1e999999999&y=0&zoom=7',
  '#x=0&y=0&zoom=', '#x=0&y=0&zoom=-1', '#x=0&y=0&zoom=Infinity',
  '#x=0&y=0&zoom=1e100', '#x=0&x=1&y=0&zoom=7', '#x=%ZZ&y=0&zoom=7'])
  assert(viewFromFragment(fragment)===null,`Accepted malformed URL: ${fragment}`);
const signed=viewFromFragment('#x=%2B0.5&y=-0.125&zoom=1.5');
assert(signed?.real==='+0.5' && signed.imag==='-0.125' && signed.zoom===1.5,'Encoded coordinate failed');
for(const bits of [0,1,32,160,1760])for(const value of [0n,1n,-1n,3n,-17n,(1n<<BigInt(bits))+1n])
  assert(decimalFixed(fixedDecimal(value,bits),bits)===value,'Decimal codec changed a fixed-point integer');
report(`URL coordinates round-trip exactly (${checks} views, fractional zoom, deep pans through 2^4000, zoom-out guard bits); invalid links fall back safely.`);
var testDone=true;
