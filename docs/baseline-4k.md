# Historical 4K references

15 October 2026; 3840 × 2160 physical pixels; eight production Node/V8 workers;
Apple M5 Pro (Virtual), Node 26.9.0 / V8 14.6.202.34; option mask **3851**.
One complete frame per case, not medians. Production iteration budgets.
Includes configuration, global reference preparation, scheduling, computation
and RGBA copies/transfers; excludes compilation, worker startup, preview, Canvas
and PNG. Twenty small shallow warm-up tiles per worker, then a fresh target frame.

Exact centres, zooms and binary rasters: [regions.json](../tests/fixtures/regions.json).
SHA-256 values below cover the complete RGBA image. Historic hashes describe
this scheduler/run; different tile layouts can change deep rounding and need
an independent numerical check. No raw images or frozen product snapshots retained.

SIMD WASM: `36bda81a2b9332dbe881db8086bc4c37c0c523adc0f5309cb165ab6f59777748`  
Scalar WASM: `892aa579677283f3ed564dc531b9fc5f9f25d6d9ac70dcce5162c876c5978a53`

| Fixture | Seconds | Iterations | RGBA SHA-256 |
| --- | ---: | ---: | --- |
| desktop-zoom15 | 0.093114 | 4608 | `863cee31bba839a3626ee403749ba83029ea05b0636066f6aac9e508adf78520` |
| desktop-zoom12-6 | 0.082574 | 4096 | `dbcccbe7396793a8d48483259dc418ef52338ac8fc47e7fb826fa0385aa43ce1` |
| desktop-zoom9 | 0.122930 | 3072 | `67fc4c5ef617ccd457c52e6dbc9f351e72626587ce05e4cb953b5346d0d42712` |
| desktop-zoom20 | 1.214463 | 5888 | `b4810f7e7a609dc154157066acfff5cae2ea891c3057cff7c5cf535d295bfe59` |
| boundary-80 | 0.545615 | 21248 | `a8d1488ac7883fb70ad9123c789b9085bbf80819165d0dc923a6869e508a215a` |
| boundary-100 | 0.576420 | 26368 | `e53c4c5b984d82f36aafa01d8c32dd49476f3824f0a37cb1bc1762563d1a37c2` |
| boundary-400 | 2.878338 | 103168 | `ef22213ced1fff13e273faec766e11a054f23c3505ec316e2d934b766a7063c4` |
| cusp24 | 27.538574 | 6912 | `7c2ef0a37ccea99728ecfed8a57c6156bc0e422f1ae6ff9909dcd706ef1e8508` |
| elefant | 112.631796 | 7680 | `243fa653b414631152b50fb82ef9ed9e16eb0cc84b1d4469f51952c4d8c1b4e0` |
| links-ring | 148.230825 | 8960 | `8c8fdbf732dc6c21c6bc2d815fbc8759c2365ca88ceb9627d6d6e3ea1ff7d9bb` |
| stern-explosion | 15.442294 | 14592 | `4925196825dfb990b8d45571a890bee8c6b8862b72ce7dda2e3163ab4cc898ef` |
| drei-kern-samen | 3.170475 | 7168 | `984622cb17490b09c029e86a435a3fab53984458c4ad32ad0f6e9570e1903cbd` |
| cusp38 | 75.220021 | 10496 | `c2c3b2b7318b2e34f5d9af9e95a6da940d2c7b7fdfe7131bead9f0205f168afd` |
| branch29 | 66.443972 | 8192 | `3a50a2f7285ae28cb99d378983499af41f1d9dc320590dc46441206f9088a495` |
| cusp32 | 149.201383 | 9216 | `1e125a2fb0786f86a623a5cd3d316c1974d53dbab6cf7710015b3102e5eb57ed` |
| cusp-18 | 0.150138 | 5376 | `be1449309ed5a752e592a2a4f7c833def24fed86db067e1ed99e6f3a46b2e01e` |
| interior-40 | 0.006386 | 11008 | `875500e4445f5bd9ff4efe7d2d4b74b116cb61964f6b7304fafe72471c925f58` |
| seahorse-24 | 76.821315 | 6912 | `8a9c6371446f4110c49c886fc84b717463cf3ade2758b61503616654bd9a5d52` |
| preperiodic-40 | 0.340788 | 11008 | `947b0c5b55ad128fef78bea0d70038ab06d873dba4c1541dc569eb5824818f2b` |
| preperiodic-400 | 13.443606 | 103168 | `6b462ee73c0684b7152a970a01c6cc7171716f20fde09ac7536a94925908281d` |
| preperiodic-1600 | 853.711132 | 410368 | `72cc29f4a83781f573223826a7effd2c5f282911f214b8d162bc496dc3b817bf` |
| overview | 0.021657 | 768 | `a40f917ba4b1233e3d37a7571e0253479bfe9457f0feea25aae9487b2f95cea2` |
| seahorse-10 | 0.080484 | 3328 | `dd84fb741480daf0494615c02a5286ae102708a381ca1f93c144bb9934354367` |
| seahorse-18 | 10.446070 | 5376 | `08d309451ff9ec66f86d5322be40ebc5f7ab3bc9996d11842c52dfba40d12853` |
| navigation-7 | 0.198958 | 2560 | `70a82bae71834f31907faee818405ae7d8bb04ce6df3e53c5b21647a7c04df5b` |

The interrupted zoom-1600 attempt is excluded; 853.711132 s is its complete rerun.
Repeat timings with `make web`, then, if Node is installed:

```sh
node tests/measure-regions.mjs --output=build/internal/measure-current --image-format=hash overview
```

Omit `overview` for all 25 cases; difficult cases take minutes.
Use `tests/measure-ab.mjs` for alternating full-product A/B comparisons;
create fresh snapshots under `build/internal/` before changing the implementation.
Historical single timings cannot establish a new regression on their own.
