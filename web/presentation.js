// Rectangles have disjoint interiors. Two passes keep completed scan bands
// compact, including adaptive tiles and out-of-order worker replies.
export function mergeRegions(regions) {
  const horizontal = [];
  regions.sort((a,b) => a.y-b.y || a.height-b.height || a.x-b.x);
  for (const r of regions) {
    const last = horizontal.at(-1);
    if (last && last.y === r.y && last.height === r.height && last.x+last.width === r.x)
      last.width += r.width;
    else horizontal.push({...r});
  }
  horizontal.sort((a,b) => a.x-b.x || a.width-b.width || a.y-b.y);
  const merged = [];
  for (const r of horizontal) {
    const last = merged.at(-1);
    if (last && last.x === r.x && last.width === r.width && last.y+last.height === r.y)
      last.height += r.height;
    else merged.push(r);
  }
  return merged;
}

export function createPresentation(frame, present, {now = () => performance.now(),
  setTimer = setTimeout, clearTimer = clearTimeout,
  requestFrame = requestAnimationFrame, cancelFrame = cancelAnimationFrame,
  retainPixels = true,
  failed = error => { throw error; }} = {}) {
  const dirty = new Set();
  const opening = new Set();
  const buffers = new Map(), BUFFER_LIMIT = 8*1024*1024;
  let timer = 0, raf = 0, disposed = false, last = -Infinity, interval = 125, cheap = 0;
  let count = 0, milliseconds = 0, canvasBytes = 0, bufferBytes = 0, peakBufferBytes = 0, visiblePixels = 0;
  frame.layer.style.background = 'transparent';
  for (const surface of frame.surfaces.values()) {
    surface.regions = []; surface.visibleRegions = [];surface.pixels=[];surface.fallback=[];
    surface.context.canvas.style.visibility = 'hidden';
  }
  function cancel() {
    clearTimer(timer); cancelFrame(raf); timer = raf = 0;
  }
  function retain(pixels) {
    if(!pixels)return null;
    const capacity=2**Math.ceil(Math.log2(pixels.byteLength));
    let buffer=buffers.get(capacity)?.pop();
    if(!buffer && bufferBytes+capacity<=BUFFER_LIMIT) {
      try{buffer=new Uint8ClampedArray(capacity);}catch{return null;}
      bufferBytes+=capacity;peakBufferBytes=Math.max(peakBufferBytes,bufferBytes);
    }
    if(!buffer)return null;
    buffer.set(pixels);return buffer;
  }
  function recycle(pixels) {
    const size=pixels.byteLength;
    if(!buffers.has(size))buffers.set(size,[]);
    buffers.get(size).push(pixels);
  }
  function releaseBuffers() {
    buffers.clear();bufferBytes=0;
    for(const surface of frame.surfaces.values())surface.pixels=surface.fallback=[];
  }
  function flush() {
    timer = raf = 0;
    if (disposed || !dirty.size) return;
    try {
    const started = now();
    for (const surface of dirty) {
      // Bound the first paint while fast frames are still completing. The
      // remaining completed areas stay queued for the next image update.
      if(!count && !opening.has(surface))continue;
      const canvas = surface.context.canvas;
      surface.regions = mergeRegions(surface.regions);
      if (!surface.display) {
        const visible = document.createElement('canvas');visible.width=canvas.width;visible.height=canvas.height;
        visible.setAttribute('aria-hidden','true');
        Object.assign(visible.style,{left:canvas.style.left,top:canvas.style.top,width:canvas.style.width,
          height:canvas.style.height});
        surface.display=visible.getContext('2d',{alpha:true});
        if(!surface.display){visible.width=0;throw Error('Presentation canvas allocation failed');}
        frame.layer.append(visible);
        canvasBytes+=visible.width*visible.height*4;
      }
      // Keep owned tile bytes until this batch. Overflow reads only dirty
      // regions from the CPU-backed output, without retaining canvas snapshots.
      for(const r of mergeRegions(surface.fallback))
        surface.display.putImageData(surface.context.getImageData(r.x,r.y,r.width,r.height),r.x,r.y);
      for(const r of surface.pixels){
        surface.display.putImageData(new ImageData(r.pixels.subarray(0,r.width*r.height*4),r.width,r.height),r.x,r.y);
        recycle(r.pixels);
      }
      surface.visibleRegions=mergeRegions(surface.visibleRegions.concat(surface.regions));
      visiblePixels+=surface.regions.reduce((sum,r)=>sum+r.width*r.height,0);
      surface.regions=[];surface.pixels=[];surface.fallback=[];
      dirty.delete(surface);
      if(now()-started>2)break;
    }
    last = now();
    const elapsed = last-started; milliseconds += elapsed; ++count;
    if (elapsed > 2) { interval = Math.min(500,interval*2); cheap = 0; }
    else if (++cheap >= 8) { interval = Math.max(125,interval/2); cheap = 0; }
    present({final:false,count,milliseconds,interval,pixels:visiblePixels});
    if(dirty.size)schedule();
    } catch(error) {failed(error);}
  }
  function schedule() {
    if (disposed || timer || raf) return;
    const wait = Math.max(0,last+interval-now());
    if (wait) timer = setTimer(() => { timer=0; raf=requestFrame(flush); },wait);
    else raf = requestFrame(flush);
  }
  return {
    note(surface,x,y,width,height,pixels) {
      if (disposed) return;
      if(!count && opening.size<2)opening.add(surface);
      const region={x,y,width,height},owned=retainPixels && (count || opening.has(surface))?retain(pixels):null;
      surface.regions.push(region);
      if(owned)surface.pixels.push({...region,pixels:owned});else surface.fallback.push(region);
      dirty.add(surface); schedule();
    },
    finish() {
      if (disposed) return;
      cancel(); dirty.clear();releaseBuffers();
      for (const surface of frame.surfaces.values()) {
        surface.context.canvas.style.visibility = 'visible';
        if(surface.display){surface.display.canvas.width=0;surface.display.canvas.remove();surface.display=null;}
        surface.regions = surface.visibleRegions = null;
      }
      disposed = true;
      present({final:true,count:++count,milliseconds,interval,pixels:frame.width*frame.height});
    },
    dispose(preserve=false) {
      disposed=true;cancel();dirty.clear();releaseBuffers();
      if(!preserve)for(const surface of frame.surfaces.values())if(surface.display){
        surface.display.canvas.width=0;surface.display.canvas.remove();surface.display=null;
      }
    },
    get count() { return count; },
    get peakCanvasBytes() { return canvasBytes; },
    get peakBufferBytes() { return peakBufferBytes; },
    get retainedBufferBytes() { return bufferBytes; },
    get milliseconds() { return milliseconds; }
  };
}
