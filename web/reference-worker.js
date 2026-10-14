import {writeCentre} from './view.js';
let engine,token=0;
const channel=new MessageChannel(),yieldQueue=[];
channel.port1.onmessage=()=>yieldQueue.shift()?.();
const yieldTask=()=>new Promise(resolve=>{yieldQueue.push(resolve);channel.port2.postMessage(null);});
self.onmessage=async({data})=>{
  if(data.type==='init'){engine=new WebAssembly.Instance(data.module,{}).exports;return;}
  const id=++token;
  try{
    let view=data.view,previous,attempt=0,started=performance.now();
    for(;;){
      const bits=Math.max(view.bits,Math.ceil((-2*view.exponent+192)/32)*32)+32*attempt;
      if(!engine.deep_allocate(bits,view.iterations))throw new Error('Deep zoom memory exhausted');
      writeCentre(engine,view);
      engine.deep_begin(BigInt(view.real)<0n?-1:1,BigInt(view.imag)<0n?-1:1,view.mantissa,view.exponent,data.width,data.height);
      let done=false;
      while(!done){done=engine.deep_reference(128);await yieldTask();if(id!==token)return;}
      if(engine.deep_needs_precision()){previous=null;++attempt;continue;}
      const bytes=new Uint8Array(engine.memory.buffer,engine.deep_data_address(),engine.deep_data_size()).slice();
      // Repeat at higher precision. Compare ALL stored reference samples, not
      // just the image centre. Retry until rounding to the worker representation
      // is stable to 40 significant bits, including tiny nonzero iterates.
      if(previous){
        const a=new DataView(previous.buffer),b=new DataView(bytes.buffer),count=b.getUint32(0,true);
        let stable=count===a.getUint32(0,true);
        const header=232;
        for(let j=0;stable&&j<=count;++j){
          const offset=header+j*24,ar=a.getFloat64(offset,true),ai=a.getFloat64(offset+8,true),br=b.getFloat64(offset,true),bi=b.getFloat64(offset+8,true);
          const ae=a.getInt32(offset+16,true),be=b.getInt32(offset+16,true);
          const magnitude=Math.max(Math.abs(br),Math.abs(bi));
          stable=ae===be&&Math.max(Math.abs(ar-br),Math.abs(ai-bi))<=magnitude*2**-40;
        }
        if(stable){
          engine.deep_finish();
          const buffer=new Uint8Array(engine.memory.buffer,engine.deep_data_address(),engine.deep_data_size()).slice().buffer;
          self.postMessage({type:'reference',generation:data.generation,bits,buffer,milliseconds:performance.now()-started},[buffer]);return;
        }
      }
      previous=bytes;++attempt;
    }
  }catch(error){self.postMessage({type:'error',generation:data.generation,message:error.message});}
};
