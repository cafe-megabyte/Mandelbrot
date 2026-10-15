// Coordinates use binary fixed point; only input geometry uses ordinary doubles.
// Increasing precision appends zero bits, so a chosen point never jumps.
export function decimalFixed(text, bits) {
  const match = /^([+-]?)(\d*)(?:\.(\d*))?(?:e([+-]?\d+))?$/i.exec(String(text));
  if (!match || !(match[2] || match[3])) throw new Error('Invalid coordinate');
  const places = (match[3] || '').length - Number(match[4] || 0);
  let n = BigInt((match[2] || '0') + (match[3] || ''));
  n = places >= 0 ? (n << BigInt(bits)) / (10n ** BigInt(places)) : (n * 10n ** BigInt(-places)) << BigInt(bits);
  return match[1] === '-' ? -n : n;
}
function fixedDouble(value, exponent, bits) {
  if (!value) return 0n;
  const sign = value < 0 ? -1n : 1n; value = Math.abs(value);
  const e = Math.floor(Math.log2(value));
  const significand = BigInt(Math.round(value * 2 ** (52-e)));
  const shift = bits + exponent + e - 52;
  return sign * (shift >= 0 ? significand << BigInt(shift) : significand >> BigInt(-shift));
}
export function fixedNumber(value, bits) {
  if (!value) return 0;
  const sign = value < 0n ? -1 : 1; value = value < 0n ? -value : value;
  const shift = Math.max(0, value.toString(2).length-53);
  return sign * Number(value >> BigInt(shift)) * 2 ** (shift-bits);
}
// A binary fixed-point number has a terminating decimal expansion. Keep every
// digit: converting the absolute coordinate to Number would lose deep pans.
export function fixedDecimal(value, bits) {
  value = BigInt(value);
  if (!value) return '0';
  const sign = value < 0n ? '-' : ''; value = value < 0n ? -value : value;
  while (bits && !(value & 1n)) { value >>= 1n; --bits; }
  if (!bits) return sign + value.toString();
  const digits = (value * 5n ** BigInt(bits)).toString().padStart(bits+1, '0');
  return sign + digits.slice(0, -bits) + '.' + digits.slice(-bits);
}
export function viewFragment(view) {
  const x = fixedDecimal(view.real, view.bits), y = fixedDecimal(view.imag, view.bits);
  if (!view.zoom && x === '-0.75' && y === '0') return '';
  return `#x=${x}&y=${y}&zoom=${view.zoom}`;
}
export function viewFromFragment(fragment) {
  try {
    const fields = new Map();
    for (const entry of fragment.replace(/^#/, '').split('&')) {
      const [name, ...rest] = entry.split('=');
      if (!['x','y','zoom'].includes(name)) continue;
      if (fields.has(name)) return null;
      fields.set(name, decodeURIComponent(rest.join('=')));
    }
    const real = fields.get('x'), imag = fields.get('y'), level = fields.get('zoom');
    // Our links contain plain decimal coordinates, never rounded doubles or
    // huge decimal exponents that could allocate unbounded powers of ten.
    const decimal = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/;
    if (!decimal.test(real || '') || !decimal.test(imag || '') || !level?.trim()) return null;
    const zoom = Number(level);
    if (!Number.isFinite(zoom) || zoom < 0 || 512+256*Math.ceil(zoom) > 0x7fffffbf) return null;
    // An exact binary decimal with k fractional digits needs at most k bits.
    // This also preserves guard bits retained after zooming back out.
    const places = text => (text.split('.')[1] || '').length;
    const bits = Math.ceil(Math.max(160,zoom+160,places(real),places(imag))/32)*32;
    return {real, imag, zoom, bits};
  } catch { return null; }
}
export function createView(saved) {
  let bits = 160, real = decimalFixed('-0.75',bits), imag = 0n, zoom = 0, revision = 0;
  if(saved){bits=saved.bits;real=BigInt(saved.real);imag=BigInt(saved.imag);zoom=saved.zoom;revision=saved.revision;}
  function precision(minimum=160) {
    const next = Math.ceil(Math.max(minimum,160,zoom+160)/32)*32;
    if (next>bits) { real <<= BigInt(next-bits); imag <<= BigInt(next-bits); bits=next; }
  }
  function scale(width,height) {
    const base = Math.max(3/width,2.5/height), exponent = Math.floor(Math.log2(base)-zoom);
    return {mantissa: 2 ** (Math.log2(base)-zoom-exponent), exponent};
  }
  function snapshot(width,height,physicalWidth=width,physicalHeight=height*physicalWidth/width) {
    precision();
    const base=Math.max(3/physicalWidth,2.5/physicalHeight), exponent=Math.floor(Math.log2(base)-zoom);
    const physical=base*2**(-zoom-exponent);
    const level=Math.max(0,-9-exponent-Math.log2(physical));
    const iterations=Math.max(512,512+256*Math.ceil(level));
    if (!Number.isSafeInteger(iterations) || iterations>0x7fffffbf) throw new Error('Iteration memory exhausted');
    const deep=exponent+Math.log2(physical)<-26;
    const perturb=deep && exponent < -80;
    return {revision,zoom,bits,real:real.toString(),imag:imag.toString(),mantissa:physical,exponent,
      iterations,deep,perturb,centreReal:fixedNumber(real,bits),centreImag:fixedNumber(imag,bits)};
  }
  function change(factor,from,to,width,height) {
    const before=scale(width,height);zoom=Math.max(0,zoom+Math.log2(factor));precision();
    const after=scale(width,height);
    real += fixedDouble((from.x-width/2)*before.mantissa,before.exponent,bits)-
      fixedDouble((to.x-width/2)*after.mantissa,after.exponent,bits);
    imag += fixedDouble((height/2-from.y)*before.mantissa,before.exponent,bits)-
      fixedDouble((height/2-to.y)*after.mantissa,after.exponent,bits);
    if (!zoom) {real=decimalFixed('-0.75',bits);imag=0n;}
    ++revision;
  }
  function set({real:r='-0.75',imag:i='0',zoom:z=0,bits:minimum=160}) {
    if(!Number.isFinite(z)||z<0)throw new Error('Invalid zoom');
    if(!Number.isSafeInteger(minimum)||minimum<0||minimum>0x7fffffbf)throw new Error('Invalid precision');
    zoom=z;precision(minimum);real=decimalFixed(r,bits);imag=decimalFixed(i,bits);++revision;
  }
  function reset(){set({});}
  return {snapshot,change,set,reset};
}
export function previewTransform(before,after,width,height) {
  if (!before || !after) return '';
  const factor=2 ** (after.zoom-before.zoom);
  if(!Number.isFinite(factor)||factor<1e-6||factor>1e6)return '';
  const bits=Math.max(before.bits,after.bits);
  const dr=(BigInt(before.real)<<BigInt(bits-before.bits))-(BigInt(after.real)<<BigInt(bits-after.bits));
  const di=(BigInt(before.imag)<<BigInt(bits-before.bits))-(BigInt(after.imag)<<BigInt(bits-after.bits));
  // Convert the SMALL difference, never the absolute coordinates, to pixels.
  const base=Math.max(3/width,2.5/height), e=Math.floor(Math.log2(base)-after.zoom);
  const denominator=2 ** (Math.log2(base)-after.zoom-e);
  const x=fixedNumber(dr,bits+e)/denominator,y=-fixedNumber(di,bits+e)/denominator;
  return `translate(${x}px,${y}px) scale(${factor})`;
}
export function writeCentre(engine,view) {
  const n=engine.deep_digits(),out=new Uint32Array(engine.memory.buffer,engine.deep_input_address(),2*n);
  out.fill(0);
  for(const [index,text] of [view.real,view.imag].entries()) {
    let value=BigInt(text);if(value<0n)value=-value;
    const shift=n*32-32-view.bits;
    value=shift>=0?value<<BigInt(shift):value>>BigInt(-shift);
    for(let j=0;j<n;++j){out[index*n+j]=Number(value&0xffffffffn);value>>=32n;}
  }
}
