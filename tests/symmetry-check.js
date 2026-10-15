const {renderBands, decimalFixed, writeCentre} = new Function(
  readText('web/view.js').replace(/^export /gm, '') +
  '\nreturn {renderBands, decimalFixed, writeCentre};')();
const assert = (ok, message) => { if (!ok) throw new Error(message); };
function view(imag = 0, exponent = -6, mantissa = 1) {
  const bits = Math.max(192, -2 * exponent + 192);
  return {bits, real: decimalFixed('-2', bits).toString(), imag: decimalFixed(String(imag), bits).toString(),
    centreReal: -2, centreImag: imag, exponent, mantissa, iterations: 512, deep: exponent < -26};
}
function coverage(height, target) {
  const plan = renderBands(height, target), rows = new Uint8Array(height);
  for (const band of plan.bands) {
    assert(band.height > 0 && band.height <= 64, 'Invalid band height');
    for (let j = 0; j < band.height; ++j) {
      ++rows[band.y + j];
      if (band.mirrorY !== null) ++rows[band.mirrorY + j];
    }
  }
  assert(rows.every(count => count === 1), 'A row was skipped or written twice');
  assert(plan.computedRows + plan.mirroredRows === height, 'Incorrect progress denominator');
  return plan;
}
for (const height of [1, 2, 17, 64, 65, 129, 1023, 1024, 1025, 2051, 4320]) {
  assert(coverage(height, view()).computedRows === Math.ceil(height / 2), 'Centred view did not halve the work');
  for (const offset of [-height, -height + 1, -7, -1, 0, 1, 8, height - 1, height]) {
    const plan = coverage(height, view(offset / 128));
    const expected = Math.floor(Math.max(0, height - Math.abs(offset)) / 2);
    assert(plan.mirroredRows === expected, 'Shifted overlap was not mirrored correctly');
  }
  assert(coverage(height, view(0.3 / 128)).mirroredRows === 0, 'A nonaligned pixel grid was snapped');
  assert(coverage(height, view((2 + 2 ** -48) / 128)).mirroredRows === 0, 'Near alignment was rounded into symmetry');
}
// The true deep centre must be used, even when Number underflows to zero.
const tiny = view(0, -1600);
tiny.imag = decimalFixed('1e-450', tiny.bits).toString();
assert(coverage(17, tiny).mirroredRows === 0, 'Deep centre was rounded to zero');
const deepShift = view(0, -400);
deepShift.imag = (3n << BigInt(deepShift.bits - 401)).toString();
assert(coverage(17, deepShift).mirroredRows === 7, 'Deep shifted pixel grid lost exact alignment');
for (const mantissa of [1 - 2 ** -53, 1.7, 2])
  assert(coverage(129, view(0, -6, mantissa)).computedRows === 65, 'Scale normalization rounding broke symmetry');

for (const variant of ['scalar', 'simd']) {
  const e = new WebAssembly.Instance(new WebAssembly.Module(
    new Uint8Array(readBytes(`build/internal/wasm/engine-${variant}.wasm`))), {}).exports;
  function configure(w, h, target) {
    if (!target.deep) {
      assert(e.configure_view(w, h, target.centreReal, target.centreImag,
        target.mantissa * 2 ** target.exponent, target.iterations), 'Shallow configuration failed');
    } else {
      assert(e.deep_allocate(target.bits, target.iterations), 'Deep allocation failed');
      writeCentre(e, target);
      e.deep_begin(-1, BigInt(target.imag) < 0n ? -1 : 1, target.mantissa, target.exponent, w, h);
      while (!e.deep_reference(128)) {}
      assert(!e.deep_needs_precision(), 'Reference needs more precision');
      e.deep_finish();
      e.deep_configure(w, h, target.mantissa, target.exponent, target.iterations,
        -1, BigInt(target.imag) < 0n ? -1 : 1);
    }
  }
  for (const [w, h, target] of [
    [1, 1, view()], [257, 65, view()], [513, 129, view()], [17, 2051, view()],
    [257, 65, view(7 / 128)], [257, 65, view(-8 / 128)],
    [257, 65, view(0.3 / 128)], [257, 65, view(2)],
    [33, 17, view(0, -32)], [33, 17, view(0, -400)], [33, 17, deepShift]
  ]) {
    function render(bands) {
      configure(w, h, target);
      const image = new Uint8Array(w * h * 4);
      for (const band of bands) for (let x = 0; x < w; x += 256) {
        const width = Math.min(256, w - x), length = target.deep ?
          e.deep_render_tile(x, band.y, width, band.height) : e.render_tile(x, band.y, width, band.height);
        assert(length === width * band.height * 4, 'Tile failed');
        const pixels = new Uint8Array(e.memory.buffer, e.output_address(), length);
        for (let row = 0; row < band.height; ++row) {
          const source = pixels.subarray(row * width * 4, (row + 1) * width * 4);
          image.set(source, ((band.y + row) * w + x) * 4);
          if (band.mirrorY !== null)
            image.set(source, ((band.mirrorY + band.height - 1 - row) * w + x) * 4);
        }
      }
      return image;
    }
    const full = [];
    for (let y = 0; y < h; y += 64) full.push({y, height: Math.min(64, h - y), mirrorY: null});
    const expected = render(full), actual = render(coverage(h, target).bands);
    assert(actual.every((v, j) => Math.abs(v - expected[j]) <= (target.deep ? 1 : 0)),
      `${variant}: symmetry changed pixels at ${w}x${h}, exponent ${target.exponent}`);
  }
  report(`${variant}: mirrored shallow images match full computation byte for byte; deep images agree within the existing one-channel-step tolerance.`);
}
report('Symmetry covers every row once: even/odd heights, shifted overlap, off-axis/nonaligned views, surface boundaries and deep coordinates.');
var testDone = true;
