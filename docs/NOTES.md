# Development notes

Updated 16 October 2026. Keep this file brief; generated reports belong in
`build/internal/`, not in `docs/`.

## Current state

- f64/ReferenceContext experiment fully removed after confirmed regressions;
  no fixture exceptions. Production option mask: **3851**.
- Original core, render worker and build/check entry points restored.
  SIMD WASM byte-identical to the original baseline; see [4K references](baseline-4k.md).
- Rollback: `make check` passed; Boundary80/100/400 image hashes matched.
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

## Documentation policy

- README: use, build, deployment; keep short.
- `docs/`: brief text notes, compact references and the README preview.
- No source snapshots, WASM, extra screenshots, raw pixels, duplicate JSON or full logs.
- Historical raw artifacts and the superseded implementation plan were removed
  during this cleanup; reference coordinates and test tools remain under `tests/`.
