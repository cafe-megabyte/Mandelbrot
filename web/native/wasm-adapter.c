/* One translation unit exposes the entire core to Clang's -O3 optimizer. */
#include "../../core/mandelbrot.c"
unsigned abi_version(void) { return 1; }
unsigned output_address(void) { return (unsigned)(uintptr_t)mandelbrot_output(); }
unsigned tile_width(void) { return MANDELBROT_TILE_WIDTH; }
unsigned tile_height(void) { return MANDELBROT_TILE_HEIGHT; }
