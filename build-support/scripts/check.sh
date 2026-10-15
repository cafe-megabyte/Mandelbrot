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
"$INTERNAL/host-tools/js-runner" "$INTERNAL/wasm/engine-simd.wasm" tests/resize-scheduler-check.js
for SOURCE in web/app.js web/resize-scheduler.js web/image-export.js web/png-worker.js web/engine-worker.js web/view.js web/navigation.js web/reference-worker.js web/service-worker.js; do
    sed '/^import /d;s/^export //' "$SOURCE" > "$INTERNAL/tmp/js-syntax.js"
    printf 'new Function(readText("build/internal/tmp/js-syntax.js").replace(/import\\.meta/g,"({url: \\\"file:///test/\\\"})")); var testDone=true;\n' > "$INTERNAL/tmp/parse.js"
    "$INTERNAL/host-tools/js-runner" "$INTERNAL/wasm/engine-simd.wasm" "$INTERNAL/tmp/parse.js"
done
mkdir -p "$INTERNAL/tests/browser"
cp tests/browser.html "$INTERNAL/tests/browser/index.html"
cp tests/zoom-browser.html "$INTERNAL/tests/browser/zoom.html"
"$INTERNAL/host-tools/fixtures" build/web "$INTERNAL/tests"
for SOURCE in web/index.html tests/browser.html tests/optimization-benchmark.html tests/zoom-browser.html; do
    sed -n '/<script type="module">/,/<\/script>/p' "$SOURCE" | sed '1d;$d' > "$INTERNAL/tmp/shell-syntax.js"
    printf 'new (Object.getPrototypeOf(async function(){}).constructor)(readText("build/internal/tmp/shell-syntax.js"));var testDone=true;\n' > "$INTERNAL/tmp/parse.js"
    "$INTERNAL/host-tools/js-runner" "$INTERNAL/wasm/engine-simd.wasm" "$INTERNAL/tmp/parse.js"
done
printf 'Checks passed. Browser test page: build/internal/tests/browser/index.html\n'
