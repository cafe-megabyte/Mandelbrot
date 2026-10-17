export function previewGPUFits(view,width,height) {
  const spacing = view.mantissa * 2 ** view.exponent;
  if (!(spacing > 0) || !Number.isFinite(spacing)) return false;
  for (const [centre,length] of [[view.centreReal,width],[view.centreImag,height]]) {
    const magnitude = Math.abs(centre)+spacing*length/2;
    const ulp = magnitude ? 2 ** (Math.floor(Math.log2(magnitude))-23) : 2 ** -149;
    if (!Number.isFinite(Math.fround(centre)) || ulp > spacing/4 ||
        Math.abs(Math.fround(centre)-centre) > spacing/4) return false;
  }
  return Math.fround(spacing) > 0;
}

export function createPreviewRenderer({module,engineOptions,snapshot,show,gpu=true,
  now=()=>performance.now(),setTimer=setTimeout,clearTimer=clearTimeout}) {
  let worker, ready=false, supported, busy, latest, timer=0, deadline=0, disposed=false;
  let sequence=0, last=-Infinity, resolution=160, moving=false, initializationTimer=0;
  let shownJob, targetRevision;
  let gpuAttempted=false;
  function initialize() {
    if (worker || disposed) return;
    let target;
    try { target=new Worker(new URL('./preview-worker.js',import.meta.url),{type:'module'}); }
    catch { latest=null;supported=false;return; }
    worker=target; ready=false;
    gpuAttempted=gpu && supported!==false && latest && previewGPUFits(latest.view,latest.width,latest.height);
    initializationTimer=setTimer(()=>{supported=false;reset();dispatch();},2000);
    target.onmessage=({data})=>{
      if (worker!==target || disposed) { data.bitmap?.close(); return; }
      if (data.type==='ready') { clearTimer(initializationTimer);initializationTimer=0;ready=true;supported=gpuAttempted?data.gpu:undefined;dispatch();return; }
      if (!busy || data.id!==busy.id) { data.bitmap?.close(); return; }
      clearTimer(deadline); deadline=0;
      const job=busy; busy=null;
      if (data.type==='preview') {
        const elapsed=Math.max(1,data.milliseconds);
        resolution=Math.max(64,Math.min(320,Math.round(resolution*Math.max(.5,Math.min(1.25,Math.sqrt(16/elapsed))))));
        if (moving || targetRevision===job.view.revision) {
          shownJob=job;
          show({...data,computeMilliseconds:data.milliseconds,milliseconds:now()-job.requestedAt,view:job.view,moving:job.moving});
        } else data.bitmap?.close();
      } else if (data.type==='unavailable') {
        supported=false;
        if (moving && !latest) latest={...job,backend:'wasm'};
      } else retry(job);
      dispatch();
    };
    target.onerror=()=>{ if (worker===target) { supported=false; reset(); } };
    target.postMessage({type:'init',module,engineOptions,gpu:!!gpuAttempted});
  }
  function reset() {
    clearTimer(deadline);clearTimer(initializationTimer);deadline=initializationTimer=0;
    worker?.terminate();worker=null;ready=false;busy=null;
  }
  function retry(job) {
    if(moving && !latest && resolution>64) {resolution=Math.max(64,Math.floor(resolution/2));request(job.size,true);}
  }
  function cancelCPU() {
    const job=busy;if(job?.backend!=='wasm' || job.cancelled)return;
    job.cancelled=true;clearTimer(deadline);
    worker.postMessage({type:'cancel',id:job.id});
    // Exact work starts immediately. Kill only a worker that cannot acknowledge
    // cancellation between its bounded WASM chunks.
    deadline=setTimer(()=>{deadline=0;if(busy!==job)return;reset();dispatch();},32);
  }
  function dispatch() {
    if (disposed || busy || !latest) return;
    if (!worker) initialize();
    if (!ready) return;
    const wait=last+1000/30-now();
    if (wait>0) { if (!timer) timer=setTimer(()=>{timer=0;dispatch();},wait); return; }
    const job=latest;
    if(gpu && supported===undefined && !gpuAttempted && previewGPUFits(job.view,job.width,job.height)){
      gpuAttempted=true;ready=false;
      initializationTimer=setTimer(()=>{supported=false;reset();dispatch();},2000);
      worker.postMessage({type:'gpu-init'});return;
    }
    latest=null;
    job.backend=supported && previewGPUFits(job.view,job.width,job.height)?'webgpu':'wasm';
    if (job.backend==='wasm' && !moving) return;
    busy=job; last=now();
    if (job.backend==='wasm') deadline=setTimer(()=>{
      deadline=0; if (busy!==job) return;
      cancelCPU();retry(job);
    },32);
    const {size,requestedAt,...message}=job;
    worker.postMessage({type:'render',...message});
  }
  function request(size,active) {
    if (disposed || !size.width || !size.height) return;
    moving=active;targetRevision=size.view.revision;
    const scale=Math.min(1,resolution/Math.max(size.width,size.height));
    const width=Math.max(1,Math.round(size.width*scale)),height=Math.max(1,Math.round(size.height*scale));
    const view={...snapshot(size.cssWidth,size.cssHeight,width,height),
      iterations:Math.min(size.view.iterations,active?512:2048)};
    if(!active) {
      cancelCPU();
      // Never initialize another worker for an idle view that cannot use GPU.
      if(!gpu || supported===false || !previewGPUFits(view,width,height)) {
        latest=null;clearTimer(timer);timer=0;if(worker && !ready)reset();return;
      }
      const same=job=>job && job.view.revision===view.revision &&
        job.size.cssWidth===size.cssWidth && job.size.cssHeight===size.cssHeight;
      if(same(shownJob) || same(busy)) {latest=null;clearTimer(timer);timer=0;return;}
      if(same(latest))return;
    }
    latest={id:++sequence,width,height,view,moving:active,size,requestedAt:now()};
    dispatch();
  }
  return {
    request,
    stop() { moving=false; latest=null;clearTimer(timer);timer=0;cancelCPU(); },
    dispose() { disposed=true;latest=null;clearTimer(timer);timer=0;reset(); }
  };
}
