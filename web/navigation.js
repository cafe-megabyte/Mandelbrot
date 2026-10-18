export function createNavigation(root,view,changed) {
  const points=new Map();let gesture, moved=false, suppressUntil=0, wheelTimer, safariTimer, safariScale=0, safariMoving=false, safariTarget;
  const point=event=>{const r=root.getBoundingClientRect();return {x:event.clientX-r.left,y:event.clientY-r.top};};
  function geometry(){
    const p=[...points.values()];
    return p.length>1?{x:(p[0].x+p[1].x)/2,y:(p[0].y+p[1].y)/2,d:Math.hypot(p[0].x-p[1].x,p[0].y-p[1].y)}:
      {...p[0],d:0};
  }
  function down(event){
    if(event.button!==0)return;
    points.set(event.pointerId,point(event));
    try {root.setPointerCapture(event.pointerId);} catch {}
    gesture=geometry();if(points.size===1)moved=false;
    else {moved=true;suppressUntil=performance.now()+500;}
  }
  function move(event){
    if(!points.has(event.pointerId))return;
    const p=point(event),old=points.get(event.pointerId);
    if(!moved && Math.hypot(p.x-old.x,p.y-old.y)<3)return;
    points.set(event.pointerId,p);const next=geometry(),rect=root.getBoundingClientRect();
    const factor=gesture.d&&next.d?next.d/gesture.d:1;
    view.change(factor,gesture,next,rect.width,rect.height);
    gesture=next;moved=true;suppressUntil=performance.now()+500;changed(true);
  }
  function up(event){
    if(!points.delete(event.pointerId))return;
    if(root.hasPointerCapture(event.pointerId))root.releasePointerCapture(event.pointerId);
    if(points.size)gesture=geometry();
    else {gesture=null;if(moved){suppressUntil=performance.now()+500;changed(false);}}
  }
  function wheel(event){
    // Safari can deliver both event families for a trackpad pinch. Cancel its
    // page magnification even when the gesture handler owns the app zoom.
    event.preventDefault();if(safariMoving)return;
    const p=point(event),r=root.getBoundingClientRect();
    const delta=event.deltaY*(event.deltaMode===1?16:event.deltaMode===2?r.height:1);
    if(!delta)return;
    view.change(2**Math.max(-2,Math.min(2,-delta*(event.ctrlKey?0.012:0.003))),p,p,r.width,r.height);
    suppressUntil=performance.now()+500;changed(true);clearTimeout(wheelTimer);
    wheelTimer=setTimeout(()=>changed(false),150);
  }
  function drag(event){event.preventDefault();}
  function key(event){
    if(event.ctrlKey||event.metaKey||event.altKey)return;
    if(event.key==='Home'||event.key.toLowerCase()==='r'){event.preventDefault();view.reset();changed(false);}
  }
  function safariStart(event){
    event.preventDefault();if(points.size)return;
    safariReleaseTarget();safariTarget=new WeakRef(event.target);
    // Previews replace canvases/PNGs during a pinch. Safari may keep sending
    // events to that starting element after it has left the document.
    // The weak reference does not retain an old full-resolution raster when
    // Safari drops its target without delivering gestureend.
    event.target.addEventListener('gesturechange',safariDetachedChange,{passive:false});
    event.target.addEventListener('gestureend',safariDetachedEnd,{passive:false});
    safariScale=Number.isFinite(event.scale)&&event.scale>0?event.scale:1;safariActivity();
  }
  function safariReleaseTarget(){
    const target=safariTarget?.deref();
    target?.removeEventListener('gesturechange',safariDetachedChange);
    target?.removeEventListener('gestureend',safariDetachedEnd);safariTarget=null;
  }
  function safariDetachedChange(event){if(!event.target.isConnected)safariChange(event);}
  function safariDetachedEnd(event){if(!event.target.isConnected)safariEnd(event);}
  function safariFinish(reset=true){
    clearTimeout(safariTimer);safariTimer=0;if(reset){safariScale=0;safariReleaseTarget();}
    if(!safariMoving)return;
    safariMoving=false;suppressUntil=performance.now()+500;changed(false);
  }
  function safariActivity(){
    clearTimeout(wheelTimer);clearTimeout(safariTimer);
    safariMoving=true;suppressUntil=performance.now()+500;changed(true);
    // A lost gestureend must not hold the renderer forever. Keep the last
    // cumulative scale so a gesture continuing after a pause uses its delta.
    safariTimer=setTimeout(()=>safariFinish(false),150);
  }
  function safariChange(event){
    if(!safariScale)return;event.preventDefault();
    if(points.size||!Number.isFinite(event.scale)||event.scale<=0)return;
    const r=root.getBoundingClientRect(),p=Number.isFinite(event.clientX)&&Number.isFinite(event.clientY)?point(event):{x:r.width/2,y:r.height/2};
    view.change(event.scale/safariScale,p,p,r.width,r.height);safariScale=event.scale;safariActivity();
  }
  function safariEnd(event){if(!safariScale)return;event.preventDefault();safariFinish();}
  function safariCancel(){safariFinish();}
  root.style.touchAction='none';
  root.addEventListener('pointerdown',down);root.addEventListener('pointermove',move);
  root.addEventListener('pointerup',up);root.addEventListener('pointercancel',up);
  root.addEventListener('lostpointercapture',up);root.addEventListener('wheel',wheel,{passive:false});
  root.addEventListener('dragstart',drag);window.addEventListener('keydown',key);
  root.addEventListener('gesturestart',safariStart,{passive:false});
  // Track the rest of our gesture even if Safari retargets it outside root.
  window.addEventListener('gesturechange',safariChange,{passive:false,capture:true});
  window.addEventListener('gestureend',safariEnd,{passive:false,capture:true});
  window.addEventListener('blur',safariCancel);window.addEventListener('pagehide',safariCancel);
  return {suppressClick:()=>points.size>0||performance.now()<suppressUntil,
    dispose(){clearTimeout(wheelTimer);clearTimeout(safariTimer);safariReleaseTarget();for(const [name,fn]of[['pointerdown',down],['pointermove',move],['pointerup',up],
      ['pointercancel',up],['lostpointercapture',up],['wheel',wheel],['dragstart',drag],['gesturestart',safariStart]])root.removeEventListener(name,fn);
      window.removeEventListener('gesturechange',safariChange,true);window.removeEventListener('gestureend',safariEnd,true);
      window.removeEventListener('blur',safariCancel);window.removeEventListener('pagehide',safariCancel);
      window.removeEventListener('keydown',key);points.clear();}};
}
