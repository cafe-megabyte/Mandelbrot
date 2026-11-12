// Coordinate entry: separators, pasted URLs/metadata and URL-parser limits.
const {parseDecimal, extractView, viewInput, viewFromFragment} = new Function(
  readText('web/view.js').replace(/^export /gm, '') + '\n' +
  readText('web/menu.js').replace(/^export /gm, '') +
  '\nreturn {parseDecimal, extractView, viewInput, viewFromFragment};')();
const assert = (ok, message) => { if (!ok) throw new Error(message); };
let checks = 0;
const same = (actual, expected, label) => {
  assert(JSON.stringify(actual) === JSON.stringify(expected), `${label}: ${JSON.stringify(actual)} != ${JSON.stringify(expected)}`);
  ++checks;
};
for (const [input, expected] of [
  ['-0,75', '-0.75'], ['-0.75', '-0.75'], [' −0,743 643 887 ', '-0.743643887'], ['+.5', '0.5'], ['3,', '3'],
  ['1e-5', '0.00001'], ['-1.5E3', '-1500'], ['0', '0'], ['-0', '0'], ['007.50', '7.5'], ['24', '24'],
  ['-0.7436438870371587047522227691112940', '-0.7436438870371587047522227691112940'.replace(/0+$/, '')],
  ['1.234,5', null], ['', null], ['-', null], ['abc', null], ['1e99999', null], ['0x10', null], ['1/2', null]
]) same(parseDecimal(input), expected, `parseDecimal(${JSON.stringify(input)})`);

const json = '{"schema_version":1,"fractal":"Mandelbrot","center_x":"-0.743643887037151","center_y":"0.13182590420533",' +
  '"zoom_exponent":"40.125","zoom_base":2,"width":3840,"height":2160,"iterations":4096}';
for (const [input, expected] of [
  ['https://example.test/mandelbrot/#x=-0.75&y=0.1&zoom=7', {x: '-0.75', y: '0.1', zoom: '7'}],
  ['#x=-1.25&y=0&zoom=3.5', {x: '-1.25', y: '0', zoom: '3.5'}],
  ['https://example.test/?x=1&y=%2D0.5&zoom=2', {x: '1', y: '-0.5', zoom: '2'}],
  [json, {x: '-0.743643887037151', y: '0.13182590420533', zoom: '40.125'}],
  // Pretty-printed, truncated, escaped and German-formatted text is enough.
  ['{\n  "center_x": "-0,5",\n  "center_y": "0,25",\n  "zoom_exponent": "12"', {x: '-0,5', y: '0,25', zoom: '12'}],
  ['{\\"center_x\\":\\"-0.5\\",\\"center_y\\":\\"0.25\\",\\"zoom_exponent\\":\\"9\\"}', {x: '-0.5', y: '0.25', zoom: '9'}],
  ['Mandelbrot.CenterX: -1.1\nMandelbrot.CenterY: 0.2\nMandelbrot.ZoomExponent: 5', {x: '-1.1', y: '0.2', zoom: '5'}],
  ['<mb:CenterX>-1.1</mb:CenterX><mb:CenterY>0.2</mb:CenterY><mb:ZoomExponent>5</mb:ZoomExponent>', {x: '-1.1', y: '0.2', zoom: '5'}],
  ['"zoom_base": 2, "zoom_exponent": "8"', {zoom: '8'}],
  ['max=3 index=4 zoomed=5', {}],
  ['nothing here', {}],
  ['100% broken %E0 x=1', {x: '1'}]
]) same(extractView(input), expected, `extractView(${JSON.stringify(input.slice(0, 40))})`);

same(viewInput({x: '-0,75', y: '0,1', zoom: '7'}, viewFromFragment).target,
  viewFromFragment('#x=-0.75&y=0.1&zoom=7'), 'typed view equals the linked view');
const deepX = '-1.' + '7'.repeat(2000);
const deep = viewInput({x: deepX, y: '0', zoom: '1600'}, viewFromFragment).target;
same([deep.real, deep.zoom, deep.bits >= 2000], [deepX, 1600, true], 'deep coordinates keep every digit');
same(viewInput({x: 'a', y: '', zoom: '-1'}, viewFromFragment).errors, {x: 'number', y: 'number', zoom: 'zoomRange'}, 'field errors');
same(viewInput({x: '0', y: '0', zoom: '1e9'}, viewFromFragment).errors, {zoom: 'zoomLarge'}, 'zoom bound');
same(viewInput({x: '0', y: '0', zoom: '-0'}, viewFromFragment).target.zoom, 0, 'negative zero zoom');
report(`${checks} menu checks passed.`);
var testDone = true;
