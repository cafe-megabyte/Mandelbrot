// Optional shallow regression timing after changing the analytical predicates.
// node tests/performance-node.mjs tests/performance-hotspot-shallow.js
// Requires build/internal/cusp24/before/engine-simd.wasm.
const variants=['before','after'],engines={};
for(const name of variants){const path=name==='before'?'build/internal/cusp24/before/engine-simd.wasm':'build/internal/wasm/engine-simd.wasm';engines[name]=new WebAssembly.Instance(new WebAssembly.Module(new Uint8Array(readBytes(path))),{}).exports;}
const fixtures=[{name:'overview',real:-.75,imag:0,zoom:0},{name:'interior',real:0,imag:0,zoom:4},{name:'exterior',real:3,imag:2,zoom:2}],records=[];
const width=1024,height=768,median=a=>[...a].sort((a,b)=>a-b)[Math.floor(a.length/2)];
for(const f of fixtures){
 const images={},times={before:[],after:[]},spacing=Math.max(3/width,2.5/height)*2**-f.zoom;
 for(const name of variants){engines[name].configure_view(width,height,f.real,f.imag,spacing,768);images[name]=new Uint32Array(width*height);}
 for(let repeat=0;repeat<7;repeat++)for(const name of repeat%2?[...variants].reverse():variants){
  const e=engines[name],image=images[name],start=benchmarkNow();
  for(let y=0;y<height;y+=64)for(let x=0;x<width;x+=256){const w=Math.min(256,width-x),h=Math.min(64,height-y);e.render_tile(x,y,w,h);const src=new Uint32Array(e.memory.buffer,e.output_address(),w*h);for(let r=0;r<h;r++)image.set(src.subarray(r*w,(r+1)*w),(y+r)*width+x);}
  if(repeat>=2)times[name].push(benchmarkNow()-start);
 }
 let differentPixels=0;for(let p=0;p<width*height;p++)differentPixels+=images.before[p]!==images.after[p];
 const row={...f,width,height,times,mediansMs:Object.fromEntries(variants.map(n=>[n,median(times[n])])),differentPixels};records.push(row);report(JSON.stringify(row));
}
writeBytes('build/internal/cusp24/shallow.json',Array.from(JSON.stringify({runtime:benchmarkRuntime,method:'Two warmups then five alternating whole-image samples, one WASM instance per variant; render plus image copies.',records},null,2),c=>c.charCodeAt(0)));
var testDone=true;
