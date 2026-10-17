import {fixedDecimal} from './view.js';

export const XMP_NAMESPACE = 'https://github.com/cafe-megabyte/Mandelbrot/ns/1.0/';
const XMP_FIELDS = {
  schema_version: 'SchemaVersion', fractal: 'Fractal', center_x: 'CenterX', center_y: 'CenterY',
  zoom_exponent: 'ZoomExponent', zoom_base: 'ZoomBase', width: 'Width', height: 'Height',
  imaginary_axis: 'ImaginaryAxis', pixel_mapping: 'PixelMapping', precision_bits: 'PrecisionBits',
  iterations: 'Iterations', pixel_step_mantissa: 'PixelStepMantissa', pixel_step_exponent: 'PixelStepExponent',
  color_space: 'ColorSpace', icc_profile: 'ICCProfile'
};

// Capture the final rendering view once. All format-specific copies come from
// this record; absolute coordinates never pass through a JavaScript Number.
export function createPngMetadata({view, width, height}) {
  return {
    schema_version: 1, fractal: 'Mandelbrot',
    center_x: fixedDecimal(view.real, view.bits), center_y: fixedDecimal(view.imag, view.bits),
    zoom_exponent: String(view.zoom), zoom_base: 2, width, height,
    imaginary_axis: 'up', pixel_mapping: 'mandelbrot-view-v1',
    precision_bits: view.bits, iterations: view.iterations,
    pixel_step_mantissa: String(view.mantissa), pixel_step_exponent: view.exponent,
    color_space: 'sRGB', icc_profile: 'sRGB IEC61966-2.1'
  };
}

function ascii(text) {
  if (/[^\x00-\x7f]/.test(text)) throw new Error('Non-ASCII PNG metadata');
  return Uint8Array.from(text, character => character.charCodeAt(0));
}
function textChunk(keyword, value) {
  return {type: 'tEXt', data: ascii(`${keyword}\0${value}`)};
}
function internationalText(keyword, value) {
  // Uncompressed UTF-8, empty language and translated keyword.
  return {type: 'iTXt', data: new TextEncoder().encode(`${keyword}\0\0\0\0\0${value}`)};
}
function xml(value) {
  return String(value).replace(/[&<>"']/g, character =>
    ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;'}[character]));
}
export function createXmp(metadata) {
  const properties = Object.entries(XMP_FIELDS).map(([field, name]) =>
    `<mb:${name}>${xml(metadata[field])}</mb:${name}>`).join('');
  return '<?xpacket begin="\uFEFF" id="W5M0MpCehiHzreSzNTczkc9d"?>' +
    '<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">' +
    `<rdf:Description rdf:about="" xmlns:mb="${XMP_NAMESPACE}">${properties}</rdf:Description>` +
    '</rdf:RDF></x:xmpmeta><?xpacket end="w"?>';
}

export function createExif(metadata, json = JSON.stringify(metadata)) {
  // TIFF offsets are relative to the II header, without a JPEG APP1 prefix.
  const long = value => { const data = new Uint8Array(4); new DataView(data.buffer).setUint32(0, value, true); return data; };
  const string = value => ascii(`${value}\0`);
  const asciiJson = json.replace(/[\u007f-\uffff]/g, character => `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`);
  const ifd0 = [
    {tag: 0x8769, type: 4, count: 1, data: null},
    {tag: 0xff58, type: 2, data: string(metadata.center_x)},
    {tag: 0xff59, type: 2, data: string(metadata.center_y)},
    {tag: 0xff5a, type: 2, data: string(metadata.zoom_exponent)}
  ];
  const exif = [
    {tag: 0x9000, type: 7, data: ascii('0232')},
    {tag: 0x9101, type: 7, data: new Uint8Array([4, 5, 6, 0])},
    {tag: 0x9286, type: 7, data: ascii(`ASCII\0\0\0${asciiJson}`)},
    {tag: 0xa000, type: 7, data: ascii('0100')},
    {tag: 0xa001, type: 3, count: 1, data: new Uint8Array([1, 0])},
    {tag: 0xa002, type: 4, count: 1, data: long(metadata.width)},
    {tag: 0xa003, type: 4, count: 1, data: long(metadata.height)}
  ];
  const ifdSize = entries => 2 + entries.length * 12 + 4;
  const exifOffset = 8 + ifdSize(ifd0);
  ifd0[0].data = long(exifOffset);
  let offset = exifOffset + ifdSize(exif);
  for (const entry of [...ifd0, ...exif]) if (entry.data.length > 4) {
    // TIFF values start on word boundaries, even after odd-sized strings.
    offset += offset & 1; entry.offset = offset; offset += entry.data.length;
  }
  const bytes = new Uint8Array(offset), view = new DataView(bytes.buffer);
  bytes.set([0x49, 0x49, 42, 0]); view.setUint32(4, 8, true);
  function writeIfd(entries, start) {
    view.setUint16(start, entries.length, true);
    entries.forEach((entry, index) => {
      const position = start + 2 + index * 12;
      view.setUint16(position, entry.tag, true); view.setUint16(position + 2, entry.type, true);
      view.setUint32(position + 4, entry.count ?? entry.data.length, true);
      if (entry.offset !== undefined) {
        view.setUint32(position + 8, entry.offset, true); bytes.set(entry.data, entry.offset);
      } else bytes.set(entry.data, position + 8);
    });
    // The zero-filled next-IFD pointer terminates each directory.
  }
  writeIfd(ifd0, 8); writeIfd(exif, exifOffset);
  return bytes;
}

export function createMetadataChunks(metadata) {
  const json = JSON.stringify(metadata);
  return [
    textChunk('Mandelbrot.CenterX', metadata.center_x),
    textChunk('Mandelbrot.CenterY', metadata.center_y),
    textChunk('Mandelbrot.ZoomExponent', metadata.zoom_exponent),
    internationalText('Mandelbrot.Metadata', json),
    internationalText('XML:com.adobe.xmp', createXmp(metadata)),
    {type: 'eXIf', data: createExif(metadata, json)}
  ];
}
