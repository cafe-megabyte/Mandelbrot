var testDone=false;
(async()=>{
  const requireWorker=(value,message)=>{if(!value)throw Error(message);};
  const {writeCentre,createView}=new Function(readText('web/view.js').replace(/^export /gm,'')+'\nreturn {writeCentre,createView};')();
  const source=readText('web/preview-worker.js').replace(/^import .*$/gm,'');
  const module=new WebAssembly.Module(new Uint8Array(moduleBytes)),messages=[];
  let loseDevice,destroyed=false,submissionCount=0;
  class Canvas {
    constructor(width,height){this.width=width;this.height=height;}
    getContext(type){return type==='webgpu'?{configure(){},getCurrentTexture:()=>({createView(){return {};}})}:
      {putImageData:image=>{this.pixels=image.data.slice();}};}
    transferToImageBitmap(){return {pixels:this.pixels,close(){}};}
  }
  const device={lost:new Promise(resolve=>{loseDevice=resolve;}),destroy(){destroyed=true;},
    createShaderModule:()=>({getCompilationInfo:async()=>({messages:[]})}),
    createRenderPipelineAsync:async()=>({getBindGroupLayout(){return {};}}),
    createBuffer:()=>({}),createBindGroup:()=>({}),
    createCommandEncoder:()=>({beginRenderPass:()=>({setPipeline(){},setBindGroup(){},draw(){},end(){}}),finish(){return {};}}),
    queue:{writeBuffer(){},submit(){++submissionCount;},onSubmittedWorkDone:async()=>{}}};
  const self={navigator:{gpu:{requestAdapter:async()=>({requestDevice:async()=>device}),getPreferredCanvasFormat:()=> 'rgba8unorm'}},
    postMessage:message=>messages.push(message)};
  class Channel{constructor(){this.port1={close(){}};this.port2={close(){},postMessage:()=>Promise.resolve().then(()=>this.port1.onmessage())};}}
  new Function('writeCentre','self','navigator','OffscreenCanvas','GPUBufferUsage','ImageData','performance','MessageChannel',source)(
    writeCentre,self,self.navigator,Canvas,{UNIFORM:64,COPY_DST:8},class{constructor(data){this.data=data;}},{now:()=>0},Channel);
  await self.onmessage({data:{type:'init',module,gpu:true}});
  requireWorker(messages.at(-1).gpu===true,'GPU pipeline did not initialize');
  const view=createView().snapshot(16,8);
  await self.onmessage({data:{type:'render',id:1,backend:'webgpu',width:16,height:8,view}});
  requireWorker(messages.at(-1).backend==='webgpu' && submissionCount===1,'GPU result was not transferred');
  loseDevice();await Promise.resolve();
  await self.onmessage({data:{type:'render',id:2,backend:'webgpu',width:16,height:8,view}});
  requireWorker(messages.at(-1).type==='unavailable' && submissionCount===1,'Lost device was submitted more GPU work');
  await self.onmessage({data:{type:'render',id:3,backend:'wasm',width:16,height:8,view}});
  const result=messages.find(message=>message.id===3 && message.type==='preview');
  requireWorker(result?.backend==='wasm' && result.bitmap.pixels.length===16*8*4 &&
    result.bitmap.pixels.some((value,index)=>index%4!==3 && value>0),'Device loss did not leave the real WASM preview usable');
  const accurate=new WebAssembly.Instance(module,{}).exports;
  accurate.configure_view(16,8,view.centreReal,view.centreImag,view.mantissa*2**view.exponent,view.iterations);
  accurate.render_tile(0,0,16,8);
  const expected=new Uint8Array(accurate.memory.buffer,accurate.output_address(),16*8*4);
  requireWorker(result.bitmap.pixels.every((value,index)=>value===expected[index]),'Preview changed the original WASM pixels');
  const canceled=self.onmessage({data:{type:'render',id:4,backend:'wasm',width:160,height:80,view}});
  await Promise.resolve();await self.onmessage({data:{type:'cancel',id:4}});await canceled;
  requireWorker(!messages.some(m=>m.id===4&&m.type==='preview') && messages.at(-1).type==='done','Canceled CPU work did not yield and acknowledge');
  requireWorker(!destroyed,'Device loss test unexpectedly destroyed a healthy device');
  report('Preview worker: GPU pipeline/result ownership, lost-device rejection and real WASM bitmap fallback passed.');
  testDone=true;
})().catch(error=>report(String(error.stack||error)));
