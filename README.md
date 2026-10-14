# Mandelbrot

A colourful Mandelbrot set that fills the browser window at its full device-pixel
resolution. Every output pixel is evaluated locally in C compiled to WebAssembly.
SIMD and multiple Web Workers accelerate the computation. JavaScript schedules
work and displays the resulting RGBA pixels; it does not calculate the fractal
or its colours.

There are no visible controls, text, loading indicators or update prompts.
The complete figure remains visible in both portrait and landscape windows.
Reloading, resizing or moving the window to a display with a different pixel
density calculates the matching resolution. Live resizing automatically pauses
when a frame exceeds its time budget; the final image always uses every pixel.
The settled image also becomes a full-resolution PNG with the browser's native
image context menu and drag behavior.
Click the picture to enter fullscreen; use the browser's Escape action to leave.

![Mandelbrot running in the browser](docs/preview.jpg)

## Build completely offline

The only development prerequisite is Apple's Command Line Tools. Install them
once with `xcode-select --install`, or select an existing Xcode installation.
An optional `DEVELOPER_DIR` selects a particular CLT or Xcode installation.

```sh
make                    # build the static website in build/web/
make web                # same product
make check              # build and run native/WASM correctness checks
make serve              # http://localhost:8080/; Ctrl-C stops the server
make inspect            # show SIMD instruction/call summary and assembly paths
make bench              # single-instance scalar/SIMD benchmarks in JavaScriptCore
make bench-optimizations # build developer-only -O3 / -Ofast browser comparison
make rebuild-toolchain  # rebuild the bundled linker; validate/rebuild the website
make clean              # remove generated products, tools, caches and logs
```

The normal build downloads nothing. Node, npm, Python, Homebrew, Emscripten,
CMake, WASI and another LLVM installation are not required. A compiler without
the `wasm32-unknown-unknown` target or SIMD128 support fails explicitly.

Mandelbrot uses Apple Clang to compile its C code and a small XCC linker built
from the included, unmodified upstream source archive. The archive is approximately 0.5 MB; its
filename and extension are arbitrary. See [the source archive record](vendor/SOURCE_ARCHIVES.md)
and [XCC's MIT license](vendor/XCC-LICENSE.txt). No build step uses Git.

Builds run with a clean environment inside a macOS sandbox that denies network
access, reads from package-manager directories and writes outside `build/`.
Extracted sources, patches, host tools, objects, temporary files, compiler
assembly, tests and caches stay under `build/internal/`. Input snapshots are
compared byte for byte, without relying on timestamps or filenames of archives.
Unchanged builds retain their release ID. A missing or truncated package file
causes a rebuild. Only a validated staging package replaces the previous product.

One build holds `build/internal/build.lock`; concurrent builds are rejected
and `clean` never interrupts a running build. A forcibly killed build may leave
this directory behind. Verify that its recorded PID is no longer running before
removing that lock directory. An interrupted final publication restores the
previous product on the next build. Cleanup uses temporary directory ACLs to
prevent Finder from recreating metadata while generated files are being removed.

## Icons from one source

`assets/icon.png` is the only maintained icon image: the transparent blue-glass
Mandelbrot artwork, currently 1254 × 1254 pixels. Replace this file to change all
icons; keep it square and at least 1024 × 1024. The discarded concepts and their
project-local copies have been removed.

Every changed build derives these files using Apple's CoreGraphics and ImageIO,
without additional software or network access:

| Output | Pixel sizes |
| --- | --- |
| PNG favicon | 16, 32, 48 |
| Multi-resolution `favicon.ico` | 16, 32, 48, 64, 128, 256 |
| Apple Touch PNG | 152, 167, 180 |
| Transparent PWA PNG (`purpose: any`) | 192, 512, 1024 |
| Opaque maskable PWA PNG (`purpose: maskable`) | 512, 1024 |

The normal icons retain transparency. The maskable variants add a black
background and fit the visible artwork inside the platform's circular safe zone,
so launcher masks do not cut it off. See the [Web App Manifest specification](https://www.w3.org/TR/appmanifest/#icon-masks)
and [Apple's web icon documentation](https://developer.apple.com/library/archive/documentation/AppleApplications/Reference/SafariWebContent/ConfiguringWebApplications/ConfiguringWebApplications.html).
Transparency does not by itself switch the artwork's colours for dark mode.

All derived files and `site.webmanifest` are generated under `build/`; no resized
source images are maintained. HTML and manifest references use the current
immutable release. Stable `favicon.ico`, `apple-touch-icon.png` and
`site.webmanifest` URLs are also generated at the deployment root and work
offline. Manifest scope, launch URL and default app identity follow that root,
including subdirectory deployments. Icon changes produce a new release, and
missing or invalid current outputs trigger regeneration. Social/OG images are
not generated.

## Deploy

Copy the **complete contents** of `build/web/` to a static HTTPS host, at the
domain root or in a subdirectory. There is no application server, remote API,
CDN dependency, analytics, external font or network computation.

For GitHub Pages, deploy that directory with your preferred Pages workflow or
publish its contents through a Pages branch. Run the build on macOS; Linux
GitHub Actions runners do not provide Apple's compiler and frameworks. This
repository does not upload or publish automatically.

Serve `.wasm` as `application/wasm` and `.js` as JavaScript. Revalidate
`index.html`, `service-worker.js`, `site.webmanifest` and root icon aliases
(`Cache-Control: no-cache` where the host
allows it). Paths under `releases/` are immutable and can be cached indefinitely.
Deploy the entire package, including retained releases. Updating the service
worker before all release files arrive is safe: incomplete updates fail without
replacing the previous installation and retry on a later update check.

`file://` and insecure remote HTTP do not support the required offline setup.
Use HTTPS in production and the loopback server for local development. The
application initially fills the browser's content area. Clicking the picture
requests fullscreen through the standard Fullscreen API.

## Offline startup and automatic updates

The initial shell is black. It does not import the renderer or display a fractal
until the controlling service worker has verified that **every required resource
of one release** is present in Cache Storage. This includes both WASM variants,
the renderer and its helper modules, rendering/PNG workers, navigation shell,
icons, app manifest and third-party license. The engine and
workers must then initialize successfully before rendering starts.

Each build creates a fresh release ID only when inputs or validated products
change. The service worker downloads an immutable, release-specific inventory
and all resources, checks their sizes, checks the HTML's release ID and WASM
headers, then records completion. First installations and updates activate
automatically only after that transaction succeeds. Running pages load code
from the release confirmed by their controlling worker, avoiding mixed versions.

Updates are checked on opening, returning to a visible tab, regaining a
connection, and every five minutes while visible. A new release prepares its
engine and automatically replaces the running renderer. The current image can
remain visible while its replacement is calculated. There is no confirmation,
notification or page-reload loop. Closed or suspended browsers cannot guarantee
background update checks; checking resumes when the app runs again.

After successful installation, navigation, reloads, rendering and resizing work
with the server stopped. Previously cached releases remain available to older
clients. Caches are scoped to this site's path, so separate apps on the same
origin do not share release identities. Browser storage controls can evict or
delete website data. Startup verifies the cache again and attempts repair when
online; a first visit or incomplete installation without a connection stays
black. Rendering cannot make offline data permanent against browser eviction.
Errors appear only in the developer console.

## Computation and performance

The core uses `z = z² + c`, starting at zero, with the escape condition
`|z|² > 4`. Coordinates are sampled at pixel centres using double precision.
The view is centred at `(-0.75, 0)` and contains at least
`[-2.25, 0.75] × [-1.25, 1.25]`. Equal complex-plane spacing on both axes keeps
the figure undistorted; wider or taller windows extend the calculated view.

Let `s = max(3 / physicalWidth, 2.5 / physicalHeight)`. The iteration budget
starts at 512, increases by 256 for each halving of `s` below `1/512`, and is
capped at 8192. Full HD uses 512 iterations, 4K uses 768, and 8K uses 1024.
The budget depends on spatial resolution, not processor speed or a time limit.
Finite escape-time rendering approximates the set: a point that has not escaped
within the budget is black, rather than a proof of mathematical membership.

The hot path is deliberately small:

- Conservative main-cardioid and period-2 tests avoid unnecessary orbits.
- Squared real and imaginary values are retained between iterations.
- SIMD128 computes two adjacent double-precision orbits together until the first
  escapes. Only a surviving lane continues scalarly, avoiding per-iteration
  lane counters, frozen-state masks and work on an already escaped pixel.
- Once per 16 iterations, an exact state-repetition check can prove a cycle in
  the deterministic floating-point orbit. It uses no approximate equality.
- Orbit variables stay in local registers. There are no allocations, imported
  calls, colour calculations or image stores in the iteration loop.
- Smooth escape colouring runs only after escape, using a compact polynomial
  `log2` approximation and a precomputed 4096-entry palette. Membership never
  depends on this colour approximation. Pixels inside the budget are opaque black.

The build uses `-O3 -ffp-contract=off -fno-math-errno`, plus `-msimd128` for the
SIMD module. One translation unit lets Clang optimize and inline the whole core
without LLVM bitcode/LTO support in the small linker. `-O3` is Clang's highest
conforming optimization level. The measured `-Ofast` gain was only about 2% for
SIMD at 4K/8K (see below), so production uses the accurate arithmetic throughout.
Fast-math transformations can change the iterated orbit on other inputs.
The scalar module preserves the same arithmetic order and serves browsers that
cannot validate the SIMD module.

One compiled WASM module is shared with up to eight workers, leaving one reported
logical processor available to the browser where possible. Each worker owns a
fixed WASM tile buffer and memory, independent of the full image dimensions.
Recycled transferable 64 KiB buffers carry tiles of at most 256 × 64 pixels.
One copy from WASM memory into that transfer buffer is necessary because ordinary
WASM memory cannot itself be transferred. No SharedArrayBuffer, cross-origin
isolation headers or relaxed SIMD are required.

Canvas surfaces are at most 1024 × 1024 physical pixels and join without gaps.
This avoids single-canvas side/area limits without reducing the image resolution.
The browser still needs memory proportional to the total displayed pixels:
opaque RGBA alone costs about 31.6 MiB at 4K and 126.6 MiB at 8K, plus browser
overhead and a temporary previous image during replacement. Allocation failure
does not silently reduce resolution.

`devicePixelContentBoxSize` is used when available, with rounded CSS dimensions
times `devicePixelRatio` as the compatibility fallback. The target is one computed
sample per device pixel reported by the browser. OS composition, display scaling
and pinch magnification are outside the app's control. There is no supersampling,
symmetry copying, region filling or low-resolution preview.

Live resizing has a **32 ms frame budget**. Events within one animation frame
are combined, and at most one live calculation runs at a time. Further size
changes replace the target size while that calculation finishes. The last
completed frame's time per pixel predicts whether a new size is worth attempting.
If a live frame exceeds the budget, it is discarded and no more live work starts
during that resize gesture. Already dispatched tiles finish in the workers;
their stale results are ignored and their transfer buffers recycled. The last
complete image scales with the viewport while new computation is deferred.

After **150 ms without a size change**, the newest size is rendered without a
time limit. Window-border mouse release is not exposed consistently to pages;
this idle interval determines the end of a gesture. A complete accurate live
frame at exactly the final size is reused. The next gesture reassesses the cost,
so reducing the window size can enable live computation again. Constants are in
`web/resize-scheduler.js`. No resize controls or status messages appear in the app.

Live frames are revealed only when complete. Initial and settled final frames
stay hidden for up to 500 ms: a fast frame appears complete in one swap; a slower
frame reveals computed full-resolution areas after the threshold. The live
budget is cooperative, checked before accepting or dispatching tiles and before
revealing a frame. It limits computation and canvas updates, but cannot impose a
hard deadline on synchronous browser allocation or OS/compositor scheduling.

### Fullscreen, save, copy or drag the image

A primary click on the rendered picture calls the standard Fullscreen API,
requesting hidden browser navigation UI. The stable viewport container becomes
fullscreen, so recalculation and PNG replacement keep fullscreen active. Once the
fullscreen request completes, any earlier frame is invalidated. After viewport
changes settle for 150 ms, a fresh, unlimited final calculation evaluates every
physical pixel of the new area, even if a transition frame had the same dimensions.
Leaving fullscreen also forces a fresh final calculation through the resize
scheduler. Escape remains the browser's normal exit action.
Further clicks while fullscreen do not toggle it off. Right-click and native image
drag keep their usual behavior. There are no fullscreen buttons or app messages;
browser-owned fullscreen indicators and exit instructions remain under browser
control. Unsupported or denied requests leave the normal view usable. See
[the API documentation](https://developer.mozilla.org/en-US/docs/Web/API/Element/requestFullscreen).

Once the settled PNG is ready, the visible picture is a normal `<img>` element.
Use the browser's **Copy Image**, **Save Image As**, or drag it to the desktop or
a file-manager folder. These actions refer to the complete image at its physical
pixel dimensions, including pictures spanning multiple rendering surfaces.
The app does not cancel `contextmenu` or replace it with a custom menu.

PNG preparation starts after an initial/final frame completes, or after an
accurate live frame settles. It runs asynchronously in a separate worker; no PNG
encoding is added to the C/WASM loop or the live resize frame budget. Resizing
cancels unfinished export work. Until preparation completes, the rendered canvas
surfaces remain visible; the complete native image actions become available
when the PNG replaces them. This can take longer than the fractal calculation,
especially at 8K, without delaying that calculation's display.

The worker receives at most 32 rows at a time, encodes lossless 8-bit RGBA PNG,
and uses native `CompressionStream('deflate')` when available. A stored-DEFLATE
fallback needs no compression library. Neither path allocates a full-image
canvas, so export does not depend on single-canvas area limits. Decoding the PNG
temporarily needs another image's memory; after replacement, the canvas backing
stores are released. PNG bytes, browser image decoding and existing image data
still require memory proportional to the output size.

The local object URL stays valid while its image is displayed and through an
active drag, even if resizing replaces that image. Removed images release their
URLs after the drag ends. Chromium also receives a `DownloadURL` filename hint,
such as `mandelbrot-3840x2160.png`, while its ordinary image drag payload remains
intact. Other browsers choose their own suggested filename; Safari may suggest
`Unknown`. Native file-system drag behavior depends on the browser and OS, as
described in [MDN's drag data documentation](https://developer.mozilla.org/en-US/docs/Web/API/HTML_Drag_and_Drop_API/Drag_data_store).
No image is uploaded, and PNG generation and image actions work offline.
The `mandelbrot-export` event reports dimensions, filename and byte size to the
developer test page without adding visible app UI.

### Measurements

`make bench` reports three warm samples and their median for one WASM instance
in JavaScriptCore at Full HD, 4K and 8K. It includes orbit and colouring work but
excludes worker transfer, canvas display, initial compilation and offline setup.
The browser's parallel end-to-end timing is reported by the `mandelbrot-frame`
DOM event and the developer test page. Neither is visible in the app.

On 14 October 2026, the Codex in-app browser on macOS 27.0.1 reported
the following warm medians of three runs on an Apple M5 Pro (Virtual), with
eight workers and a device pixel ratio of 2:

| Physical resolution | Scalar, one browser instance | SIMD, one browser instance | SIMD, eight workers + display |
| --- | ---: | ---: | ---: |
| 1920 × 1080 | 41.7 ms | 29.8 ms | 9.1 ms |
| 3840 × 2160 | 192.7 ms | 135.8 ms | 37.6 ms |
| 7680 × 4320 | 864.0 ms | 578.5 ms | 150.0 ms |

The last column includes canvas allocation, tile computation, buffer transfers
and pixel writes, ending when the complete frame is revealed. It excludes
initial offline installation, module/worker startup and the browser's subsequent
compositor presentation, as well as subsequent PNG preparation. Large benchmark iframes calculate the requested full
resolution even when only part of the iframe is visible on the test display.
These are measurements on this host, not promised times on other hardware.

An otherwise identical variant without exact cycle checks was also measured
in the same browser: single-instance SIMD took 31.2, 150.7 and 700.1 ms. Exact
cycle detection therefore remained in the final core. The compiler assembly
contains real `f64x2` operations and no calls or memory accesses in the orbit
loops. Sandboxed command-line JavaScriptCore was substantially slower than the
browser on this host; its `make bench` results are useful for that environment
and should not be substituted for browser end-to-end timings.

`make bench-optimizations` builds additional experimental modules only under
`build/internal/bench/`, never into the offline website. Serve `build/` on port
8082 and open `/internal/tests/browser/optimizations.html`. The page warms the
engines, alternates the order of accurate/fast runs, takes five samples per
resolution and compares every SIMD output pixel, including membership.

The same host/browser produced these single-instance medians with Apple Clang
21.0.0; timed work includes orbit and colouring, excludes worker/display costs:

| Physical resolution | Accurate SIMD (`-O3`) | Fast SIMD (`-Ofast`) | Accurate scalar | Fast scalar |
| --- | ---: | ---: | ---: | ---: |
| 3840 × 2160 | 131.0 ms | 128.4 ms | 191.1 ms | 195.4 ms |
| 7680 × 4320 | 571.0 ms | 557.4 ms | 844.9 ms | 861.8 ms |

SIMD improved by only 2.0% / 2.4%; scalar became slightly slower. That gain does
not justify a second runtime module and a second final render after every live
preview. Both SIMD outputs matched every pixel for these two images; this is
evidence for these inputs, not a general guarantee for fast-math arithmetic.

## Checks

`make check` requires only the normal offline toolchain and checks:

- known interior/exterior points, invalid dimensions and tiles, automatic budgets;
- colour logarithm error against the native math library;
- seven complete images, including single-pixel dimensions, odd dimensions and
  partial edge tiles, against an independent native orbit without shortcuts;
- additional 4K/8K boundary tiles with larger budgets and exact cycle detection;
- byte-for-byte agreement of scalar and SIMD WASM with those native references;
- zero WASM imports, ABI version and bounded fixed memory;
- deterministic resize scheduling checks: deadlines, deferred gestures, latest
  size selection, reuse, stale generations, idle timing and disposal;
- JavaScript syntax and completeness of the generated offline package;
- decoded icon dimensions, transparency, every ICO frame, maskable safe zones,
  manifest references and equality of stable aliases with their release files.

For real browser checks, first run `make check`, then start a second loopback
server against the build directory:

```sh
build/internal/host-tools/server build 8082
```

Open `http://localhost:8082/internal/tests/browser/`. Its developer controls check
every displayed RGBA byte against scalar WASM, portrait/landscape resizes, odd
dimensions, multiple canvas surfaces, the 500 ms presentation threshold and
adaptive live resize using delayed worker results. Stop that server and use the page's reload/resize
buttons to verify complete offline operation. The test page is not deployed or
included in the app's offline package.

The offline-icon control checks manifest resolution, scope, launch URL, all PWA
icons, favicon and Apple Touch links, and stable aliases against the controlling
release. It also works after stopping the local server.

The image-export controls decode and compare every PNG pixel against scalar
WASM, check the complete-image MIME type and dimensions, native context-menu
and drag defaults, filename hints, and object-URL lifetime across an active drag
and resize. Additional independent pixel patterns exercise native compression
and stored-DEFLATE strips, including odd dimensions and 65,535-byte block edges.
The large-export control checks all decoded pixels at 4K and 8K.
The fullscreen check arms a real image click, verifies the complete PNG against
scalar WASM after entering fullscreen, exits automatically after ten seconds,
then checks the restored embedded viewport. Its iframe explicitly allows fullscreen.

`make check` also prepares isolated browser-test deployments and records their
paths in `build/internal/tests/fixtures.json`. One deliberately lacks a WASM file;
the other is a complete starting point for update and cache-repair tests. The
browser page's fixture controls use only these generated test deployments.
Restore the missing file by renaming its `.wasm.missing` sibling, then retry
installation. To test updates, copy a subsequently built complete website into
the update fixture, optionally withholding one new resource until after a failed
update check. Keep the old release paths intact. The test page counts document
navigations separately from rendered frames, so a release change without another
navigation verifies the hot switch.

On 14 October 2026, native/WASM checks, the isolated offline build, compiler
assembly inspection, real browser pixel comparisons at device pixel ratio 2,
portrait/landscape and rapid resizes, delayed-worker presentation, and adaptive
live resize all passed. Small gestures produced successive complete live frames;
an 80 ms worker-result delay paused the gesture after its first attempt, followed
by a pixel-verified final image at the latest size. The new resize module was
included in the verified offline package. These checks ran
on the Mac described above. First installation remained black with a missing
WASM file and recovered when it was restored. A missing cached WASM file was
repaired on startup before rendering. An incomplete update preserved the old
version, including reload and pixel-verified resizing with both local servers
stopped. Restoring the update completed an automatic hot switch in two open
clients without document navigation; the new version also reloaded and resized
correctly with the server stopped. Rebuilding after package truncation was
checked as well. PNG export was pixel-verified at 4K and 8K in the in-app browser,
including fresh PNG generation after reload and resizing with the server stopped,
with both compression paths tested on independent pixel patterns. Native Safari
on the same Mac showed Copy Image and Save Image As; Save Image As produced a
complete 2328 × 1464 RGBA PNG. A native Safari image drag exposed a `Files` item
alongside its original image URL. Completing a Finder drop and pasting into
another native app could not be verified through the UI automation.
Fullscreen image clicks were verified in the in-app browser, both online and
with the server stopped: the transition from the embedded image to 2560 × 1440
physical pixels produced a fresh final frame, and every decoded PNG pixel matched
scalar WASM. Fullscreen stayed active through PNG replacement; leaving it also
produced a fresh, pixel-verified frame at the restored viewport size.
Physical mobile devices, standalone Chrome/Firefox, an Intel build host and a
machine with only CLT installed were not tested.

## Source layout

- `core/`: allocation-free scalar/SIMD Mandelbrot computation and colour palette.
- `web/`: minimal shell, offline service worker, rendering and PNG export workers.
- `build-support/`: isolated offline build and native macOS helper tools.
- `vendor/`: original XCC source archive, source record and license.
- `tests/`: independent native references, WASM comparisons and browser checks.

Proudly generated with ChatGPT
