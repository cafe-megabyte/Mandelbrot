const requirePreview=(value,message)=>{if(!value)throw Error(message);};
const viewAPI=new Function(readText('web/view.js').replace(/^export /gm,'')+'\nreturn {createView};')();
let time=0,sequence=0;
const tasks=new Map(),workers=[],shown=[];
const schedule=(fn,delay)=>{const id=++sequence;tasks.set(id,{fn,at:time+delay});return id;};
function advance(ms){const end=time+ms;for(;;){const next=[...tasks].filter(([,t])=>t.at<=end).sort((a,b)=>a[1].at-b[1].at)[0];
  if(!next)break;time=next[1].at;tasks.delete(next[0]);next[1].fn();}time=end;}
class PreviewWorker {
  constructor(){workers.push(this);this.jobs=[];this.messages=[];}
  postMessage(data){this.messages.push(data);if(data.type==='render')this.jobs.push(data);}
  emit(data){this.onmessage({data});}
  terminate(){this.terminated=true;}
}
const {createPreviewRenderer,previewGPUFits}=new Function('Worker','URL',readText('web/preview.js')
  .replace(/^export /gm,'').replace(/import\.meta/g,'({url:"https://test.invalid/"})')+
  '\nreturn {createPreviewRenderer,previewGPUFits};')(PreviewWorker,class {});
const v=viewAPI.createView();
const size=()=>({width:1000,height:500,cssWidth:1000,cssHeight:500,view:v.snapshot(1000,500)});
const p=createPreviewRenderer({module:{},snapshot:(...args)=>v.snapshot(...args),show:data=>shown.push(data),
  now:()=>time,setTimer:schedule,clearTimer:id=>tasks.delete(id)});
requirePreview(!workers.length,'Preview initialization blocked renderer construction');
requirePreview(previewGPUFits(v.snapshot(1000,500,160,80),160,80),'Overview rejected by GPU precision check');
v.set({real:'-0.75',imag:'0',zoom:40});
requirePreview(!previewGPUFits(v.snapshot(1000,500,160,80),160,80),'Collapsed f32 coordinates accepted');
v.set({real:'0',imag:'1',zoom:1600});
requirePreview(!previewGPUFits(v.snapshot(1000,500,160,80),160,80),'Underflowed spacing accepted');
v.reset();p.request(size(),true);const w=workers[0];w.emit({type:'ready',gpu:true});
requirePreview(w.jobs.length===1 && w.jobs[0].view.iterations<=512,'Live preview budget missing');
v.set({real:'-0.7',imag:'0',zoom:1});p.request(size(),true);
v.set({real:'-0.6',imag:'0',zoom:2});p.request(size(),true);
requirePreview(w.jobs.length===1,'More than one preview was submitted');
w.emit({type:'preview',id:w.jobs[0].id,bitmap:{close(){}},milliseconds:16});
requirePreview(shown.length===1,'Moving preview was not available for transformation');
advance(34);requirePreview(w.jobs.length===2 && w.jobs[1].view.zoom===2,'Pending target was not replaced by the latest input');
w.emit({type:'unavailable',id:w.jobs[1].id});advance(34);
requirePreview(w.jobs.at(-1).backend==='wasm','GPU failure did not fall back to WASM');
const staleID=w.jobs.at(-1).id;p.request(size(),false);
requirePreview(w.messages.some(m=>m.type==='cancel'&&m.id===staleID),'Accurate render did not cancel CPU preview work');
advance(33);requirePreview(w.terminated,'Unresponsive CPU preview exceeded its hard cancellation budget');
const stale={closed:false,close(){this.closed=true;}};w.emit({type:'preview',id:staleID,bitmap:stale});
requirePreview(stale.closed,'A stale bitmap was retained');
p.dispose();requirePreview(!tasks.size,'Disposed preview retained timers');
{
  v.reset();
  const q=createPreviewRenderer({module:{},snapshot:(...args)=>v.snapshot(...args),show(){},
    now:()=>time,setTimer:schedule,clearTimer:id=>tasks.delete(id)});
  q.request(size(),true);const gpuWorker=workers.at(-1);gpuWorker.emit({type:'ready',gpu:true});
  const id=gpuWorker.jobs[0].id;
  gpuWorker.emit({type:'preview',id,bitmap:{close(){}},milliseconds:4});
  q.request(size(),false);advance(100);
  requirePreview(gpuWorker.jobs.length===1,'Idle selection recomputed an already matching GPU preview');
  q.dispose();
  v.set({real:'-0.75',imag:'0',zoom:100});const count=workers.length;
  const r=createPreviewRenderer({module:{},snapshot:(...args)=>v.snapshot(...args),show(){},
    now:()=>time,setTimer:schedule,clearTimer:id=>tasks.delete(id)});
  r.request(size(),false);
  requirePreview(workers.length===count,'Idle deep view initialized an unusable GPU worker');
  r.request(size(),true);const cpuWorker=workers.at(-1);cpuWorker.emit({type:'ready',gpu:true});
  requirePreview(cpuWorker.jobs[0].backend==='wasm','Deep moving view did not receive WASM work');
  r.request(size(),false);
  requirePreview(cpuWorker.messages.some(m=>m.type==='cancel') && workers.length===count+1,'CPU cancellation reinitialized GPU during exact rendering');
  r.dispose();requirePreview(!tasks.size,'Preview reuse/cancellation retained timers');
}
{
  const q=createPreviewRenderer({module:{},snapshot:(...args)=>v.snapshot(...args),show(){},
    now:()=>time,setTimer:schedule,clearTimer:id=>tasks.delete(id)});
  q.request(size(),true);const w=workers.at(-1);w.emit({type:'ready',gpu:false});
  const old=w.jobs[0];v.reset();q.request(size(),true);w.emit({type:'done',id:old.id});advance(34);
  requirePreview(w.messages.some(m=>m.type==='gpu-init'),'Zooming out did not enable GPU on a CPU-only worker');
  w.emit({type:'ready',gpu:true});advance(34);
  requirePreview(w.jobs.at(-1).backend==='webgpu','Precision recovery did not use GPU');q.dispose();
}
report('Preview: f32 eligibility, bounded in-flight work, latest target, rate limit, GPU failure, WASM cancellation and bitmap cleanup passed.');
var testDone=true;
