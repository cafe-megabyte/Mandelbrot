# Development notes

Updated 18 October 2026. Keep this file brief; generated reports belong in
`build/internal/`, not in `docs/`.

## Current state

- f64/ReferenceContext experiment fully removed after confirmed regressions;
  no fixture exceptions. Production option mask: **3851**.
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
- The numerical core remains the original baseline. An exact-centre experiment
  was reverted: it exposed broader existing coordinate/colour issues.
  Numerical repairs require separate scope.
- Progress pill: actual completed physical pixels, including mirrored rows;
  500 ms delay; tabular figures and stable widths; centred bullet;
  English default (commas), German primary browser language (dots).

## Numerical rules and known limitations

- Escape: first iteration with `|z|² > 4`; equality is bounded. `c=2` escapes on iteration 2.
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
