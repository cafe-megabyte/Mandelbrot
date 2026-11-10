# Development notes

Updated 10 November 2026. Keep this file brief; generated reports belong in
`build/internal/`, not in `docs/`.

## Current state

- Production option mask: **28427** (3851 plus `DEEP_DOUBLE_PERTURB` 8192 and
  `DEEP_DD_PERTURB` 16384). The old f64/ReferenceContext experiment stays removed;
  the new double path is a separate, non-inlined function (see below).
- Adaptive navigation preview: WebGPU/WGSL when f32 coordinates suffice;
  bounded WASM fallback while navigating. CPU cancellation is cooperative, with
  a hard timeout; the original compiled module is shared. Final rendering has priority.
- Accurate tiles appear in batches (125–500 ms). A buffered display replaces
  the initial SVG-clip experiment, which caused repeatable browser regressions.
  Owned dirty tile bytes use a bounded 8 MiB pool; display canvases and the pool
  are released on completion. Accurate staging uses CPU-backed canvases;
  overflow reads only dirty regions. Cold local-reference frames begin with small final
  tiles to avoid long initial calls before WASM tier-up. Prepared global references
  keep normal batches: tiny startup tiles caused a small throughput regression.
  Views wholly within
  conservative interior disks keep normal tiles and defer display copies;
  every final pixel is still computed by the original WASM core. A stationary
  shallow selection starts once its exact observed raster is available,
  without another display-cycle delay; active gestures keep their hold.
- Zooming retains the latest visible partial tiles at their original resolution,
  above coarse previews, including when a preview times out or is black. Frozen
  staging stores and queued bytes are released; older backgrounds are compacted
  so only one accurate fallback remains. Browser regression: `partial-zoom.html`.
- Safari trackpad gestures cancel overlapping wheel events and settle after
  150 ms idle even without `gestureend`. A continued gesture retains its cumulative
  scale and observes its starting element even after preview replacement;
  completion outside the image or on window blur releases the final render.
  Regression checks: `navigation-check.js` and browser `zoom.html`.
- Numerical core: November 2026 optimization round, see
  `docs/optimization-findings.md` (status per item). An earlier exact-centre
  experiment stays reverted: it exposed broader coordinate/colour issues.
- Navigation end snaps the centre by at most 1/4 pixel onto the real axis'
  half-pixel grid when the axis is visible (`alignAxis`), so conjugate rows can
  be mirrored. URL/API selections are never snapped.
- Progress pill: actual completed physical pixels, including mirrored rows;
  500 ms delay; tabular figures and stable widths; centred bullet;
  English default (commas), German primary browser language (dots).

## Numerical rules and known limitations

- Escape: first iteration with `|z|² > 4`; equality is bounded. `c=2` escapes on iteration 2.
- Exactly real grid points in (-2, 1/4) are black without a reference (odd
  heights through a real centre, or axis rows after `alignAxis`). Exactly real
  references in [-2, 1/4] stop once |dZ/dc|*spacing > 2^64: their chaotic real
  orbit otherwise needs ~1 bit per iteration (the "frontman" at odd heights
  hung at 99%; global axis views never finished their reference). Both issues
  predate the November optimizations; regressions in `deep-check.c`.
- Finite iteration budget does not prove membership. Preserve the full raster
  and budget; uncertainty requires higher precision, not silent black pixels.
- Baseline limitations still present: escape on the final iteration may be
  coloured incorrectly; some fallback coordinates are rounded.
- Byte equality with the baseline alone does not prove correctness.
  Use the independent interval oracle in `tests/numerical-oracle.js`;
  target matching escape status/iteration and at most one RGB level per channel.
- Exact cusp32 centre: bounded through 34365 iterations, first escape at 34366.
  A small derivative is not an interior proof.
- No unverified fast-math, relaxed SIMD, FMA or loosened BLA tolerances.

## November 2026 deep-zoom pipeline (10 Nov)

- Per pixel: perturbation (doubles down to 2^-480, else Extended), then
  interleaved DD (106 bits, only from 2^-52 up), then DD perturbation with a
  per-pixel exponent, then the fixed-point orbit. Uncertain pixels of a tile are
  deferred and resolved per stage; the fixed pass is resumable after growth.
- Perturbation bound amplifies by 2|z| (not 2(|Z|+|delta|)), with explicit
  reference-sample, rebase and margin terms; proof at `perturb_pixel`.
  Double path rounds at 2^-50 (proof at `perturb_rounding`), Extended at 2^-48.
- Double perturbation and DD run 4 lanes in 2 f64x2 pairs; lanes are
  bit-identical to the scalar code. High event rates (orbits along |z|=2 near
  c=-2) switch a tile back to the scalar loop.
- `ext()` must stay always_inline: out of line it returns through memory and
  costs 10-20% in every Extended operation.
- Start precision `-e+160` bits (was `-2e+192`); certified bounds request more.
- Limb products: column-wise accumulation, short products from column
  `fraction-2` with an exact full-product retry, rounding flag via ctz.
- Payload tail: DD copy of the reference orbit (32 bytes per sample) and an
  outward bound on reference_error/|Z|. Local references build it only when a
  tile needs DD perturbation (repeated identical pass).
- Local-reference setup is dominated by the DD series prefix; it starts at
  512 tile pixels (`PRECISE_SERIES_MIN_PIXELS`), smaller tiles use the tight
  double series. Prefix products/sums run in f64x2 lanes, bit-identical.

## November 2026 byte-identical speedups (8 Nov)

- Shallow SIMD: eight pixels stream through four interleaved `f64x2` orbits
  (was two) with one `any_true` exit test; an escaped, limit or cycled lane is
  refilled with the next pixel. Cycle checks at 64-step boundaries. Each pixel
  first runs 4 identical scalar iterations (measured best of 1/4/8/16/32/64).
- Limbs: Karatsuba also for odd limb counts (products from 32 limbs) and for
  squares (from 48 limbs). Workspace is proved <=2n limbs up to 2^20 limbs.
- The precise-series replay stops once its DD prefix ends; the orbit is unchanged.
- Render workers: at most 16 (was 8), still one logical core fewer than reported.
- Rejected, bit-identical but slower: `DEEP_DD_CACHE` (+2 to +10% in every DD
  case despite fewer products; the interleaved DD kernel now always uses cached
  squares); Karatsuba squares at 32-47 limbs (+11% at 33).
- Rejected: divisionless colour formula (P4): at most 3% even as an upper bound.
- No Node? `build/internal/host-tools/js-runner` has no optimizing WASM tier
  (about 14x slower); measure in a browser instead.

## Performance lessons

- Confirmed regression in **any** reference case: stop and discuss with the user.
  Repeat noisy measurements in alternating A/B order; other gains do not compensate.
- Failed experiment, three full 4K A/B pairs; identical images, zero f64 iterations:

| Case | Pair 1 | Pair 2 | Pair 3 |
| --- | ---: | ---: | ---: |
| Boundary80 | +8.89% | +8.54% | +15.64% |
| Boundary100 | +9.18% | +8.50% | +15.59% |
| Boundary400 | +6.29% | +26.21% | +8.15% |

- Experiment overhead affected paths outside f64; exact cause was not isolated.
- Hard regions are dominated by pixel fallbacks, not global reference preparation.
  Tiny adaptive tiles can repeat expensive local references.
- Existing series, bounded BLA, SIMD products and reference reuse already help.
  Possible future work: shorter certified BLA blocks, valid DD seeds, reference
  scheduling. The old migration plan is cancelled; none of these is newly enabled.
- Do not copy Fraktaler code into this project without a license review.
- Full comparisons freeze WASM, workers, view conversion and scheduler together;
  kernel-only measurements are not browser latency. Budget: at most 16 MiB extra per worker.
- Progressive display temporarily adds up to four bytes per frame pixel
  (about 32 MiB at 4K, 127 MiB at 8K) plus the bounded tile pool, outside worker memory. Fast frames may
  finish before any display buffers are allocated. A canceled partial frame may
  retain one additional display raster during navigation, without its staging
  stores or tile pool. Benchmark GPU/compositor
  work with the target raster fully inside the browser viewport.

## Documentation policy

- README: use, build, deployment; keep short.
- `docs/`: brief text notes, compact references and the README preview.
- No source snapshots, WASM, extra screenshots, raw pixels, duplicate JSON or full logs.
- Historical raw artifacts and the superseded implementation plan were removed
  during this cleanup; reference coordinates and test tools remain under `tests/`.
