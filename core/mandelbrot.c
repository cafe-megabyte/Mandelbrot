#include "mandelbrot.h"
#if defined(__wasm_simd128__)
#include <wasm_simd128.h>
#endif

static unsigned frame_width, frame_height, limit;
static double step, half_width, half_height, centre_real = -0.75, centre_imag;
static _Alignas(16) uint32_t output[MANDELBROT_TILE_PIXELS];
static uint32_t palette[4096];
static int palette_ready;

/* The only division/transcendent-like work is after escape, outside the orbit
 * loop. Range reduction plus the atanh series approximates log2 to < 2e-8
 * for positive normal doubles; this affects colour only, never membership. */
static inline double colour_log2(double value) {
    union { double f; uint64_t u; } bits = { .f = value };
    int exponent = (int)((bits.u >> 52) & 2047u) - 1023;
    bits.u = (bits.u & UINT64_C(0x000fffffffffffff)) | UINT64_C(0x3ff0000000000000);
    double t = (bits.f - 1.0) / (bits.f + 1.0), s = t * t;
    double p = 1.0 / 13.0;
    p = 1.0 / 11.0 + s * p;
    p = 1.0 / 9.0 + s * p;
    p = 1.0 / 7.0 + s * p;
    p = 1.0 / 5.0 + s * p;
    p = 1.0 / 3.0 + s * p;
    return exponent + 2.8853900817779268147 * t * (1.0 + s * p);
}

static void prepare_palette(void) {
    static const struct { unsigned position, r, g, b; } stops[] = {
        {0, 0, 7, 100}, {655, 32, 107, 203}, {1638, 180, 255, 255},
        {1966, 255, 245, 208}, {2703, 255, 170, 0},
        {3522, 55, 13, 91}, {4096, 0, 7, 100}
    };
    unsigned segment = 0;
    for (unsigned i = 0; i < 4096; ++i) {
        while (i >= stops[segment + 1].position) ++segment;
        double t = (double)(i - stops[segment].position) /
                   (stops[segment + 1].position - stops[segment].position);
        unsigned r = (unsigned)(stops[segment].r + t * ((double)stops[segment + 1].r - stops[segment].r) + 0.5);
        unsigned g = (unsigned)(stops[segment].g + t * ((double)stops[segment + 1].g - stops[segment].g) + 0.5);
        unsigned b = (unsigned)(stops[segment].b + t * ((double)stops[segment + 1].b - stops[segment].b) + 0.5);
        palette[i] = UINT32_C(0xff000000) | (b << 16) | (g << 8) | r;
    }
    palette_ready = 1;
}

unsigned configure(unsigned width, unsigned height) {
    frame_width = frame_height = 0;
    if (!width || !height || width > INT32_MAX || height > INT32_MAX) return 0;
    frame_width = width; frame_height = height;
    half_width = 0.5 * width; half_height = 0.5 * height;
    double sx = 3.0 / width, sy = 2.5 / height;
    step = sx > sy ? sx : sy;
    centre_real = -0.75; centre_imag = 0;
    limit = 512;
    for (double threshold = 1.0 / 512.0; step < threshold && limit < 8192; threshold *= 0.5)
        limit += 256;
    if (!palette_ready) prepare_palette();
    return limit;
}
unsigned configure_view(unsigned width, unsigned height, double real, double imag, double spacing, unsigned iterations) {
    if (!configure(width, height) || !__builtin_isfinite(real) || !__builtin_isfinite(imag) ||
        !__builtin_isfinite(spacing) || spacing <= 0 || !iterations || iterations > INT32_MAX) {
        frame_width = 0; return 0;
    }
    centre_real = real; centre_imag = imag; step = spacing; limit = iterations;
    return limit;
}
unsigned iteration_limit(void) { return limit; }
double pixel_step(void) { return step; }
const uint32_t *mandelbrot_output(void) { return output; }

typedef struct { double lo, hi; } AnalyticInterval;
/* Adjacent IEEE doubles give outward bounds without changing the rounding
 * mode or importing nextafter into the WASM module. Callers use finite values. */
static inline double analytic_down(double value) {
    if (!value) return -0x1p-1074;
    union { double f; uint64_t u; } bits = {.f=value};
    if (value > 0) --bits.u; else ++bits.u;
    return bits.f;
}
static inline double analytic_up(double value) {
    if (value==__builtin_inf()) return value;
    if (!value) return 0x1p-1074;
    union { double f; uint64_t u; } bits = {.f=value};
    if (value > 0) ++bits.u; else --bits.u;
    return bits.f;
}
static inline double analytic_abs(double value) { return value < 0 ? -value : value; }
static inline double analytic_coordinate_error(double value, double centre) {
    double magnitude = analytic_up(analytic_abs(value) + analytic_abs(centre));
    return analytic_up(analytic_up(magnitude * 0x1p-49) + 0x1p-1070);
}
static inline AnalyticInterval analytic_shift(AnalyticInterval a, double b) {
    return (AnalyticInterval){analytic_down(a.lo+b),analytic_up(a.hi+b)};
}
static inline AnalyticInterval analytic_square(AnalyticInterval a) {
    double left=a.lo*a.lo,right=a.hi*a.hi;
    double hi=analytic_up(left>right?left:right);
    double lo=a.lo<=0 && a.hi>=0?0:analytic_down(left<right?left:right);
    return (AnalyticInterval){lo<0?0:lo,hi};
}
/* Certify the entire coordinate interval, not merely its rounded midpoint.
 * Let u=2^-53 and eta=2^-1074. The three-limb deep-centre conversion has error
 * <=4u|a|+eta in the stored centre a. The pixel offset d has error
 * <=2u|d|+2eta, and the final sum s has error <=u(|a|+|d|)+eta.
 * Since |d|<=2(|a|+|s|+eta), their sum is bounded by
 * 11u|a|+6u|s|+(4+6u)eta < 16u(|a|+|s|)+16eta.
 * Shallow coordinates have fewer rounding steps and obey the same bound.
 * Every subsequent arithmetic operation is enclosed by adjacent doubles.
 * Strict inequalities leave any unproved boundary point in the orbit path. */
static int certified_interior(double cr, double ci) {
    if (!__builtin_isfinite(cr) || !__builtin_isfinite(ci) ||
        !__builtin_isfinite(centre_real) || !__builtin_isfinite(centre_imag)) return 0;
    double er=analytic_coordinate_error(cr,centre_real),ei=analytic_coordinate_error(ci,centre_imag);
    /* Very large cancellation is outside this bounded, overflow-free proof. */
    if (!(er<1 && ei<1)) return 0;
    AnalyticInterval real={analytic_down(cr-er),analytic_up(cr+er)};
    AnalyticInterval imag={analytic_down(ci-ei),analytic_up(ci+ei)};
    AnalyticInterval yy=analytic_square(imag);
    /* The disk |c+1/4|<1/2 lies inside the main cardioid. It must enclose
       the full uncertainty interval just like the polynomial test below. */
    if (real.lo>-0.75 && real.hi<0.25) {
        AnalyticInterval disk=analytic_square(analytic_shift(real,0.25));
        if (analytic_up(disk.hi+yy.hi)<0.25) return 1;
    }
    AnalyticInterval x=analytic_shift(real,-0.25),xx=analytic_square(x);
    AnalyticInterval q={analytic_down(xx.lo+yy.lo),analytic_up(xx.hi+yy.hi)};
    if (q.lo<0) q.lo=0;
    double sum_hi=analytic_up(q.hi+x.hi);
    /* q>=0; when q+x is negative its upper product uses q's LOWER bound. */
    double lhs_hi=analytic_up((sum_hi<0?q.lo:q.hi)*sum_hi);
    double rhs_lo=analytic_down(0.25*yy.lo);
    if (lhs_hi<rhs_lo) return 1;
    if (real.lo>-1.25 && real.hi<-0.75) {
        AnalyticInterval bulb=analytic_square(analytic_shift(real,1));
        if (analytic_up(bulb.hi+yy.hi)<0.0625) return 1;
    }
    return 0;
}

static inline __attribute__((always_inline)) int known_interior(double cr, double ci) {
    if (cr<-1.25 || cr>0.375 || analytic_abs(ci)>0.65) return 0;
    /* Cheap certificates for ordinary views, with a proved coarse margin.
     * If |centre|<=2, each coordinate error above is <64u. On the slightly
     * enlarged rectangle, the cardioid polynomial's derivative magnitudes
     * are <24 in cr and <10 in ci. Its rounded evaluation, including the
     * threshold comparison, adds <256u. Total error is therefore <2432u,
     * less than 8192u=2^-40. For either disk the derivative sum is <5 and
     * evaluation error <256u, giving the still smaller bound <576u.
     * Ambiguous points retain the full interval proof; no guessed epsilon
     * is used to decide points near the cusp or either analytic boundary. */
    if (analytic_abs(centre_real)<=2 && analytic_abs(centre_imag)<=2) {
        const double margin=0x1p-40;
        double yy=ci*ci,x=cr-0.25,q=x*x+yy;
        if (q+cr<0.25-margin) return 1;
        double lhs=q*(q+x),rhs=0.25*yy;
        if (lhs<rhs-margin) return 1;
        x=cr+1;
        double bulb=x*x+yy;
        if (bulb<0.0625-margin) return 1;
        if (lhs>rhs+margin && bulb>0.0625+margin) return 0;
    }
    return certified_interior(cr,ci);
}

static inline uint32_t colour(unsigned n, double magnitude) {
    if (n == limit) return UINT32_C(0xff000000);
    double smooth = n + 1.0 - colour_log2(0.5 * colour_log2(magnitude));
    unsigned index = (unsigned)(int64_t)__builtin_floor(smooth * 96.0) & 4095u;
    return palette[index];
}

/* Cached squares remove two multiplications from the next iteration. All
 * orbit state is local; no allocation, calls, palette work or stores here. */
static inline __attribute__((always_inline)) uint32_t finish_orbit(double cr, double ci, double x, double y,
                                    double xx, double yy, unsigned n) {
    double checkpoint_x = x, checkpoint_y = y;
    unsigned checkpoint_span = 16, next_checkpoint = n + 16;
    while (n < limit && xx + yy <= 4.0) {
        unsigned end = n + 16 < limit ? n + 16 : limit;
        do {
            y = (x + x) * y + ci;
            x = xx - yy + cr;
            xx = x * x; yy = y * y;
            ++n;
        } while (n < end && xx + yy <= 4.0);
        /* Exact state repetition proves a cycle in this deterministic floating-
         * point orbit. Check once per 16 iterations, never by an epsilon. */
        if (x == checkpoint_x && y == checkpoint_y) return UINT32_C(0xff000000);
        if (n == next_checkpoint) {
            checkpoint_x = x; checkpoint_y = y;
            checkpoint_span *= 2; next_checkpoint = n + checkpoint_span;
        }
    }
    return colour(n, xx + yy);
}
static inline uint32_t scalar_pixel(double cr, double ci) {
    if (known_interior(cr, ci)) return UINT32_C(0xff000000);
    return finish_orbit(cr, ci, 0.0, 0.0, 0.0, 0.0, 0);
}

#if defined(__wasm_simd128__)
/* Four pixels stream through two independent f64x2 orbits. Each lane performs
 * exactly the scalar operation sequence of finish_orbit (no contraction), so
 * every escape iteration and magnitude is bit-identical. The second vector
 * hides floating-point latency; a lane that escapes, reaches the limit or
 * repeats its exact state is refilled with the tile's next pixel instead of
 * finishing its partner lane scalarly. Exact state repetition proves a cycle
 * of this deterministic orbit, so the checkpoint schedule cannot change any
 * result, only how early a periodic pixel stops. Idle lanes iterate c=0. */
#ifndef STREAM_PREFIX
#define STREAM_PREFIX 4
#endif
static inline v128_t lane_set(v128_t v, unsigned lane, double value) {
    return lane ? wasm_f64x2_replace_lane(v, 1, value) : wasm_f64x2_replace_lane(v, 0, value);
}
static void render_stream(unsigned tx, unsigned ty, unsigned width, unsigned height) {
    const v128_t four = wasm_f64x2_splat(4.0), zero = wasm_f64x2_splat(0.0);
    v128_t cx0 = zero, cx1 = zero, cy0 = zero, cy1 = zero, x0 = zero, x1 = zero, y0 = zero, y1 = zero;
    v128_t xx0 = zero, xx1 = zero, yy0 = zero, yy1 = zero, kx0 = zero, kx1 = zero, ky0 = zero, ky1 = zero;
    uint64_t tick = 1024, start[4] = {0}, next_check[4] = {0}, span[4] = {0};
    unsigned index[4] = {0}, active = 0, refill = 15, total = width * height, next = 0, row = 0, col = 0;
    double ci = centre_imag + (half_height - ((double)ty + 0.5)) * step;
    for (;;) {
        /* Load the next non-interior pixels into every lane marked for refill. */
        for (unsigned lane = 0; refill; ++lane) {
            if (!(refill & (1u << lane))) continue;
            refill &= ~(1u << lane);
            double cr = 0, ci_lane = 0, sx = 0, sy = 0, sxx = 0, syy = 0;
            active &= ~(1u << lane);
            while (next < total) {
                unsigned pixel = next++;
                double r = centre_real + (((double)(tx + col) + 0.5) - half_width) * step, i = ci;
                if (++col == width) { col = 0; ++row; ci = centre_imag + (half_height - ((double)(ty + row) + 0.5)) * step; }
                if (known_interior(r, i)) { output[pixel] = UINT32_C(0xff000000); continue; }
                /* Short orbits finish in the identical scalar sequence; only
                   longer ones occupy a lane, avoiding a stop per early escape.
                   Four iterations measured best (overview to zoom 2^-24). */
                double px = 0, py = 0, pxx = 0, pyy = 0;
                unsigned n = 0, prefix = limit < STREAM_PREFIX ? limit : STREAM_PREFIX;
                do {
                    py = (px + px) * py + i;
                    px = pxx - pyy + r;
                    pxx = px * px; pyy = py * py;
                    ++n;
                } while (n < prefix && pxx + pyy <= 4.0);
                if (pxx + pyy > 4.0) { output[pixel] = colour(n, pxx + pyy); continue; }
                if (n == limit) { output[pixel] = UINT32_C(0xff000000); continue; }
                cr = r; ci_lane = i; index[lane] = pixel; active |= 1u << lane;
                start[lane] = tick - n; next_check[lane] = 16; span[lane] = 16;
                sx = px; sy = py; sxx = pxx; syy = pyy;
                break;
            }
            unsigned half = lane & 1;
            if (lane < 2) {
                cx0 = lane_set(cx0, half, cr); cy0 = lane_set(cy0, half, ci_lane);
                x0 = lane_set(x0, half, sx); y0 = lane_set(y0, half, sy);
                xx0 = lane_set(xx0, half, sxx); yy0 = lane_set(yy0, half, syy);
                kx0 = lane_set(kx0, half, 0); ky0 = lane_set(ky0, half, 0);
            } else {
                cx1 = lane_set(cx1, half, cr); cy1 = lane_set(cy1, half, ci_lane);
                x1 = lane_set(x1, half, sx); y1 = lane_set(y1, half, sy);
                xx1 = lane_set(xx1, half, sxx); yy1 = lane_set(yy1, half, syy);
                kx1 = lane_set(kx1, half, 0); ky1 = lane_set(ky1, half, 0);
            }
        }
        if (!active) return;
        /* Run to the next 16-step boundary, the earliest lane limit or an escape. */
        uint64_t end = (tick | 15) + 1;
        for (unsigned lane = 0; lane < 4; ++lane)
            if ((active & (1u << lane)) && start[lane] + limit < end) end = start[lane] + limit;
        unsigned escaped;
        do {
            y0 = wasm_f64x2_add(wasm_f64x2_mul(wasm_f64x2_add(x0, x0), y0), cy0);
            y1 = wasm_f64x2_add(wasm_f64x2_mul(wasm_f64x2_add(x1, x1), y1), cy1);
            x0 = wasm_f64x2_add(wasm_f64x2_sub(xx0, yy0), cx0);
            x1 = wasm_f64x2_add(wasm_f64x2_sub(xx1, yy1), cx1);
            xx0 = wasm_f64x2_mul(x0, x0); yy0 = wasm_f64x2_mul(y0, y0);
            xx1 = wasm_f64x2_mul(x1, x1); yy1 = wasm_f64x2_mul(y1, y1);
            ++tick;
            escaped = wasm_i64x2_bitmask(wasm_f64x2_gt(wasm_f64x2_add(xx0, yy0), four)) |
                      wasm_i64x2_bitmask(wasm_f64x2_gt(wasm_f64x2_add(xx1, yy1), four)) << 2;
        } while (!(escaped & active) && tick < end);
        double magnitude[4];
        wasm_v128_store(magnitude, wasm_f64x2_add(xx0, yy0));
        wasm_v128_store(magnitude + 2, wasm_f64x2_add(xx1, yy1));
        unsigned finished = 0;
        for (unsigned lane = 0; lane < 4; ++lane) {
            if (!(active & (1u << lane))) continue;
            uint64_t n = tick - start[lane];
            if (escaped & (1u << lane)) { output[index[lane]] = colour((unsigned)n, magnitude[lane]); finished |= 1u << lane; }
            else if (n == limit) { output[index[lane]] = UINT32_C(0xff000000); finished |= 1u << lane; }
        }
        if (!(tick & 15)) {
            unsigned repeated = wasm_i64x2_bitmask(wasm_v128_and(wasm_f64x2_eq(x0, kx0), wasm_f64x2_eq(y0, ky0))) |
                wasm_i64x2_bitmask(wasm_v128_and(wasm_f64x2_eq(x1, kx1), wasm_f64x2_eq(y1, ky1))) << 2;
            for (unsigned lane = 0; lane < 4; ++lane) {
                unsigned bit = 1u << lane;
                if (!(active & bit) || (finished & bit)) continue;
                uint64_t n = tick - start[lane];
                if (repeated & bit) { output[index[lane]] = UINT32_C(0xff000000); finished |= bit; continue; }
                if (n >= next_check[lane]) {
                    unsigned half = lane & 1;
                    if (lane < 2) {
                        kx0 = lane_set(kx0, half, half ? wasm_f64x2_extract_lane(x0, 1) : wasm_f64x2_extract_lane(x0, 0));
                        ky0 = lane_set(ky0, half, half ? wasm_f64x2_extract_lane(y0, 1) : wasm_f64x2_extract_lane(y0, 0));
                    } else {
                        kx1 = lane_set(kx1, half, half ? wasm_f64x2_extract_lane(x1, 1) : wasm_f64x2_extract_lane(x1, 0));
                        ky1 = lane_set(ky1, half, half ? wasm_f64x2_extract_lane(y1, 1) : wasm_f64x2_extract_lane(y1, 0));
                    }
                    span[lane] *= 2; next_check[lane] = n + span[lane];
                }
            }
        }
        refill = finished;
    }
}
#endif

unsigned render_tile(unsigned tx, unsigned ty, unsigned width, unsigned height) {
    if (!frame_width || !width || !height || width > MANDELBROT_TILE_WIDTH ||
        height > MANDELBROT_TILE_HEIGHT || width > frame_width || height > frame_height ||
        tx > frame_width - width || ty > frame_height - height) return 0;
#if defined(__wasm_simd128__)
    render_stream(tx, ty, width, height);
#else
    uint32_t *dst = output;
    for (unsigned row = 0; row < height; ++row) {
        double ci = centre_imag + (half_height - ((double)(ty + row) + 0.5)) * step;
        unsigned col = 0;
        for (; col < width; ++col) {
            double cr = centre_real + (((double)(tx + col) + 0.5) - half_width) * step;
            *dst++ = scalar_pixel(cr, ci);
        }
    }
#endif
    return width * height * 4u;
}
