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
static void check_inscribed_disk(void) {
    require(configure_view(1,1,0,0,1,8192), "Disk test configuration failed");
    /* The disk touches the actual cardioid at these two points. Its other
     * boundary points may pass the stronger, existing cardioid predicate. */
    require(!known_interior(0.25,0) && !known_interior(-0.75,0),
            "Cardioid contact point skipped");
    require(!known_interior(nextafter(0.25,-INFINITY),0) &&
            !known_interior(nextafter(-0.75,INFINITY),0),
            "Disk contact point lost its floating-point error margin");
    require(!known_interior(0.25 + 1e-9,0), "Point outside the cardioid cusp skipped");
    require(known_interior(0.25,1e-9), "Certified point next to the cusp missed");
    require(known_interior(0.25 - 1e-9,1e-10) &&
            known_interior(0.25 - 1e-9,-1e-10),
            "Inscribed disk missed an interior point near the cusp");
    require(reference(0.25 - 1e-9,1e-10) == UINT32_C(0xff000000) &&
            reference(0.25 - 1e-9,-1e-10) == UINT32_C(0xff000000),
            "Cusp shortcut differs from the independent orbit");
    for (unsigned i = 0; i < 256; ++i) {
        double angle = (double)i * 0.024543692606170259;
        double cr = -0.25 + (0.5 - 1e-10) * cos(angle);
        double ci = (0.5 - 1e-10) * sin(angle);
        require(known_interior(cr,ci), "Inscribed disk near-edge point missed");
        require(reference(cr,ci) == UINT32_C(0xff000000),
                "Inscribed disk differs from the independent orbit");
    }
}
/* Exact signs on bounded dyadic grids. The general grid uses at most 2^104
 * intermediates; the cusp grid has |x-1/4|<2e-5, |y|<2e-7 and intermediates
 * below 2^116 even with denominator 2^40. No long-double precision is assumed. */
static int exact_analytic_interior(int64_t r,int64_t i,unsigned bits) {
    __int128 d=(__int128)1<<bits,x=(__int128)r-d/4,yy=(__int128)i*i;
    __int128 q=x*x+yy;
    if (4*q*(q+x*d)<yy*d*d) return 1;
    x=(__int128)r+d;
    return 16*(x*x+yy)<d*d;
}
static void check_certified_analytics(void) {
    uint32_t random=0x741c238bu;
    require(configure_view(3840,2160,0.25001300383157016,-8.626878179687134e-8,
                           6.898685737892433e-11,6912),"Analytical fixture configuration failed");
    for (unsigned sample=0;sample<4000;++sample) {
        random=random*1664525u+1013904223u;
        int64_t r=(int64_t)(random%33554433u)-25165824;
        random=random*1664525u+1013904223u;
        int64_t i=(int64_t)(random%25165825u)-12582912;
        if (known_interior(ldexp((double)r,-24),ldexp((double)i,-24)))
            require(exact_analytic_interior(r,i,24),"Interval filter falsely accepted an exact dyadic point");
    }
    const int64_t d=INT64_C(1)<<40;
    unsigned certified=0;
    for (unsigned sample=0;sample<500;++sample) {
        random=random*1664525u+1013904223u;
        int64_t offset=14000000+(int64_t)(random%600001u),r=d/4+offset;
        double x=ldexp((double)offset,-40),a=0.25-x-2*x*x,c=x*x*x*(x+1);
        double boundary=sqrt(2*c/(a+sqrt(a*a-4*c)));
        int64_t edge=(int64_t)(boundary*(double)d);
        for (int side=-2;side<=2;++side) {
            int64_t i=-(edge+side);
            int inside=known_interior(ldexp((double)r,-40),ldexp((double)i,-40));
            if (inside) {
                require(exact_analytic_interior(r,i,40),"Interval filter crossed the exact cusp boundary");
                ++certified;
            }
        }
    }
    require(certified>500,"Interval filter failed to certify the cusp interior");
    /* Rational unit-circle parametrization gives exact cardioid boundary
     * points: z=((q*q-p*p)+2*p*q*i)/(q*q+p*p), c=z/2-z*z/4.
     * Division rounds their passed doubles, but each true boundary remains
     * within the coordinate interval and therefore must not be accepted. */
    for (int64_t p=1;p<=7;p+=3) for (int64_t q=1;q<=300;q+=3) {
        int64_t sum=q*q+p*p,a=q*q-p*p,b=2*p*q,denominator=4*sum*sum;
        double r=(double)(2*a*sum-a*a+b*b)/(double)denominator;
        double i=(double)(2*b*(sum-a))/(double)denominator;
        require(!known_interior(r,i) && !known_interior(r,-i),
                "Rounded rational cardioid boundary falsely classified as interior");
    }
    {
        const int64_t p=1,q=277,sum=q*q+p*p,a=q*q-p*p,b=2*p*q,denominator=4*sum*sum;
        double r=(double)(2*a*sum-a*a+b*b)/(double)denominator;
        double i=-(double)(2*b*(sum-a))/(double)denominator;
        require(known_interior(r-0x1p-40,i),"Certified interior next to the requested cusp missed");
        require(!known_interior(r+0x1p-40,i),"Exterior next to the requested cusp skipped");
    }
    for (int64_t j=-128;j<=128;++j) {
        const int64_t unit=INT64_C(1)<<24;
        int64_t i=j*unit/512;
        int64_t edge=(int64_t)sqrt((double)(unit*unit/16-i*i));
        for (int side=-2;side<=2;++side) for (int sign=-1;sign<=1;sign+=2) {
            int64_t r=-unit+sign*(edge+side);
            if (known_interior(ldexp((double)r,-24),ldexp((double)i,-24)))
                require(exact_analytic_interior(r,i,24),"Interval filter crossed the exact period-two boundary");
        }
    }
    require(!known_interior(-1.25,0) && !known_interior(-1,0.25) && !known_interior(-1,-0.25),
            "Period-two boundary lost its uncertainty interval");
    require(!known_interior(0.25+0x1p-400,0),"Deep exterior rounded onto the cusp was accepted");
    require(!known_interior(NAN,0) && !known_interior(0,INFINITY),"Nonfinite analytical input accepted");
    require(configure_view(1,1,1e16,-1e16,1,8192),"Cancellation fixture configuration failed");
    require(!known_interior(0,0) && !known_interior(-1,0),
            "Large centre/offset cancellation was not included in the proof");
}
int main(void) {
    const unsigned sizes[][2] = {{1,1},{1,129},{129,1},{31,29},{257,65},{513,129},{320,180}};
    require(!configure(0, 10) && !render_tile(0,0,1,1), "Empty viewport accepted");
    require(configure(1920,1080) == 512, "Unexpected HD iteration limit");
    require(configure(3840,2160) == 768, "Unexpected 4K iteration limit");
    require(configure(7680,4320) == 1024, "Unexpected 8K iteration limit");
    require(known_interior(0,0) && known_interior(-1,0), "Known interior point failed");
    require(!known_interior(1,0) && !known_interior(-2,0), "Uncertain point skipped");
    check_inscribed_disk();
    check_certified_analytics();
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
