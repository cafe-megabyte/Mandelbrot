for (const variant of ['scalar','simd']) {
  const e = new WebAssembly.Instance(new WebAssembly.Module(new Uint8Array(readBytes(`build/internal/wasm/engine-${variant}.wasm`))), {}).exports;
  e.configure(640,360);
  for (let y=0;y<360;y+=64) for (let x=0;x<640;x+=256) e.render_tile(x,y,Math.min(256,640-x),Math.min(64,360-y));
  for (const [w,h] of [[1920,1080],[3840,2160],[7680,4320]]) {
    e.configure(w,h);
    const times=[];
    for (let repeat=0;repeat<3;++repeat) {
      const start=Date.now();
      for (let y=0;y<h;y+=64) for (let x=0;x<w;x+=256) e.render_tile(x,y,Math.min(256,w-x),Math.min(64,h-y));
      times.push(Date.now()-start);
    }
    times.sort((a,b)=>a-b);
    report(JSON.stringify({variant,width:w,height:h,iterations:e.iteration_limit(),medianMilliseconds:times[1],samples:times}));
  }
}
var testDone=true;
