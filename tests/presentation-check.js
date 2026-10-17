const {mergeRegions,createPresentation}=new Function(readText('web/presentation.js').replace(/^export /gm,'')+
  '\nreturn {mergeRegions,createPresentation};')();
const requirePresentation=(value,message)=>{if(!value)throw Error(message);};
{
  const merged=mergeRegions([{x:0,y:0,width:4,height:2},{x:4,y:0,width:4,height:2},
    {x:0,y:2,width:8,height:2},{x:0,y:5,width:2,height:1}]);
  requirePresentation(merged.length===2 && merged.some(r=>r.width===8 && r.height===4),'Adjacent rectangles did not merge');
}
{
  let time=0,sequence=0,cost=0;
  const tasks=new Map(),events=[];
  const schedule=(fn,delay)=>{const id=++sequence;tasks.set(id,{fn,at:time+delay});return id;};
  const advance=ms=>{const end=time+ms;for(;;){const next=[...tasks].filter(([,t])=>t.at<=end).sort((a,b)=>a[1].at-b[1].at)[0];
    if(!next)break;time=next[1].at;tasks.delete(next[0]);next[1].fn();}time=Math.max(time,end);};
  const element=()=>({style:{},children:[],append(child){this.children.push(child);},setAttribute(name,value){this[name]=value;
    },getContext(){return {canvas:this,drawImage(){time+=cost;},putImageData(){time+=cost;}};},remove(){this.removed=true;}});
  const document={createElement:element};
  const factory=new Function('document',readText('web/presentation.js').replace(/^export /gm,'')+'\nreturn createPresentation;')(document);
  const canvas={...element(),width:1024,height:1024},surface={context:{canvas,getImageData(){return {data:new Uint8ClampedArray(4)};}}};
  const frame={layer:element(),surfaces:new Map([['0,0',surface]])};
  const p=factory(frame,event=>events.push(event),{now:()=>time,setTimer:schedule,clearTimer:id=>tasks.delete(id),
    requestFrame:fn=>schedule(fn,16),cancelFrame:id=>tasks.delete(id)});
  p.note(surface,0,0,256,64);advance(15);requirePresentation(!events.length,'Presentation happened before the next frame');
  advance(1);requirePresentation(events.length===1 && surface.display,'First region stayed hidden');
  p.note(surface,256,0,256,64);p.note(surface,512,0,256,64);advance(124);
  requirePresentation(events.length===1,'Tile replies bypassed the image throttle');
  advance(17);requirePresentation(events.length===2 && surface.visibleRegions[0].width===768,'Batched regions missing');
  cost=3;p.note(surface,768,0,256,64);advance(141);
  requirePresentation(events.at(-1).interval===250,'Expensive presentation did not reduce its frequency');
  const display=surface.display.canvas;
  p.note(surface,0,64,1024,64);p.finish();
  requirePresentation(events.at(-1).final && !tasks.size && canvas.style.visibility==='visible' &&
    !surface.display && display.width===0 && display.removed,'Final pixels or display resources were retained');
  const total=events.length;advance(1000);requirePresentation(events.length===total,'Finished presentation scheduled more work');
}
report('Presentation: exact region merging, first-frame reveal, batched updates, adaptive throttling and final cleanup passed.');
{
  const surfaces=new Map(),scheduled=[],writes=[];let time=0;
  const document={createElement(){const canvas={style:{},width:0,height:0,setAttribute(){},remove(){},
    getContext(){return {canvas,drawImage(){writes.push('fallback');},putImageData(image){writes.push(image.data[0]);}};}};return canvas;}};
  const factory=new Function('document','ImageData',readText('web/presentation.js').replace(/^export /gm,'')+
    '\nreturn createPresentation;')(document,class{constructor(data){this.data=data;}});
  for(let i=0;i<3;i++)surfaces.set(i,{context:{canvas:{style:{},width:1024,height:1024},getImageData(){writes.push('fallback');return {data:new Uint8ClampedArray(4)};}}});
  const p=factory({layer:{style:{},append(){}},surfaces},()=>{},
    {now:()=>time,setTimer:fn=>{scheduled.push(fn);return scheduled.length;},clearTimer(){},requestFrame:fn=>{scheduled.push(fn);return scheduled.length;},cancelFrame(){}});
  const pixels=new Uint8ClampedArray(256*64*4);
  for(let i=0;i<129;i++){
    pixels[0]=i;p.note(surfaces.get(Math.floor(i/64)),i%4*256,Math.floor(i%64/4)*64,256,64,pixels);
  }
  pixels.fill(255);
  requirePresentation(!writes.length,'Unthrottled tile writes reached the display');
  scheduled.shift()();
  requirePresentation(writes.length===128 && !surfaces.get(2).display,'First paint exceeded its surface budget');
  time=125;while(scheduled.length)scheduled.shift()();
  requirePresentation(writes[0]===0 && writes[127]===127 && writes[128]==='fallback',
    'Returned worker bytes changed retained pixels or bounded overflow lost a region');
  requirePresentation(p.peakBufferBytes===8*1024*1024,'Retained tile pixels exceeded the memory cap');
  p.finish();requirePresentation(p.retainedBufferBytes===0,'Final presentation retained tile buffers');
}
report('Presentation: owned tile pixels, bounded buffer pool/overflow and release passed.');
{
  let reads=0,painted,flush;
  const source=new Uint8ClampedArray([7,8,9,255]);
  const canvas={style:{},width:1,height:1};
  const surface={context:{canvas,getImageData(){++reads;return {data:source};}}};
  const document={createElement(){const result={style:{},width:0,height:0,setAttribute(){},remove(){},
    getContext(){return {canvas:result,putImageData(image){painted=image.data[0];}};}};return result;}};
  const factory=new Function('document',readText('web/presentation.js').replace(/^export /gm,'')+
    '\nreturn createPresentation;')(document);
  const p=factory({width:1,height:1,layer:{style:{},append(){}},surfaces:new Map([[0,surface]])},()=>{},
    {retainPixels:false,now:()=>0,setTimer(){throw Error('Unexpected idle display timer');},
      requestFrame:fn=>{flush=fn;return 1;},cancelFrame(){},clearTimer(){}});
  const transferred=source.slice();p.note(surface,0,0,1,1,transferred);transferred.fill(0);
  requirePresentation(!reads && !p.peakBufferBytes,'Deferred display copied pixels before presentation');
  flush();requirePresentation(reads===1 && painted===7,'Deferred display lost completed source pixels');
  p.finish();
}
report('Presentation: fast views defer pixel copies until an actual display update.');
var testDone=true;
