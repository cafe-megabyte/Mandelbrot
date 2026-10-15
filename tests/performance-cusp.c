/* Full-image native Cusp benchmark. Run through performance-cusp.py from the
 * repository root. The immutable before/ snapshot is intentionally required. */
#define _POSIX_C_SOURCE 200809L
#include <stdio.h>
#include <stdlib.h>
#include <stdint.h>
#include <string.h>
#include <math.h>
#include <time.h>

#ifdef BASELINE
#include "../build/internal/performance/before/core/mandelbrot.c"
#include "../build/internal/performance/before/core/deep-zoom.c"
#define IMAGE_PATH "build/internal/performance/full-cusp-before.rgba"
#else
#include "../core/mandelbrot.c"
#include "../core/deep-zoom.c"
#define IMAGE_PATH "build/internal/performance/full-cusp-after.rgba"
#endif

static double monotonic_seconds(void) {
    struct timespec now;
    if (clock_gettime(CLOCK_MONOTONIC, &now)) {
        perror("clock_gettime"); exit(1);
    }
    return (double)now.tv_sec + (double)now.tv_nsec * 1e-9;
}

int main(void) {
    const unsigned width = 1024, height = 768, zoom = 18;
    double base = fmax(3.0 / width, 2.5 / height);
    int exponent = (int)floor(log2(base) - zoom);
    double spacing = ldexp(base, -(int)zoom - exponent);
    unsigned iterations = 512 + 256 * (unsigned)ceil(fmax(0, -9 - exponent - log2(spacing)));
    unsigned bits = (unsigned)(-2 * exponent + 192 + 31) / 32 * 32;
    uint32_t *pixels = malloc((size_t)width * height * sizeof(*pixels));
    if (!pixels) { perror("malloc"); return 1; }
#ifndef BASELINE
    deep_set_options(267);
#endif
    if (!deep_allocate(bits, iterations)) {
        fputs("Cusp workspace allocation failed\n", stderr); return 1;
    }
    clear_big(cr_big); clear_big(ci_big);
    cr_big[fraction - 1] = UINT32_C(0x40000000); /* Exactly c = 1/4 + 0i. */
    if (!deep_configure(width, height, spacing, exponent, iterations, 1, 1)) {
        fputs("Cusp configuration failed\n", stderr); return 1;
    }
    uint64_t skipped = 0, fixed = 0;
#ifndef BASELINE
    uint64_t dd = 0;
#endif
    double start = monotonic_seconds();
    for (unsigned y = 0; y < height; y += 64) {
        for (unsigned x = 0; x < width; x += 256) {
            unsigned rows = height - y < 64 ? height - y : 64;
            unsigned columns = width - x < 256 ? width - x : 256;
            if (deep_render_tile(x, y, columns, rows) != columns * rows * 4) {
                fputs("Cusp tile did not settle\n", stderr); return 1;
            }
            for (unsigned row = 0; row < rows; ++row)
                memcpy(pixels + (y + row) * width + x, output + row * columns, columns * 4);
            skipped += deep_skipped;
            fixed += deep_fallbacks;
#ifndef BASELINE
            dd += (uint64_t)deep_stat_dd_fallbacks();
#endif
        }
    }
    double milliseconds = 1000 * (monotonic_seconds() - start);
    FILE *image = fopen(IMAGE_PATH, "wb");
    if (!image) { perror(IMAGE_PATH); return 1; }
    if (fwrite(pixels, sizeof(*pixels), (size_t)width * height, image) != (size_t)width * height) {
        fputs("Cusp image write failed\n", stderr); fclose(image); return 1;
    }
    if (fclose(image)) { perror(IMAGE_PATH); return 1; }
    free(pixels);
    printf("{\"milliseconds\":%.6f,\"iterations\":%u,\"precisionBits\":%u,"
           "\"skippedIterations\":%llu,\"fixedFallbacks\":%llu,\"ddFallbacks\":",
           milliseconds, iterations, bits, (unsigned long long)skipped, (unsigned long long)fixed);
#ifdef BASELINE
    puts("null}"); /* The previous core does not expose DD telemetry. */
#else
    printf("%llu}\n", (unsigned long long)dd);
#endif
    return 0;
}
