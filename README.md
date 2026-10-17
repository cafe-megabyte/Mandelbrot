# Mandelbrot

A fullscreen Mandelbrot explorer, calculated locally in C/WebAssembly with
SIMD and Web Workers. Renders at device-pixel resolution and works offline
after its first successful installation. No external services or dependencies.

![Mandelbrot preview](docs/preview.jpg)

## Use

- Wheel or pinch to zoom; drag to pan.
- Click for fullscreen; Escape to leave.
- `R` or `Home` resets the view.
- Right-click the completed image to copy or save a full-resolution PNG.
- Copy the URL to share or restore the selected centre and zoom.

Navigation uses an adaptive GPU preview where supported, with a WASM fallback.
Already visible partial tiles stay enlarged while navigating, even if a preview times out.
Accurate tiles appear progressively over the preview. Slow renders show completed
pixels and percentage after 500 ms. English is
the default; a German primary browser language selects German.

## Build

Requires macOS and Apple's Command Line Tools (`xcode-select --install`).
Builds are offline; Node, npm and Emscripten are not required.

```sh
make          # static website in build/web/
make serve    # http://localhost:8080/; Ctrl-C to stop
make check    # native, WASM and app checks
make bench    # scalar/SIMD kernel benchmarks
make clean    # remove generated files
```

For browser checks, run `make check`, then
`build/internal/host-tools/server build 8082` and open
`http://localhost:8082/internal/tests/browser/`.

## Deploy

Copy all of `build/web/` to a static HTTPS host, including `releases/`.
Subdirectories are supported. Serve `.wasm` as `application/wasm` and `.js`
as JavaScript. Revalidate the root HTML, service worker, manifest and icon
aliases; files under `releases/` can be cached indefinitely.

Offline installation and updates activate automatically after a complete
release is cached. Browser storage eviction can require a fresh download.

## Development

- `core/`: scalar/SIMD rendering, adaptive deep-zoom arithmetic and colours.
- `web/`: navigation, workers, display, PNG export and offline updates.
- `tests/`: correctness checks, browser tools and 25 exact 4K reference regions.
- `build-support/`, `vendor/`: offline build tools and bundled XCC sources.
- `assets/icon.png`: source for all generated icons.

Rendering uses a finite iteration budget: black pixels are not a proof of
membership. Deep zoom can take minutes and is limited by time and memory.
Keep numerical results and full-resolution output intact when optimizing.

See [development notes](docs/NOTES.md) and [4K references](docs/baseline-4k.md).
Exported PNGs include exact view metadata and an embedded sRGB profile;
see [PNG metadata](docs/png-metadata.md).
Bundled linker: [source record](vendor/SOURCE_ARCHIVES.md),
[XCC MIT license](vendor/XCC-LICENSE.txt).

Proudly generated with ChatGPT
