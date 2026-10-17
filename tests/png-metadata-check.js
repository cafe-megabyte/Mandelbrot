const {createPngMetadata,createExif,createXmp}=new Function(
  readText('web/view.js').replace(/^export /gm,'')+'\n'+
  readText('web/png-metadata.js').replace(/^import .*\n/gm,'').replace(/^export /gm,'')+
  '\nreturn {createPngMetadata,createExif,createXmp};')();
const assert=(ok,message)=>{if(!ok)throw new Error(message);};
const text=bytes=>Array.from(bytes,byte=>String.fromCharCode(byte)).join('');
function checkExif(metadata){
  const bytes=createExif(metadata),view=new DataView(bytes.buffer),sizes={2:1,3:2,4:4,7:1};
  assert(text(bytes.subarray(0,4))==='II*\0'&&view.getUint32(4,true)===8,'Bare little-endian TIFF');
  function ifd(offset){
    const count=view.getUint16(offset,true),entries=new Map();let previous=-1;
    assert(offset%2===0&&offset+6+count*12<=bytes.length,'IFD bounds/alignment');
    assert(view.getUint32(offset+2+count*12,true)===0,'Next IFD pointer');
    for(let i=0;i<count;++i){
      const p=offset+2+i*12,tag=view.getUint16(p,true),type=view.getUint16(p+2,true),count=view.getUint32(p+4,true);
      const size=count*sizes[type],start=size<=4?p+8:view.getUint32(p+8,true);
      assert(tag>previous&&size>0&&start+size<=bytes.length,'TIFF tag order/type/count/bounds');previous=tag;
      assert(size<=4||start%2===0,'TIFF value alignment');
      entries.set(tag,{type,count,data:bytes.subarray(start,start+size)});
    }
    return entries;
  }
  const root=ifd(8);assert(root.size===4,'IFD0 entry count');
  for(const [tag,key]of [[0xff58,'center_x'],[0xff59,'center_y'],[0xff5a,'zoom_exponent']]){
    const entry=root.get(tag);assert(entry.type===2&&text(entry.data)===metadata[key]+'\0',`Private EXIF ${key}`);
  }
  const pointer=root.get(0x8769);assert(pointer.type===4&&pointer.count===1,'ExifIFD pointer');
  const exif=ifd(new DataView(pointer.data.buffer,pointer.data.byteOffset,4).getUint32(0,true));
  const comment=exif.get(0x9286);assert(comment.type===7&&text(comment.data.subarray(0,8))==='ASCII\0\0\0','UserComment prefix');
  assert(comment.data.every(byte=>byte<128),'Non-ASCII UserComment');
  assert(JSON.stringify(JSON.parse(text(comment.data.subarray(8))))===JSON.stringify(metadata),'UserComment values');
}
const frame={width:2048,height:1377,view:{real:'-24',imag:'1',bits:5,zoom:5,mantissa:1.5,exponent:-15,iterations:512}};
const simple=createPngMetadata(frame);
assert(simple.icc_profile==='sRGB IEC61966-2.1'&&simple.color_space==='sRGB','Assigned ICC profile name');
assert(simple.center_x==='-0.75'&&simple.center_y==='0.03125'&&simple.zoom_exponent==='5','Exact simple snapshot');
assert(2**Number(simple.zoom_exponent)===32,'Zoom must be an exponent');checkExif(simple);
const unit='0.0000000000000000000000000000000000000000000000006842277657836020854119773355907793609766904013068924666782559979930620520927053718196475529111921787261962890625';
for(const zoom of [5.125,40.123456789012344,1600.25,4000,1e21]){
  const metadata=createPngMetadata({...frame,view:{...frame.view,real:'-1',imag:'1',bits:160,zoom,exponent:-4000}});
  assert(metadata.center_x==='-'+unit&&metadata.center_y===unit,'160-bit coordinates rounded');
  assert(metadata.zoom_exponent===String(zoom),'Zoom Number precision lost');
  assert(metadata.pixel_step_exponent===-4000&&metadata.pixel_step_mantissa==='1.5','Scale snapshot changed');
  checkExif(metadata);
}
// Exercise inline TIFF strings, odd lengths, zero, both signs and long offsets.
for(const [real,imag,bits]of [['0','0',0],['1','-1',0],['123','-12345',0],['1','-1',4096]])
  checkExif(createPngMetadata({...frame,view:{...frame.view,real,imag,bits}}));
const escaped={...simple,fractal:'Mandelbrot & <test> "quoted" \'single\' ä 😀'};
checkExif(escaped);
const xmp=createXmp(escaped);
assert(xmp.includes('Mandelbrot &amp; &lt;test&gt; &quot;quoted&quot; &apos;single&apos; ä 😀'),'XMP XML escaping');
assert(xmp.includes('<mb:CenterX>-0.75</mb:CenterX>')&&!xmp.includes('rdf:datatype'),'XMP coordinate text');
report('PNG metadata: exact fixed-point decimals, fractional/overflowing zoom, inline/long TIFF values, aligned offsets, ASCII JSON and XML escaping passed.');
var testDone=true;
