import {writeCentre} from './view.js';

const shader = `
struct View { centre: vec2f, spacing: f32, width: f32, height: f32, iterations: u32, padding: vec2f }
@group(0) @binding(0) var<uniform> view: View;
@vertex fn vertex(@builtin(vertex_index) i:u32)->@builtin(position) vec4f {
  let positions=array<vec2f,3>(vec2f(-1,-1),vec2f(3,-1),vec2f(-1,3));
  return vec4f(positions[i],0,1);
}
fn colour(n:u32,magnitude:f32)->vec4f {
  let smoothValue=f32(n)+1-log2(0.5*log2(magnitude));
  let index=f32(u32(i32(floor(smoothValue*96))) & 4095u);
  let stops=array<f32,7>(0,655,1638,1966,2703,3522,4096);
  let colours=array<vec3f,7>(vec3f(0,7,100),vec3f(32,107,203),vec3f(180,255,255),
    vec3f(255,245,208),vec3f(255,170,0),vec3f(55,13,91),vec3f(0,7,100));
  for(var s=0u;s<6u;s++) { if(index<stops[s+1u]) {
    return vec4f(mix(colours[s],colours[s+1u],(index-stops[s])/(stops[s+1u]-stops[s]))/255,1);
  }}
  return vec4f(0,0,0,1);
}
@fragment fn fragment(@builtin(position) p:vec4f)->@location(0) vec4f {
  let c=view.centre+vec2f(p.x-view.width/2,view.height/2-p.y)*view.spacing;
  let q=(c.x-0.25)*(c.x-0.25)+c.y*c.y;
  if(q*(q+c.x-0.25)<0.25*c.y*c.y || (c.x+1)*(c.x+1)+c.y*c.y<0.0625) { return vec4f(0,0,0,1); }
  var x=0.0;var y=0.0;var xx=0.0;var yy=0.0;
  for(var n=1u;n<=view.iterations;n++) {
    y=2*x*y+c.y;x=xx-yy+c.x;xx=x*x;yy=y*y;
    if(xx+yy>4) { return colour(n,xx+yy); }
  }
  return vec4f(0,0,0,1);
}`;
let module, engineOptions, engine, device, pipeline, context, canvas, uniform, bindGroup, activeCPU;

function yieldTask(){return new Promise(resolve=>{
  const channel=new MessageChannel();channel.port1.onmessage=()=>{channel.port1.close();channel.port2.close();resolve();};
  channel.port2.postMessage(0);
});}

async function initializeGPU() {
  if (!self.navigator?.gpu || typeof OffscreenCanvas==='undefined') throw Error('WebGPU or OffscreenCanvas is unavailable in this worker');
  const adapter=await navigator.gpu.requestAdapter();
  if (!adapter) throw Error('No WebGPU adapter is available');
  device=await adapter.requestDevice();
  device.lost.then(()=>{ device=null;pipeline=null; });
  canvas=new OffscreenCanvas(1,1);context=canvas.getContext('webgpu');
  if (!context) throw Error('WebGPU OffscreenCanvas context is unavailable');
  const format=navigator.gpu.getPreferredCanvasFormat();
  context.configure({device,format,alphaMode:'opaque'});
  const code=device.createShaderModule({code:shader});
  const errors=(await code.getCompilationInfo()).messages.filter(message=>message.type==='error');
  if(errors.length)throw Error(errors.map(message=>`${message.lineNum}:${message.linePos} ${message.message}`).join('\n'));
  pipeline=await device.createRenderPipelineAsync({layout:'auto',vertex:{module:code,entryPoint:'vertex'},
    fragment:{module:code,entryPoint:'fragment',targets:[{format}]},primitive:{topology:'triangle-list'}});
  uniform=device.createBuffer({size:32,usage:GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST});
  bindGroup=device.createBindGroup({layout:pipeline.getBindGroupLayout(0),entries:[{binding:0,resource:{buffer:uniform}}]});
  return true;
}

async function renderGPU(job) {
  if (!device || !pipeline) { self.postMessage({type:'unavailable',id:job.id});return; }
  const started=performance.now();canvas.width=job.width;canvas.height=job.height;
  const values=new Float32Array(8);
  values.set([job.view.centreReal,job.view.centreImag,job.view.mantissa*2**job.view.exponent,job.width,job.height]);
  new Uint32Array(values.buffer)[5]=job.view.iterations;device.queue.writeBuffer(uniform,0,values);
  const encoder=device.createCommandEncoder();
  const pass=encoder.beginRenderPass({colorAttachments:[{view:context.getCurrentTexture().createView(),
    clearValue:{r:0,g:0,b:0,a:1},loadOp:'clear',storeOp:'store'}]});
  pass.setPipeline(pipeline);pass.setBindGroup(0,bindGroup);pass.draw(3);pass.end();
  device.queue.submit([encoder.finish()]);await device.queue.onSubmittedWorkDone();
  const bitmap=canvas.transferToImageBitmap();
  self.postMessage({type:'preview',id:job.id,backend:'webgpu',width:job.width,height:job.height,
    iterations:job.view.iterations,milliseconds:performance.now()-started,bitmap},[bitmap]);
}

async function renderWASM(job,token) {
  const started=performance.now(),view=job.view;
  if (!engine) {
    if (WebAssembly.Module.imports(module).length) throw Error('Unexpected WASM imports');
    engine=new WebAssembly.Instance(module,{}).exports;
    if (engine.abi_version()!==1) throw Error('Unsupported WASM ABI');
    if (engineOptions!==undefined) engine.deep_set_options(engineOptions);
  }
  await yieldTask();if(token.cancelled)return;
  let bits=Math.max(view.bits,Math.ceil((-2*view.exponent+192)/32)*32);
  if (view.deep) {
    if (!engine.deep_allocate(bits,view.iterations)) return;
    if (engine.memory.buffer.byteLength>16*1024*1024) return;
    writeCentre(engine,view);
    if (view.perturb) {
      engine.deep_begin(BigInt(view.real)<0n?-1:1,BigInt(view.imag)<0n?-1:1,
        view.mantissa,view.exponent,job.width,job.height);
      for(;;){
        if(token.cancelled || performance.now()-started>28)return;
        if(engine.deep_reference(32))break;
        await yieldTask();
      }
      if (engine.deep_needs_precision()) return;
      engine.deep_finish();
    }
    if (!engine.deep_configure(job.width,job.height,view.mantissa,view.exponent,view.iterations,
      BigInt(view.real)<0n?-1:1,BigInt(view.imag)<0n?-1:1)) return;
  } else if (!engine.configure_view(job.width,job.height,view.centreReal,view.centreImag,
    view.mantissa*2**view.exponent,view.iterations)) return;
  const pixels=new Uint8ClampedArray(job.width*job.height*4);
  let chunks=0;
  for(let y=0;y<job.height;y+=8)for(let x=0;x<job.width;x+=64) {
    if(token.cancelled || performance.now()-started>28)return;
    const w=Math.min(64,job.width-x),h=Math.min(8,job.height-y);
    const bytes=view.deep?engine.deep_render_tile(x,y,w,h):engine.render_tile(x,y,w,h);
    if(!bytes)return;
    const tile=new Uint8Array(engine.memory.buffer,engine.output_address(),bytes);
    for(let row=0;row<h;row++)pixels.set(tile.subarray(row*w*4,(row+1)*w*4),((y+row)*job.width+x)*4);
    if(++chunks%4===0)await yieldTask();
  }
  if(token.cancelled)return;
  const output=new OffscreenCanvas(job.width,job.height);
  output.getContext('2d',{alpha:false}).putImageData(new ImageData(pixels,job.width,job.height),0,0);
  const bitmap=output.transferToImageBitmap();
  self.postMessage({type:'preview',id:job.id,backend:'wasm',width:job.width,height:job.height,
    iterations:view.iterations,milliseconds:performance.now()-started,bitmap},[bitmap]);
}

self.onmessage=async ({data})=>{
  if(data.type==='cancel'){if(activeCPU?.id===data.id)activeCPU.cancelled=true;return;}
  if(data.type==='init' || data.type==='gpu-init') {
    if(data.type==='init'){module=data.module;engineOptions=data.engineOptions;}
    let gpu=false,reason;
    if(data.gpu || data.type==='gpu-init')try{gpu=await initializeGPU();}catch(error){reason=String(error.message);device?.destroy();device=null;pipeline=null;}
    self.postMessage({type:'ready',gpu,reason});return;
  }
  if(data.type!=='render')return;
  try {
    if(data.backend==='webgpu')await renderGPU(data);
    else {const token={id:data.id,cancelled:false};activeCPU=token;
      await renderWASM(data,token);if(activeCPU===token)activeCPU=null;
      self.postMessage({type:'done',id:data.id}); }
  } catch {
    self.postMessage({type:data.backend==='webgpu'?'unavailable':'done',id:data.id});
  }
};
