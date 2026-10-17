#!/bin/sh
set -eu
INTERNAL="$PWD/build/internal"
"$CC" -O3 -ffp-contract=off -std=c11 -Wall -Wextra -Werror -isysroot "$SDK" --ld-path="$LD" \
    tests/core-check.c -o "$INTERNAL/tests/core-check"
"$INTERNAL/tests/core-check"
"$CC" -O3 -ffp-contract=off -std=c11 -Wall -Wextra -Werror -isysroot "$SDK" --ld-path="$LD" \
    tests/deep-check.c -o "$INTERNAL/tests/deep-check"
"$INTERNAL/tests/deep-check"
"$INTERNAL/host-tools/js-runner" "$INTERNAL/wasm/engine-simd.wasm" tests/wasm-compare.js
"$INTERNAL/host-tools/js-runner" "$INTERNAL/wasm/engine-simd.wasm" tests/deep-wasm-check.js
"$INTERNAL/host-tools/js-runner" "$INTERNAL/wasm/engine-simd.wasm" tests/view-url-check.js
"$INTERNAL/host-tools/js-runner" "$INTERNAL/wasm/engine-simd.wasm" tests/png-metadata-check.js
"$INTERNAL/host-tools/js-runner" "$INTERNAL/wasm/engine-simd.wasm" tests/symmetry-check.js
"$INTERNAL/host-tools/js-runner" "$INTERNAL/wasm/engine-simd.wasm" tests/resize-scheduler-check.js
"$INTERNAL/host-tools/js-runner" "$INTERNAL/wasm/engine-simd.wasm" tests/tile-queue-check.js
"$INTERNAL/host-tools/js-runner" "$INTERNAL/wasm/engine-simd.wasm" tests/worker-check.js
"$INTERNAL/host-tools/js-runner" "$INTERNAL/wasm/engine-simd.wasm" tests/worker-wasm-check.js
"$INTERNAL/host-tools/js-runner" "$INTERNAL/wasm/engine-simd.wasm" tests/app-lifecycle-check.js
"$INTERNAL/host-tools/js-runner" "$INTERNAL/wasm/engine-simd.wasm" tests/presentation-check.js
"$INTERNAL/host-tools/js-runner" "$INTERNAL/wasm/engine-simd.wasm" tests/preview-check.js
"$INTERNAL/host-tools/js-runner" "$INTERNAL/wasm/engine-simd.wasm" tests/preview-worker-check.js
for SOURCE in web/presentation.js web/preview.js web/preview-worker.js web/app.js web/resize-scheduler.js web/image-export.js web/png-worker.js web/png-metadata.js web/srgb-profile.js web/engine-worker.js web/view.js web/navigation.js web/reference-worker.js web/service-worker.js web/tile-queue.js; do
    sed '/^import /d;s/^export //' "$SOURCE" > "$INTERNAL/tmp/js-syntax.js"
    printf 'new Function(readText("build/internal/tmp/js-syntax.js").replace(/import\\.meta/g,"({url: \\\"file:///test/\\\"})")); var testDone=true;\n' > "$INTERNAL/tmp/parse.js"
    "$INTERNAL/host-tools/js-runner" "$INTERNAL/wasm/engine-simd.wasm" "$INTERNAL/tmp/parse.js"
done
mkdir -p "$INTERNAL/tests/browser"
cp tests/browser.html "$INTERNAL/tests/browser/index.html"
cp tests/zoom-browser.html "$INTERNAL/tests/browser/zoom.html"
cp tests/partial-zoom-browser.html "$INTERNAL/tests/browser/partial-zoom.html"
cp tests/export-regression.html "$INTERNAL/tests/browser/export.html"
cp tests/performance-browser.html "$INTERNAL/tests/browser/performance.html"
cp tests/rendering-browser.html "$INTERNAL/tests/browser/rendering.html"
cp tests/fixtures/regions.json "$INTERNAL/tests/regions.json"
cp tests/numerical-oracle.js "$INTERNAL/tests/numerical-oracle.js"
"$INTERNAL/host-tools/fixtures" build/web "$INTERNAL/tests"
for SOURCE in web/index.html tests/browser.html tests/optimization-benchmark.html tests/zoom-browser.html tests/partial-zoom-browser.html tests/export-regression.html tests/performance-browser.html tests/rendering-browser.html; do
    sed -n '/<script type="module">/,/<\/script>/p' "$SOURCE" | sed '1d;$d' > "$INTERNAL/tmp/shell-syntax.js"
    printf 'new (Object.getPrototypeOf(async function(){}).constructor)(readText("build/internal/tmp/shell-syntax.js"));var testDone=true;\n' > "$INTERNAL/tmp/parse.js"
    "$INTERNAL/host-tools/js-runner" "$INTERNAL/wasm/engine-simd.wasm" "$INTERNAL/tmp/parse.js"
done
printf 'Checks passed. Browser test page: build/internal/tests/browser/index.html\n'
