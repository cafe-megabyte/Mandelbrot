// Independent direct recurrence with outward integer intervals. This module
// never calls the production orbit, perturbation, series or BLA routines.
const oracleStops=[[0,0,7,100],[655,32,107,203],[1638,180,255,255],
  [1966,255,245,208],[2703,255,170,0],[3522,55,13,91],[4096,0,7,100]];

function floorRatio(a,b) {
  const q=a/b;
  return a<0n && a%b ? q-1n : q;
}
function ceilRatio(a,b) { return -floorRatio(-a,b); }
function decimalRatio(text) {
  const m=/^([+-]?)(\d*)(?:\.(\d*))?(?:e([+-]?\d+))?$/i.exec(String(text));
  if(!m || !(m[2]||m[3]))throw Error('Invalid oracle coordinate');
  const places=(m[3]||'').length-Number(m[4]||0);
  let numerator=BigInt((m[2]||'0')+(m[3]||'')),denominator=1n;
  if(places>=0)denominator=10n**BigInt(places);
  else numerator*=10n**BigInt(-places);
  if(m[1]==='-')numerator=-numerator;
  return {numerator,denominator};
}
function binaryRatio(value) {
  if(!Number.isFinite(value))throw Error('Nonfinite oracle spacing');
  const data=new DataView(new ArrayBuffer(8));data.setFloat64(0,value);
  const high=data.getUint32(0),low=data.getUint32(4),e=(high>>>20)&2047;
  let significand=(BigInt(high&0xfffff)<<32n)|BigInt(low);
  if(e)significand|=1n<<52n;
  if(high>>>31)significand=-significand;
  return {significand,exponent:e?e-1075:-1074};
}
export function exactGridPoint(view,width,height,x,y) {
  if(![width,height,x,y].every(Number.isSafeInteger) || width<1 || height<1 ||
      x<0 || y<0 || x>=width || y>=height)throw Error('Invalid oracle pixel');
  const spacing=binaryRatio(view.mantissa);
  const offsetExponent=view.exponent+spacing.exponent-1;
  const bits=Math.max(view.bits,-offsetExponent);
  const coordinateShift=BigInt(bits-view.bits),offsetShift=BigInt(bits+offsetExponent);
  return {bits,real:(BigInt(view.real)<<coordinateShift)+
    (BigInt(2*x+1-width)*spacing.significand<<offsetShift),
    imag:(BigInt(view.imag)<<coordinateShift)+
    (BigInt(height-2*y-1)*spacing.significand<<offsetShift)};
}
function approximateInteger(value,bits) {
  const sign=value<0n?-1:1;value=value<0n?-value:value;
  if(!value)return 0;
  const shift=Math.max(0,value.toString(2).length-53);
  return sign*Number(value>>BigInt(shift))*2**(shift-bits);
}
function colourIndex(index) {
  index&=4095;
  let segment=0;while(index>=oracleStops[segment+1][0])++segment;
  const a=oracleStops[segment],b=oracleStops[segment+1],t=(index-a[0])/(b[0]-a[0]);
  return [1,2,3].map(k=>Math.floor(a[k]+t*(b[k]-a[k])+.5)).concat(255);
}
function colourPhase(iteration,magnitude) {
  return (iteration+1-Math.log2(.5*Math.log2(magnitude)))*96;
}
export function oracleColour(iteration,magnitude) {
  return colourIndex(Math.floor(colourPhase(iteration,magnitude)));
}
function enclosedColour(iteration,lo,hi,bits) {
  // Integer-to-double conversion discards at most one binary mantissa ulp.
  // Widen both positive endpoints before applying the monotone smooth phase.
  const lower=approximateInteger(lo,bits)*(1-2**-50);
  const upper=approximateInteger(hi,bits)*(1+2**-50);
  const phaseLo=colourPhase(iteration,upper),phaseHi=colourPhase(iteration,lower);
  // Reserve sixteen double ulps for the host's log/phase arithmetic. The
  // recurrence enclosure, rather than precision stability, bounds magnitude.
  const reserve=(Math.max(Math.abs(phaseLo),Math.abs(phaseHi))+1)*2**-48;
  const first=Math.floor(phaseLo-reserve),last=Math.floor(phaseHi+reserve);
  if(!Number.isSafeInteger(first)||!Number.isSafeInteger(last)||last-first>4)return null;
  const rgba=oracleColour(iteration,approximateInteger((lo+hi)/2n,bits));
  const bounds=[rgba.slice(),rgba.slice()];
  for(let index=first;index<=last;index++){
    const colour=colourIndex(index);
    if(colour.some((value,j)=>Math.abs(value-rgba[j])>1))return null;
    for(let j=0;j<4;j++){
      bounds[0][j]=Math.min(bounds[0][j],colour[j]);bounds[1][j]=Math.max(bounds[1][j],colour[j]);
    }
  }
  return {rgba,bounds};
}
export function oracleAtPrecision(point,limit,bits) {
  if(!Number.isSafeInteger(bits)||bits<64 || !Number.isSafeInteger(limit)||limit<1)
    throw Error('Invalid oracle precision or iteration limit');
  const S=1n<<BigInt(bits),four=4n*S;
  const coordinate=axis=>{
    if(point.bits!==undefined){
      const shift=bits-point.bits;
      if(shift<0)throw Error('Oracle cannot round an exact binary input');
      const value=BigInt(point[axis])<<BigInt(shift);return [value,value];
    }
    const ratio=decimalRatio(point[axis]),scaled=ratio.numerator*S;
    return [floorRatio(scaled,ratio.denominator),ceilRatio(scaled,ratio.denominator)];
  };
  const cr=coordinate('real'),ci=coordinate('imag');
  const square=a=>{
    const left=a[0]*a[0],right=a[1]*a[1];
    const lower=a[0]<=0n&&a[1]>=0n?0n:left<right?left:right;
    return [floorRatio(lower,S),ceilRatio(left>right?left:right,S)];
  };
  const multiply=(a,b)=>{
    const products=[a[0]*b[0],a[0]*b[1],a[1]*b[0],a[1]*b[1]];
    let lo=products[0],hi=lo;
    for(let j=1;j<4;j++){if(products[j]<lo)lo=products[j];if(products[j]>hi)hi=products[j];}
    return [floorRatio(lo,S),ceilRatio(hi,S)];
  };
  let r=[0n,0n],i=[0n,0n],checkpoint=[0n,0n,0n,0n],span=16,nextCheckpoint=16;
  for(let n=1;n<=limit;n++){
    const rr=square(r),ii=square(i),ri=multiply(r,i);
    r=[rr[0]-ii[1]+cr[0],rr[1]-ii[0]+cr[1]];
    i=[2n*ri[0]+ci[0],2n*ri[1]+ci[1]];
    const x=square(r),y=square(i),lo=x[0]+y[0],hi=x[1]+y[1];
    if(lo>four){
      const magnitude=approximateInteger((lo+hi)/2n,bits);
      const colour=enclosedColour(n,lo,hi,bits);
      if(!colour)return {status:'unresolved',iteration:n,bits,reason:'colour interval exceeds one RGB step'};
      return {status:'escaped',escapeIteration:n,rgba:colour.rgba,colourBounds:colour.bounds,
        bits,proof:'outward interval',magnitude};
    }
    if(hi>four)return {status:'unresolved',iteration:n,bits,reason:'escape interval crosses four'};
    // An exactly repeated enclosure maps onto the same enclosure cycle;
    // every intermediate upper magnitude has been checked, even for nonzero
    // interval widths. This proves nonescape through any remaining budget.
    if(r[0]===checkpoint[0]&&r[1]===checkpoint[1]&&i[0]===checkpoint[2]&&i[1]===checkpoint[3])
      return {status:'bounded_at_limit',escapeIteration:0,rgba:[0,0,0,255],bits,proof:'invariant interval cycle'};
    if(n===nextCheckpoint){checkpoint=[...r,...i];span*=2;nextCheckpoint=n+span;}
  }
  return {status:'bounded_at_limit',escapeIteration:0,rgba:[0,0,0,255],bits,proof:'all interval upper magnitudes <= four'};
}
export function oraclePoint(point,limit,options={}) {
  const initialBits=Math.max(192,point.bits||0,options.initialBits||0);
  const maximumBits=options.maximumBits??initialBits+4096;
  let result;
  for(let bits=initialBits;bits<=maximumBits;bits+=128){
    result=oracleAtPrecision(point,limit,bits);
    if(result.status!=='unresolved'){
      if(options.verifyHigherPrecision){
        for(const extra of [128,256]){
          const checked=oracleAtPrecision(point,limit,bits+extra);
          if(checked.status!==result.status||checked.escapeIteration!==result.escapeIteration)
            throw Error('Independent oracle is unstable at higher precision');
          if(checked.rgba.some((value,j)=>Math.abs(value-result.rgba[j])>1))
            throw Error('Independent oracle colour is unstable');
        }
      }
      return result;
    }
  }
  throw Error('Independent oracle unresolved: '+JSON.stringify(result));
}
export function oraclePixel(view,width,height,x,y,options={}) {
  const point=exactGridPoint(view,width,height,x,y);
  return oraclePoint(point,view.iterations,{...options,
    initialBits:Math.max(options.initialBits||0,view.bits+96,
      Math.ceil((-2*view.exponent+288)/32)*32)});
}
