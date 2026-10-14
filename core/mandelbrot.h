#ifndef MANDELBROT_H
#define MANDELBROT_H
#include <stdint.h>

#define MANDELBROT_TILE_WIDTH 256u
#define MANDELBROT_TILE_HEIGHT 64u
#define MANDELBROT_TILE_PIXELS (MANDELBROT_TILE_WIDTH * MANDELBROT_TILE_HEIGHT)

/* Each instance owns one fixed-size output tile, never a full-frame arena. */
unsigned configure(unsigned width, unsigned height);
unsigned configure_view(unsigned width, unsigned height, double real, double imag, double spacing, unsigned iterations);
unsigned iteration_limit(void);
double pixel_step(void);
unsigned render_tile(unsigned x, unsigned y, unsigned width, unsigned height);
const uint32_t *mandelbrot_output(void);
#endif
