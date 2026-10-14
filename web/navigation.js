export function createNavigation(root,view,changed) {
  const points=new Map();let gesture, moved=false, suppressUntil=0, wheelTimer, safariScale=0;
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
    if(safariScale)return;
    event.preventDefault();const p=point(event),r=root.getBoundingClientRect();
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
    safariScale=event.scale||1;suppressUntil=performance.now()+500;changed(true);
  }
  function safariChange(event){
    event.preventDefault();if(!safariScale||points.size)return;
    const r=root.getBoundingClientRect(),p=Number.isFinite(event.clientX)?point(event):{x:r.width/2,y:r.height/2};
    view.change(event.scale/safariScale,p,p,r.width,r.height);safariScale=event.scale;changed(true);
  }
  function safariEnd(event){event.preventDefault();if(!safariScale)return;safariScale=0;suppressUntil=performance.now()+500;changed(false);}
  root.style.touchAction='none';
  root.addEventListener('pointerdown',down);root.addEventListener('pointermove',move);
  root.addEventListener('pointerup',up);root.addEventListener('pointercancel',up);
  root.addEventListener('lostpointercapture',up);root.addEventListener('wheel',wheel,{passive:false});
  root.addEventListener('dragstart',drag);window.addEventListener('keydown',key);
  root.addEventListener('gesturestart',safariStart,{passive:false});root.addEventListener('gesturechange',safariChange,{passive:false});
  root.addEventListener('gestureend',safariEnd,{passive:false});
  return {suppressClick:()=>points.size>0||performance.now()<suppressUntil,
    dispose(){clearTimeout(wheelTimer);for(const [name,fn]of[['pointerdown',down],['pointermove',move],['pointerup',up],
      ['pointercancel',up],['lostpointercapture',up],['wheel',wheel],['dragstart',drag],['gesturestart',safariStart],
      ['gesturechange',safariChange],['gestureend',safariEnd]])root.removeEventListener(name,fn);
      window.removeEventListener('keydown',key);points.clear();}};
}
