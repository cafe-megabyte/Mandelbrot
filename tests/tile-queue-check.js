const viewSource = readText('web/view.js').replace(/^export /gm, '');
const queueSource = readText('web/tile-queue.js').replace(/^import .*$/gm, '').replace(/^export /gm, '');
const {createTileQueue, createView, renderBands} = new Function(viewSource + '\n' + queueSource + '\nreturn {createTileQueue,createView,renderBands};')();
function require(value, message) { if (!value) throw new Error(message); }
function coverage(w,h,view,compact,minPixels=1) {
  const q=createTileQueue(w,h,view,{compact,minPixels}), covered=new Uint8Array(w*h), mirrored=new Int32Array(h).fill(-1);
  const bands=renderBands(h,view,64).bands;
  for(const band of bands)if(band.mirrorY!==null)
    for(let row=0;row<band.height;row++)mirrored[band.y+row]=band.mirrorY+band.height-1-row;
  let count=0;
  for(let job;(job=q.take());){
    require(job.width>0 && job.width<=256 && job.height>0 && job.height<=64,'Invalid tile size');
    if(compact && w-job.x>=32)require(job.width>=32,'Compact split created an undersized horizontal child');
    if(job.width*job.height<Math.max(1,Math.ceil(minPixels)))
      require(job.x%256===0 && job.width===Math.min(256,w-job.x) &&
        bands.some(band=>band.y===job.y && band.height===job.height && band.mirrorY===job.mirrorY),
        'Adaptive split created a child below the pixel floor');
    for(let row=0;row<job.height;row++)
      require(mirrored[job.y+row]===(job.mirrorY===null?-1:job.mirrorY+job.height-1-row),'Split changed the conjugate row mapping');
    for(const y of job.mirrorY===null?[job.y]:[job.y,job.mirrorY])
      for(let r=0;r<job.height;r++)for(let x=0;x<job.width;x++)++covered[(y+r)*w+job.x+x];
    ++count; q.observe(100,job.width*job.height);
  }
  require(covered.every(n=>n===1),'Adaptive tiles overlap or miss pixels');
  require(count===q.total && q.exhausted,'Queue count drifted');
}
for (const [w,h] of [[1,1],[257,129],[511,130],[777,1026]]) for(const deep of [false,true])for(const compact of [false,true]) {
  const v=createView(); if(deep)v.set({real:'0',imag:'0',zoom:400});
  coverage(w,h,v.snapshot(w,h),compact);
}
// Exact half-pixel imaginary offsets exercise partial mirror coverage on both
// sides of the real axis, as well as an axis outside the visible frame.
for(const offset of [-200,-33,0,17,200])for(const compact of [false,true])for(const minPixels of [1,256])
  coverage(255,129,{deep:true,bits:160,imag:(BigInt(offset)<<59n).toString(),
    mantissa:1,exponent:-100,centreImag:offset*2**-101},compact,minPixels);
{
  const v=createView();v.set({real:'0',imag:'1',zoom:400});const view=v.snapshot(256,64);
  for(const [milliseconds,compactSize,originalSize] of [[96,[64,32],[256,8]],[768,[32,8],[256,1]]]) {
    for(const [compact,size] of [[true,compactSize],[false,originalSize]]) {
      const q=createTileQueue(256,64,view,{compact});q.observe(milliseconds,256*64);
      const job=q.take();require(job.width===size[0] && job.height===size[1],'Unexpected adaptive footprint');
    }
    const q=createTileQueue(256,64,view);q.observe(milliseconds,256*64);
    const job=q.take();require(job.width===originalSize[0] && job.height===originalSize[1],'Default subdivision changed');
  }
  for(const [minPixels,compactSize,originalSize] of [[256,[32,8],[256,1]],[255.1,[32,8],[256,1]],[512,[32,16],[256,2]],
    [0,[32,1],[32,1]],[-10,[32,1],[32,1]]])for(const [compact,size] of [[true,compactSize],[false,originalSize]]) {
    const q=createTileQueue(256,64,view,{compact,minPixels});q.observe(10000,32);
    const job=q.take();require(job.width===size[0] && job.height===size[1],'Pixel floor did not stop setup-driven subdivision');
  }
  for(const minPixels of [NaN,Infinity,-Infinity]) {
    let rejected=false;try{createTileQueue(256,64,view,{minPixels});}catch(error){rejected=error instanceof RangeError;}
    require(rejected,'Non-finite pixel floor was accepted');
  }
  for(const compact of [false,true])for(const minPixels of [256,512,20000]) {
    coverage(257,129,view,compact,minPixels);
    coverage(1,1,view,compact,minPixels);
  }
}
report('Adaptive tiles preserve exact coverage and conjugate rows in standard/compact modes; default subdivision, optional pixel floors and frame-edge exceptions passed.');
var testDone=true;
