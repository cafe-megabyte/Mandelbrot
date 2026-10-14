#include <stdio.h>
#include <stdlib.h>
#include <math.h>
#include "../core/mandelbrot.c"

static void require(int valid, const char *message) {
    if (!valid) { fprintf(stderr, "%s\n", message); exit(1); }
}
/* Independent orbit with no shortcuts or SIMD; same specified operation order. */
static uint32_t reference(double cr, double ci) {
    double x = 0, y = 0; unsigned n = 0;
    while (n < limit && x * x + y * y <= 4.0) {
        double next = x * x - y * y + cr;
        y = (x + x) * y + ci; x = next; ++n;
    }
    return colour(n, x * x + y * y);
}
int main(void) {
    const unsigned sizes[][2] = {{1,1},{1,129},{129,1},{31,29},{257,65},{513,129},{320,180}};
    require(!configure(0, 10) && !render_tile(0,0,1,1), "Empty viewport accepted");
    require(configure(1920,1080) == 512, "Unexpected HD iteration limit");
    require(configure(3840,2160) == 768, "Unexpected 4K iteration limit");
    require(configure(7680,4320) == 1024, "Unexpected 8K iteration limit");
    require(known_interior(0,0) && known_interior(-1,0), "Known interior point failed");
    require(!known_interior(1,0) && !known_interior(-2,0), "Uncertain point skipped");
    for (unsigned i = 0; i < 10000; ++i) {
        double x = 1.0001 + (double)i * 0.031;
        require(fabs(colour_log2(x) - log2(x)) < 2e-8, "Colour log2 error too large");
    }
    for (unsigned test = 0; test < sizeof(sizes)/sizeof(sizes[0]); ++test) {
        unsigned w = sizes[test][0], h = sizes[test][1]; configure(w,h);
        require(!render_tile(w,0,1,1) && !render_tile(0,h,1,1) && !render_tile(0,0,257,1), "Invalid tile accepted");
        uint32_t *frame = malloc((size_t)w * h * 4); require(frame != NULL, "Allocation failed");
        for (unsigned y = 0; y < h; y += 64) for (unsigned x = 0; x < w; x += 256) {
            unsigned tw = w - x < 256 ? w - x : 256, th = h - y < 64 ? h - y : 64;
            require(render_tile(x,y,tw,th) == tw*th*4, "Tile size mismatch");
            for (unsigned row = 0; row < th; ++row) for (unsigned col = 0; col < tw; ++col) {
                double cr = -0.75 + (((double)(x+col)+0.5)-half_width)*step;
                double ci = (half_height-((double)(y+row)+0.5))*step;
                uint32_t expected = reference(cr,ci);
                require(output[row*tw+col] == expected, "Analytical shortcut differs from reference orbit");
                frame[(y+row)*w+x+col] = expected;
            }
        }
        char path[160]; snprintf(path,sizeof(path),"build/internal/tests/reference-%u-%u.rgba",w,h);
        FILE *file = fopen(path,"wb"); require(file != NULL, "Cannot write reference");
        require(fwrite(frame,4,(size_t)w*h,file) == (size_t)w*h, "Reference write failed"); fclose(file); free(frame);
    }
    const unsigned tiles[][4] = {{3840,2160,2440,384},{7680,4320,4880,800},{7680,4320,3800,2000}};
    for (unsigned test = 0; test < sizeof(tiles)/sizeof(tiles[0]); ++test) {
        unsigned w=tiles[test][0],h=tiles[test][1],x=tiles[test][2],y=tiles[test][3]; configure(w,h);
        require(render_tile(x,y,256,64)==256*64*4,"Boundary tile failed");
        for (unsigned row=0;row<64;++row) for (unsigned col=0;col<256;++col) {
            double cr=-0.75+(((double)(x+col)+0.5)-half_width)*step;
            double ci=(half_height-((double)(y+row)+0.5))*step;
            require(output[row*256+col]==reference(cr,ci),"Cycle detection differs from reference orbit");
        }
        char path[160];snprintf(path,sizeof(path),"build/internal/tests/tile-%u-%u-%u-%u.rgba",w,h,x,y);
        FILE *file=fopen(path,"wb");require(file!=NULL,"Cannot write tile reference");
        require(fwrite(output,4,256*64,file)==256*64,"Tile write failed");fclose(file);
    }
    puts("Native orbit, analytical tests, iteration budgets and colour precision passed.");
    return 0;
}
