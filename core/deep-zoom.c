/* Deep zoom: dynamically sized fixed-point reference, scaled perturbations and
 * conservative BLA remainder bounds. Included after mandelbrot.c. No imports. */
#include <stddef.h>
#if !defined(__wasm__)
#include <stdlib.h>
#endif

typedef struct { double r, i; int e, pad; } Extended;
typedef struct { Extended a, b, q, radius; unsigned steps, pad; } Approximation;
typedef struct { unsigned count, levels, offset[28], length[28]; } DeepHeader;
static unsigned char *arena;
static size_t arena_capacity;
static unsigned digits, fraction, reference_iteration, reference_limit;
static uint32_t *cr_big, *ci_big, *xr_big, *xi_big, *scratch[8], *product;
static uint32_t *checkpoint_real, *checkpoint_imag;
static uint32_t *frame_real, *frame_imag;
static int frame_rs, frame_is, frame_on_axis;
static unsigned checkpoint_iteration;
static int checkpoint_rs, checkpoint_is;
static int cr_sign, ci_sign, xr_sign, xi_sign;
static DeepHeader *deep_header;
static Extended *orbit;
static Extended *bailout_margin;
static Approximation *approximations;
/* Payload tail: the reference orbit as double-doubles (zr hi, lo, zi hi, lo)
 * and an upper bound on reference_error/|Z| over the computed orbit. */
static double *orbit_dd,*orbit_dd_error;
/* Global references (deep_begin from JavaScript) always carry the DD copy.
 * Local references skip it: most tiles never need DD perturbation, and the
 * copy measurably slowed reference-bound views. A tile that needs it repeats
 * the identical fixed-point pass once with the copy (rebuild_reference_dd). */
static int reference_dd_enabled=1;
static unsigned reference_dd_fraction;
static Extended spacing_extended, image_radius;
static uint64_t deep_skipped;
static unsigned deep_fallbacks;
enum { DEEP_SQUARE=1, DEEP_LAZY_REFERENCE=2, DEEP_BLA_ONE=4,
       DEEP_SERIES_NORMS=8, DEEP_ADAPTIVE_REFERENCE=16, DEEP_RESCALED=32,
       DEEP_DD_CACHE=64, DEEP_SIMD=128, DEEP_KARATSUBA=256, DEEP_BLACK_CERTIFICATE=512,
       DEEP_PRECISE_SERIES=1024, DEEP_REUSE_REFERENCE=2048, DEEP_TIGHT_SERIES=4096, DEEP_DOUBLE_PERTURB=8192, DEEP_DD_PERTURB=16384 };
#define DEEP_DEFAULT_OPTIONS (DEEP_SQUARE|DEEP_LAZY_REFERENCE|DEEP_SERIES_NORMS|DEEP_KARATSUBA|DEEP_BLACK_CERTIFICATE|DEEP_PRECISE_SERIES|DEEP_REUSE_REFERENCE|DEEP_DOUBLE_PERTURB|DEEP_DD_PERTURB)
static unsigned deep_options=DEEP_DEFAULT_OPTIONS;
static uint64_t deep_dd_fallbacks, deep_dd_iterations, deep_fixed_iterations;
static uint64_t deep_reference_iterations, deep_local_references, deep_perturb_iterations;
static uint64_t deep_certified_pixels, deep_certificate_iterations, deep_dd_perturb_iterations, deep_dd_perturb_pixels;
static int reference_bounded;
/* Exactly real references in [-2,1/4] (see deep_begin) are cut off once the
 * derivative bound exceeds 2^64/spacing; reference_truncated ends the build. */
static int reference_real_bounded,reference_truncated;
static Extended reference_derivative,reference_cutoff;
static unsigned tile_completed, tile_x, tile_y, tile_w, tile_h;
static int tile_active;
static double reference_origin_x,reference_origin_y;
static unsigned reference_x,reference_y,reference_width,reference_height;
static unsigned reference_options;
static int reference_reuse_safe;
static int reference_local,reference_ready,request_reference,allow_reference;
static Extended series_coefficients[8], series_error, series_radius;
static unsigned series_start;
static Extended reference_error;
static unsigned precision_needed;
static int rounded_product;
static unsigned prefix_dd_active,prefix_dd_used;
/* Derived double copy of the stored orbit, placed after the limb workspace. */
static double *orbit_double;
static int orbit_double_ready;
static void prefix_dd_begin(void);
static void prefix_dd_before(void);
static void prefix_dd_after(void);

unsigned deep_default_options(void){return DEEP_DEFAULT_OPTIONS;}
void deep_set_options(unsigned options){deep_options=options;}
void deep_reset_stats(void){
    deep_skipped=deep_fallbacks=0;
    deep_dd_fallbacks=deep_dd_iterations=deep_fixed_iterations=0;
    deep_reference_iterations=deep_local_references=deep_perturb_iterations=0;
    deep_certified_pixels=deep_certificate_iterations=0;
    deep_dd_perturb_iterations=deep_dd_perturb_pixels=0;
}

static inline double absd(double x) { return x < 0 ? -x : x; }
static inline double power_two(int e) {
    union { uint64_t u; double f; } v;
    if (e < -1074) return 0;
    if (e < -1022) { v.u = UINT64_C(1) << (e + 1074); return v.f; }
    if (e > 1023) return __builtin_inf();
    v.u = (uint64_t)(e + 1023) << 52; return v.f;
}
/* Always inlined: an out-of-line ext returns its struct through memory, and
 * every Extended operation would become a call (measured +10-20% at 2^-100).
 * Keep the original tail-recursive subnormal step: LLVM turns it into a loop.
 * Unrolling it by hand or moving it out of line both measured slower. */
static inline __attribute__((always_inline)) Extended ext(double r, double i, int e) {
    double m = absd(r) > absd(i) ? absd(r) : absd(i);
    if (!m) return (Extended){0, 0, 0, 0};
    union { double f; uint64_t u; } bits = {.f = m};
    int shift = (int)((bits.u >> 52) & 2047) - 1022;
    if (shift == -1022) { r *= 0x1p512; i *= 0x1p512; e -= 512; return ext(r, i, e); }
    double s = power_two(-shift);
    return (Extended){r*s, i*s, e+shift, 0};
}
static inline Extended add_ext(Extended a, Extended b) {
    if (!a.r && !a.i) return b;
    if (!b.r && !b.i) return a;
    if (a.e < b.e) { Extended t = a; a = b; b = t; }
    int difference = b.e - a.e;
    if (difference < -56) return a;
    double s = power_two(difference);
    return ext(a.r+b.r*s, a.i+b.i*s, a.e);
}
static inline Extended mul_ext(Extended a, Extended b) {
    return ext(a.r*b.r-a.i*b.i, a.r*b.i+a.i*b.r, a.e+b.e);
}
static inline __attribute__((always_inline)) Extended perturb_mul_ext(Extended a,Extended b){
#if defined(__wasm_simd128__)
    if(deep_options&DEEP_SIMD){
        v128_t av=wasm_f64x2_make(a.r,a.i);
        v128_t direct=wasm_f64x2_mul(av,wasm_f64x2_make(b.r,b.i));
        v128_t cross=wasm_f64x2_mul(av,wasm_f64x2_make(b.i,b.r));
        return ext(wasm_f64x2_extract_lane(direct,0)-wasm_f64x2_extract_lane(direct,1),
            wasm_f64x2_extract_lane(cross,0)+wasm_f64x2_extract_lane(cross,1),a.e+b.e);
    }
#endif
    return mul_ext(a,b);
}
static inline int normal_component(double x){return !x || absd(x)>=0x1p-400;}
/* A small, exactly equivalent rescaled fast path. Keep the two additions at
 * a common binary scale and normalize once. Guards rule out both discarded
 * terms and underflow; powers of two commute exactly with the rounded adds.
 * Cancellation or a wide exponent range uses the original Extended path. */
static inline Extended add_three_ext(Extended a,Extended b,Extended c){
    if(deep_options&DEEP_RESCALED){
        if(a.e<b.e){Extended swap=a;a=b;b=swap;}
        int db=b.e-a.e,dc=c.e-a.e;
        if(db>=-32 && dc>=-32 && dc<=-4 &&
           normal_component(a.r) && normal_component(a.i) &&
           normal_component(b.r) && normal_component(b.i) &&
           normal_component(c.r) && normal_component(c.i)){
            double bs=power_two(db),cs=power_two(dc);
            double r=a.r+b.r*bs,i=a.i+b.i*bs;
            double maximum=absd(r)>absd(i)?absd(r):absd(i);
            if(maximum>=0.25 && maximum<=2.0)return ext(r+c.r*cs,i+c.i*cs,a.e);
        }
    }
    return add_ext(add_ext(a,b),c);
}
static inline Extended scale_ext(Extended a, double s) { return ext(a.r*s,a.i*s,a.e); }
/* For canonical Extended values, the replacements below preserve the old
 * rounded result: complex values are only doubled, while negative shifts
 * apply only to real norms/bounds. General complex downscaling could lose a
 * subnormal secondary component before scale_ext normalizes it again, so it
 * must not use this equivalence. Keep canonical zero unchanged. */
static inline Extended shift_ext(Extended a, int shift) {
    if (a.r || a.i) a.e += shift;
    return a;
}
static inline Extended norm_ext(Extended a) { return ext(__builtin_sqrt(a.r*a.r+a.i*a.i)*(1+0x1p-50),0,a.e); }
static inline int less_ext(Extended a, Extended b) {
    if (!a.r) return b.r > 0;
    if (!b.r) return 0;
    return a.e < b.e || (a.e == b.e && a.r < b.r);
}
static inline Extended subtract_positive(Extended a, Extended b) {
    if (!less_ext(b,a)) return (Extended){0};
    b.r = -b.r; return add_ext(a,b);
}
static inline Extended divide_positive(Extended a, Extended b) {
    return b.r ? ext(a.r/b.r,0,a.e-b.e) : (Extended){0};
}
static inline double normal_double(Extended a) { return a.r * power_two(a.e); }

static int reserve_arena(size_t bytes) {
    if (bytes <= arena_capacity) return 1;
#if defined(__wasm__)
    if (!arena) arena = (unsigned char *)(uintptr_t)(__builtin_wasm_memory_size(0)*65536u);
    if ((uint64_t)(uintptr_t)arena+bytes > UINT32_MAX-65535u) return 0;
    size_t pages = (bytes-arena_capacity+65535u)/65536u;
    if (__builtin_wasm_memory_grow(0,pages) == (size_t)-1) return 0;
    arena_capacity += pages*65536u;
#else
    unsigned char *next = realloc(arena,bytes);
    if (!next) return 0;
    arena = next; arena_capacity = bytes;
#endif
    return 1;
}
static uint64_t approximation_count(unsigned iterations){uint64_t count=0;for(unsigned n=iterations/16;n;n/=2)count+=n;return count;}
static uint64_t payload_bytes(unsigned iterations){
    return sizeof(DeepHeader)+(uint64_t)(iterations+1)*2*sizeof(Extended)+approximation_count(iterations)*sizeof(Approximation)+
        2*sizeof(double)+(uint64_t)(iterations+1)*4*sizeof(double);
}
static void map_arena(size_t data,unsigned iterations){
    deep_header=(DeepHeader *)arena;
    orbit=(Extended *)(arena+sizeof(DeepHeader));
    bailout_margin=orbit+iterations+1;
    approximations=(Approximation *)(bailout_margin+iterations+1);
    orbit_dd_error=(double *)(approximations+approximation_count(iterations));
    orbit_dd=orbit_dd_error+2;
    cr_big=(uint32_t *)(arena+data);ci_big=cr_big+digits;
    xr_big=ci_big+digits;xi_big=xr_big+digits;
    for(unsigned k=0;k<8;++k)scratch[k]=xi_big+(k+1)*digits;
    product=scratch[7]+digits;
    checkpoint_real=product+2*digits;checkpoint_imag=checkpoint_real+digits;
    frame_real=checkpoint_imag+digits;frame_imag=frame_real+digits;
}
unsigned deep_allocate(unsigned bits, unsigned iterations) {
    if (bits < 64 || bits > INT32_MAX-64 || !iterations || iterations > INT32_MAX-64) return 0;
    prefix_dd_active=prefix_dd_used=0;orbit_double_ready=0;
    fraction = (bits+31)/32; digits = fraction+1; reference_limit = iterations;
    uint64_t data64 = payload_bytes(iterations);
    uint64_t needed64 = data64+(uint64_t)digits*18*sizeof(uint32_t);
    if (needed64 > UINT32_MAX-65536u || !reserve_arena((size_t)needed64)) return 0;
    size_t data=(size_t)data64;
    map_arena(data,iterations);deep_header->count=deep_header->levels=0;tile_active=0;
    orbit_dd_error[0]=__builtin_inf();orbit_dd_error[1]=0;
    unsigned offset=0;
    for (unsigned n=iterations/16; n; n/=2) {
        unsigned level=deep_header->levels++;
        deep_header->offset[level]=offset; deep_header->length[level]=n; offset+=n;
    }
    return 1;
}
unsigned deep_input_address(void) { return (unsigned)(uintptr_t)cr_big; }
unsigned deep_digits(void) { return digits; }
unsigned deep_data_address(void) { return (unsigned)(uintptr_t)arena; }
unsigned deep_data_size(void) { return (unsigned)payload_bytes(reference_limit); }
/* The reference payload is independent of limb precision. Grow only the limb
 * workspace, moving its 18 blocks backwards in place and appending exact zero
 * fraction limbs. This preserves the reference, original centre and tile output
 * without another reference-sized buffer, including after native realloc. */
unsigned deep_grow_precision(unsigned bits){
    if(!arena || bits<64 || bits>INT32_MAX-64)return 0;
    unsigned next_fraction=(bits+31)/32,next_digits=next_fraction+1;
    if(next_digits<=digits){precision_needed=0;return 1;}
    size_t data=deep_data_size();
    uint64_t needed=(uint64_t)data+(uint64_t)next_digits*18*sizeof(uint32_t);
    if(needed>UINT32_MAX-65536u || !reserve_arena((size_t)needed))return 0;
    uint32_t *limbs=(uint32_t *)(arena+data);
    unsigned extra=next_digits-digits;
    for(unsigned block=18;block--;){
        for(unsigned j=digits;j--;)limbs[block*next_digits+j+extra]=limbs[block*digits+j];
        for(unsigned j=0;j<extra;++j)limbs[block*next_digits+j]=0;
    }
    fraction=next_fraction;digits=next_digits;map_arena(data,reference_limit);orbit_double_ready=0;
    /* Preserve a completed prefix for reuse/resume, but never continue an
       in-flight construction across a change in the fixed-point grid. */
    prefix_dd_active=0;
    precision_needed=0;return 1;
}
static void clear_big(uint32_t *a) { for(unsigned j=0;j<digits;++j)a[j]=0; }
static void copy_big(uint32_t *a,const uint32_t *b) { for(unsigned j=0;j<digits;++j)a[j]=b[j]; }
static int compare_big(const uint32_t *a,const uint32_t *b) {
    for(unsigned j=digits;j--;)if(a[j]!=b[j])return a[j]>b[j]?1:-1;
    return 0;
}
static int sum_big(uint32_t *out,const uint32_t *a,int sa,const uint32_t *b,int sb) {
    if(sa==sb){uint64_t carry=0;for(unsigned j=0;j<digits;++j){carry+=(uint64_t)a[j]+b[j];out[j]=(uint32_t)carry;carry>>=32;}return sa;}
    if(compare_big(a,b)<0){const uint32_t *t=a;a=b;b=t;sa=sb;}
    uint64_t borrow=0;
    for(unsigned j=0;j<digits;++j){uint64_t av=a[j],bv=(uint64_t)b[j]+borrow;out[j]=(uint32_t)(av-bv);borrow=av<bv;}
    return sa;
}
/* Column-wise schoolbook products. Column k sums the exact 64-bit partial
 * products a[i]*b[k-i] as separate low and high 32-bit halves, each below
 * n*2^32, so the additions are independent instead of one serial carry chain.
 * With carry-in c: t=low+c, limb=t mod 2^32, next c=high+floor(t/2^32).
 * By induction c<(k+2)*2^32 entering column k, so t<2^64 for n<2^29.
 * Integer arithmetic is exact: the limbs equal the row-wise schoolbook ones. */
static inline uint64_t column_product(const uint32_t *restrict a,const uint32_t *restrict b,unsigned n,unsigned k,uint64_t carry,uint32_t *limb){
    unsigned first=k+1>n?k+1-n:0,last=k<n?k:n-1;
    uint64_t low=0,high=0;
    for(unsigned i=first;i<=last;++i){uint64_t value=(uint64_t)a[i]*b[k-i];low+=(uint32_t)value;high+=value>>32;}
    uint64_t t=low+carry;*limb=(uint32_t)t;return high+(t>>32);
}
static inline uint64_t column_square(const uint32_t *restrict a,unsigned n,unsigned k,uint64_t carry,uint32_t *limb){
    unsigned first=k+1>n?k+1-n:0;
    uint64_t low=0,high=0;
    for(unsigned i=first;2*i<k;++i){uint64_t value=(uint64_t)a[i]*a[k-i];low+=(uint32_t)value;high+=value>>32;}
    low*=2;high*=2;
    if(!(k&1)){uint64_t value=(uint64_t)a[k/2]*a[k/2];low+=(uint32_t)value;high+=value>>32;}
    uint64_t t=low+carry;*limb=(uint32_t)t;return high+(t>>32);
}
static void multiply_school(uint32_t *restrict out,const uint32_t *restrict a,const uint32_t *restrict b,unsigned n){
    uint64_t carry=0;
    for(unsigned k=0;k+1<2*n;++k)carry=column_product(a,b,n,k,carry,out+k);
    out[2*n-1]=(uint32_t)carry;
}
/* Upper limbs only, from column s=fraction-2 on. The ignored lower columns
 * contribute a carry C<(s+2)*2^32 into column s (bound above), which can
 * reach the kept limbs only through the two guard limbs out[s], out[s+1].
 * If their 64-bit value plus (s+2)*2^32 cannot overflow, every limb from
 * fraction on is exact; otherwise (probability about n*2^-32) the caller
 * computes the full product. */
static int multiply_short(uint32_t *restrict out,const uint32_t *restrict a,const uint32_t *restrict b,unsigned n,unsigned s){
    uint64_t carry=0;
    for(unsigned k=s;k+1<2*n;++k)carry=column_product(a,b,n,k,carry,out+k);
    out[2*n-1]=(uint32_t)carry;
    uint64_t guard=(uint64_t)out[s]|(uint64_t)out[s+1]<<32;
    return !s || guard<=UINT64_MAX-((uint64_t)(s+2)<<32);
}
static int square_short(uint32_t *restrict out,const uint32_t *restrict a,unsigned n,unsigned s){
    uint64_t carry=0;
    for(unsigned k=s;k+1<2*n;++k)carry=column_square(a,n,k,carry,out+k);
    out[2*n-1]=(uint32_t)carry;
    uint64_t guard=(uint64_t)out[s]|(uint64_t)out[s+1]<<32;
    return !s || guard<=UINT64_MAX-((uint64_t)(s+2)<<32);
}
/* The low 32*fraction bits of a*b vanish iff ctz(a)+ctz(b)>=32*fraction,
 * because a*b=2^(ctz a+ctz b)*odd*odd. This equals scanning those limbs. */
static inline unsigned limb_ctz(const uint32_t *a,unsigned n){
    for(unsigned j=0;j<n;++j)if(a[j])return 32*j+(unsigned)__builtin_ctz(a[j]);
    return UINT32_MAX;
}
static inline int product_rounded(const uint32_t *a,const uint32_t *b){
    unsigned x=limb_ctz(a,digits),y=limb_ctz(b,digits);
    return x!=UINT32_MAX && y!=UINT32_MAX && (uint64_t)x+y<32*(uint64_t)fraction;
}
/* Accumulate each off-diagonal product once, double the complete result, then
 * add the diagonal. All carries use at most 64 bits; unlike doubling a single
 * 32x32 product this never needs an overflowing 65-bit temporary. */
/* Off-diagonal halves are doubled before the diagonal is added: both sums
 * stay below 2n*2^32, and the column recurrence above applies unchanged. */
static void square_school(uint32_t *restrict out,const uint32_t *restrict a,unsigned n){
    uint64_t carry=0;
    for(unsigned k=0;k+1<2*n;++k)carry=column_square(a,n,k,carry,out+k);
    out[2*n-1]=(uint32_t)carry;
}
#ifndef KARATSUBA_MULTIPLY_MIN
#define KARATSUBA_MULTIPLY_MIN 32
#endif
#ifndef KARATSUBA_SQUARE_MIN
#define KARATSUBA_SQUARE_MIN 48
#endif
/* Exact Karatsuba recombination shared by products and squares. With
 * l=floor(n/2), h=n-l, the low halves give z0 (2l limbs at out), the high halves
 * z2 (2h limbs at out+2l), and work[0..2h) holds the magnitude p of the
 * difference product. The cross term z0+z2+sign*p is exact and nonnegative;
 * add it at limb l. Every value stays an exact integer, so the final 2n-limb
 * result, its truncation and the rounded flag equal the schoolbook ones. */
static void karatsuba_combine(uint32_t *out,uint32_t *work,unsigned n,int subtract){
    unsigned l=n/2,h=n-l;
    int64_t carry=0;
    for(unsigned j=0;j<2*h;++j){
        int64_t value=(int64_t)(j<2*l?out[j]:0)+out[2*l+j]+(subtract?-(int64_t)work[j]:(int64_t)work[j])+carry;
        work[j]=(uint32_t)value;carry=value<0?-1:value>>32;
    }
    uint64_t addition=0;
    for(unsigned j=0;j<2*h;++j){uint64_t value=(uint64_t)out[l+j]+work[j]+addition;out[l+j]=(uint32_t)value;addition=value>>32;}
    addition+=(uint64_t)carry;
    for(unsigned j=l+2*h;addition && j<2*n;++j){addition+=out[j];out[j]=(uint32_t)addition;addition>>=32;}
}
/* Measured V8/WASM crossovers: products gain from 32 limbs (24 is no faster),
 * while the cheaper schoolbook square still wins below about 48 limbs.
 * Workspace: 2h limbs for the difference product plus the recursion's own.
 * deep-check proves this is at most 2n for every n up to the limit below;
 * larger, impractical precisions keep the schoolbook products. */
#define KARATSUBA_MAX_LIMBS (1u<<20)
static void multiply_words(uint32_t *out,const uint32_t *a,const uint32_t *b,unsigned n,uint32_t *work){
    if(n<KARATSUBA_MULTIPLY_MIN){multiply_school(out,a,b,n);return;}
    unsigned l=n/2,h=n-l;
    /* da=|a1-a0|, db=|b0-b1| with the low halves zero-extended to h limbs. */
    int as=1,bs=1;
    for(unsigned j=h;j--;){uint32_t low=j<l?a[j]:0;if(a[l+j]!=low){as=a[l+j]>low?1:-1;break;}}
    for(unsigned j=h;j--;){uint32_t low=j<l?b[j]:0;if(low!=b[l+j]){bs=low>b[l+j]?1:-1;break;}}
    uint64_t borrow_a=0,borrow_b=0;
    for(unsigned j=0;j<h;++j){
        uint64_t low=j<l?a[j]:0,high=a[l+j];
        uint64_t av=as>0?high:low,bv=(as>0?low:high)+borrow_a;
        work[j]=(uint32_t)(av-bv);borrow_a=av<bv;
        low=j<l?b[j]:0;high=b[l+j];
        av=bs>0?low:high;bv=(bs>0?high:low)+borrow_b;
        work[h+j]=(uint32_t)(av-bv);borrow_b=av<bv;
    }
    /* The difference product temporarily uses the start of the output. */
    multiply_words(out,work,work+h,h,work+2*h);
    for(unsigned j=0;j<2*h;++j)work[j]=out[j];
    multiply_words(out,a,b,l,work+2*h);
    multiply_words(out+2*l,a+l,b+l,h,work+2*h);
    karatsuba_combine(out,work,n,as!=bs);
}
static void square_words(uint32_t *out,const uint32_t *a,unsigned n,uint32_t *work){
    if(n<KARATSUBA_SQUARE_MIN){square_school(out,a,n);return;}
    unsigned l=n/2,h=n-l;
    int as=1;
    for(unsigned j=h;j--;){uint32_t low=j<l?a[j]:0;if(a[l+j]!=low){as=a[l+j]>low?1:-1;break;}}
    uint64_t borrow=0;
    for(unsigned j=0;j<h;++j){
        uint64_t low=j<l?a[j]:0,high=a[l+j];
        uint64_t av=as>0?high:low,bv=(as>0?low:high)+borrow;
        work[j]=(uint32_t)(av-bv);borrow=av<bv;
    }
    square_words(out,work,h,work+h);
    for(unsigned j=0;j<2*h;++j)work[j]=out[j];
    square_words(out,a,l,work+2*h);
    square_words(out+2*l,a+l,h,work+2*h);
    karatsuba_combine(out,work,n,1);
}
/* scratch[4:6] is dead during orbit multiplication and squaring: fixed_pixel
   has already copied its coordinate into scratch[6] and scratch[7]. */
static void multiply_big(uint32_t *out,const uint32_t *a,const uint32_t *b) {
    if((deep_options&DEEP_KARATSUBA) && digits>=KARATSUBA_MULTIPLY_MIN && digits<=KARATSUBA_MAX_LIMBS)multiply_words(product,a,b,digits,scratch[4]);
    else if(!multiply_short(product,a,b,digits,fraction>2?fraction-2:0))multiply_school(product,a,b,digits);
    for(unsigned j=0;j<digits;++j)out[j]=product[j+fraction];
    if(product_rounded(a,b))rounded_product=1;
}
static void square_big(uint32_t *out,const uint32_t *a){
    if(!(deep_options&DEEP_SQUARE)){multiply_big(out,a,a);return;}
    if((deep_options&DEEP_KARATSUBA) && digits>=KARATSUBA_SQUARE_MIN && digits<=KARATSUBA_MAX_LIMBS)square_words(product,a,digits,scratch[4]);
    else if(!square_short(product,a,digits,fraction>2?fraction-2:0))square_school(product,a,digits);
    for(unsigned j=0;j<digits;++j)out[j]=product[j+fraction];
    if(product_rounded(a,a))rounded_product=1;
}
static Extended big_extended(const uint32_t *a,int sign) {
    unsigned j=digits;while(j && !a[j-1])--j;
    if(!j)return (Extended){0};
    /* A leading limb can contain only one significant bit. Two limbs would
       then retain just 33 bits and turn 2 - tiny into 2 - 2^-32, which can
       invalidate a local reference's bailout margin. Three limbs retain the
       full double mantissa even in that case; the remaining rounding stays
       below the existing conservative perturbation bounds. */
    double value=a[j-1];if(j>1)value+=a[j-2]*0x1p-32;
    if(j>2)value+=a[j-3]*0x1p-64;
    return ext(sign*value,0,32*((int)j-1-(int)fraction));
}
static Extended current_big(void) {
    Extended a=big_extended(xr_big,xr_sign),b=big_extended(xi_big,xi_sign);b.i=b.r;b.r=0;return add_ext(a,b);
}
static void big_from_extended(uint32_t *a, Extended value) {
    clear_big(a);double v=absd(value.r);
    for(unsigned j=digits;j--;){
        int shift=value.e+32*((int)fraction-(int)j);
        double part=shift>1023?__builtin_inf():v*power_two(shift);
        if(part>=1 && part<4294967296.0){a[j]=(uint32_t)part;v-=a[j]*power_two(-shift);}
    }
}
static void pixel_offset_big(uint32_t *a,double offset){
    /* Pixel and tile-centre offsets are half integers. Multiplying the exact
       binary spacing in limbs avoids rounding a distant reference centre to
       a double before subsequent small pixel offsets are added. */
    big_from_extended(a,spacing_extended);
    uint32_t twice=(uint32_t)(2*absd(offset));uint64_t carry=0;
    for(unsigned j=0;j<digits;++j){uint64_t value=(uint64_t)a[j]*twice+carry;a[j]=(uint32_t)value;carry=value>>32;}
    uint32_t bit=0;
    for(unsigned j=digits;j--;){uint32_t next=a[j]&1;a[j]=(a[j]>>1)|(bit<<31);bit=next;}
}
static void orbit_step(const uint32_t *real,int sr,const uint32_t *imag,int si) {
    square_big(scratch[0],xr_big);square_big(scratch[1],xi_big);
    int nr=sum_big(scratch[2],scratch[0],1,scratch[1],-1);
    multiply_big(scratch[3],xr_big,xi_big);
    uint32_t carry=0;for(unsigned j=0;j<digits;++j){uint32_t next=scratch[3][j]>>31;scratch[3][j]=(scratch[3][j]<<1)|carry;carry=next;}
    nr=sum_big(scratch[0],scratch[2],nr,real,sr);
    int ni=sum_big(scratch[1],scratch[3],xr_sign*xi_sign,imag,si);
    copy_big(xr_big,scratch[0]);copy_big(xi_big,scratch[1]);xr_sign=nr;xi_sign=ni;
}
static double escape_magnitude(Extended z) {
    if(z.e>4)return 256;
    if(z.e < -500)return 0;
    return (z.r*z.r+z.i*z.i)*power_two(2*z.e);
}
static Extended precise_margin(void) {
    square_big(scratch[0],xr_big);square_big(scratch[1],xi_big);
    sum_big(scratch[2],scratch[0],1,scratch[1],1);
    clear_big(scratch[3]);scratch[3][fraction]=4;
    int sign=sum_big(scratch[0],scratch[2],1,scratch[3],-1);
    return big_extended(scratch[0],sign);
}
unsigned deep_begin(int real_sign,int imag_sign,double spacing,int exponent,unsigned width,unsigned height) {
    prefix_dd_active=prefix_dd_used=0;orbit_double_ready=0;
    cr_sign=real_sign;ci_sign=imag_sign;xr_sign=xi_sign=1;
    clear_big(xr_big);clear_big(xi_big);orbit[0]=(Extended){0};reference_iteration=0;
    reference_error=(Extended){0};precision_needed=0;
    for(unsigned k=0;k<4;++k)orbit_dd[k]=0;
    orbit_dd_error[0]=reference_dd_enabled?0:__builtin_inf();
    bailout_margin[0]=ext(-4,0,0);
    clear_big(checkpoint_real);clear_big(checkpoint_imag);checkpoint_iteration=0;checkpoint_rs=checkpoint_is=1;
    spacing_extended=ext(spacing,0,exponent);
    image_radius=scale_ext(spacing_extended,0.5*(width+height)+2);
    /* A real c in [-2,1/4] has a real orbit that stays in [-2,2] forever and
     * near c=-2 doubles rounding errors each step: holding the reference error
     * below 2^-64|Z| through the whole limit would need about one bit per
     * iteration (measured: 290+ attempts, 10 000 bits, no result after 60 s).
     * Pixels follow a reference only while |delta|<=|z|. With D=|dZ/dc|, any
     * offset |dc|>=spacing/2 leaves that regime long before D*spacing>2^64,
     * and a rebase after the last sample is always valid. So such a reference
     * stops there. The rule depends on the stored samples only, not on the
     * precision, so two precisions still yield the same count. A pixel exactly
     * at the centre is real itself and decided by real_axis_interior. */
    reference_truncated=0;reference_real_bounded=0;
    int imaginary_zero=1;for(unsigned j=0;j<digits;++j)if(ci_big[j]){imaginary_zero=0;break;}
    if(imaginary_zero){
        clear_big(scratch[4]);
        if(cr_sign<0)scratch[4][fraction]=2;else scratch[4][fraction-1]=0x40000000u;
        reference_real_bounded=compare_big(cr_big,scratch[4])<=0;
        reference_derivative=(Extended){0};reference_cutoff=ext(1,0,64-spacing_extended.e);
    }
    return 1;
}
typedef struct { double hi, lo; } DoubleDouble;
static DoubleDouble big_dd(const uint32_t *a,int sign);
/* Store the fixed-point state as double-doubles (error <32u^2|F|, u=2^-53)
 * and keep an outward bound on max reference_error/|Z| for the DD perturbation. */
static void reference_dd_sample(unsigned j,Extended z){
    DoubleDouble r=big_dd(xr_big,xr_sign),i=big_dd(xi_big,xi_sign);
    orbit_dd[4*j]=r.hi;orbit_dd[4*j+1]=r.lo;orbit_dd[4*j+2]=i.hi;orbit_dd[4*j+3]=i.lo;
    if(!reference_error.r)return;
    double ratio=__builtin_inf();
    if(z.r || z.i){
        Extended lower=ext(__builtin_sqrt(z.r*z.r+z.i*z.i)*(1-0x1p-50),0,z.e);
        Extended q=divide_positive(reference_error,lower);
        ratio=q.e< -1000?0x1p-1000:analytic_up(normal_double(q)*(1+0x1p-50));
    }
    if(!(ratio<=orbit_dd_error[0]))orbit_dd_error[0]=ratio;
}
unsigned deep_reference(unsigned batch) {
    unsigned computed=0;
    unsigned end=reference_iteration+batch;
    if(end<reference_iteration || end>reference_limit)end=reference_limit;
    while(reference_iteration<end){
        Extended previous_norm=norm_ext(orbit[reference_iteration]);rounded_product=0;
        if(reference_real_bounded){
            reference_derivative=add_ext(mul_ext(shift_ext(previous_norm,1),reference_derivative),ext(1,0,0));
            if(!less_ext(reference_derivative,reference_cutoff)){reference_truncated=1;break;}
        }
        if(prefix_dd_active)prefix_dd_before();
        orbit_step(cr_big,cr_sign,ci_big,ci_sign);++computed;
        Extended z=current_big();orbit[++reference_iteration]=z;
        if(prefix_dd_active)prefix_dd_after();
        reference_error=mul_ext(add_ext(scale_ext(previous_norm,2),reference_error),reference_error);
        if(rounded_product)reference_error=add_ext(reference_error,ext(4,0,-32*(int)fraction));
        if(reference_error.r && !less_ext(reference_error,mul_ext(norm_ext(z),ext(1,0,-64)))){
            precision_needed=1;break;
        }
        if(reference_dd_enabled)reference_dd_sample(reference_iteration,z);
        double magnitude=escape_magnitude(z);
        bailout_margin[reference_iteration]=absd(magnitude-4)<1e-10?precise_margin():ext(magnitude-4,0,0);
        if(bailout_margin[reference_iteration].r>0)break;
        if(!(reference_iteration%16)){
            if(!reference_error.r && xr_sign==checkpoint_rs && xi_sign==checkpoint_is && !compare_big(xr_big,checkpoint_real) && !compare_big(xi_big,checkpoint_imag)){
                unsigned period=reference_iteration-checkpoint_iteration;
                for(unsigned j=reference_iteration+1;j<=reference_limit;++j){
                    unsigned source=checkpoint_iteration+(j-checkpoint_iteration)%period;
                    orbit[j]=orbit[source];bailout_margin[j]=bailout_margin[source];
                    if(reference_dd_enabled)for(unsigned k=0;k<4;++k)orbit_dd[4*j+k]=orbit_dd[4*source+k];
                }
                reference_iteration=reference_limit;break;
            }
            copy_big(checkpoint_real,xr_big);copy_big(checkpoint_imag,xi_big);
            checkpoint_iteration=reference_iteration;checkpoint_rs=xr_sign;checkpoint_is=xi_sign;
        }
    }
    deep_header->count=reference_iteration;
    deep_reference_iterations+=computed;
    return precision_needed || reference_truncated || reference_iteration==reference_limit || bailout_margin[reference_iteration].r>0;
}
unsigned deep_needs_precision(void){return precision_needed;}
static Approximation single_bla(unsigned n) {
    Extended a=scale_ext(orbit[n],2),radius=norm_ext(a);radius.e-=40;
    if(!radius.r)return (Approximation){0};
    Extended z=orbit[n+1];
    double gap=2-__builtin_sqrt(escape_magnitude(z));
    if(gap<=0 || !less_ext(image_radius,ext(gap*0.25,0,0)))return (Approximation){0};
    Extended safe=divide_positive(ext(gap*0.25,0,0),add_ext(norm_ext(a),ext(1,0,0)));
    if(less_ext(safe,radius))radius=safe;
    if(!radius.r)return (Approximation){0};
    return (Approximation){a,ext(1,0,0),ext(1,0,0),radius,1,0};
}
static Approximation merge_bla(Approximation x,Approximation y) {
    /* A zero radius cannot satisfy perturb_pixel's strict radius test, nor
     * can any enclosing block restore it. Keep rejected blocks canonical. */
    if(!x.steps || !y.steps || !x.radius.r || !y.radius.r)return (Approximation){0};
    Extended ax=norm_ext(x.a),bx=norm_ext(x.b);
    Extended constant=add_ext(mul_ext(bx,image_radius),mul_ext(x.q,mul_ext(image_radius,image_radius)));
    Extended remaining=subtract_positive(y.radius,constant);
    if(!remaining.r)return (Approximation){0};
    Extended denominator=add_ext(ax,mul_ext(x.q,add_ext(scale_ext(image_radius,2),x.radius)));
    Extended radius=divide_positive(remaining,denominator);
    if(less_ext(x.radius,radius))radius=x.radius;
    if(!radius.r)return (Approximation){0};
    Extended k=add_ext(add_ext(ax,bx),add_ext(ext(1,0,0),mul_ext(x.q,add_ext(radius,image_radius))));
    Extended q=add_ext(mul_ext(norm_ext(y.a),x.q),mul_ext(y.q,mul_ext(k,k)));
    return (Approximation){mul_ext(y.a,x.a),add_ext(mul_ext(y.a,x.b),y.b),q,radius,x.steps+y.steps,0};
}
unsigned deep_finish(void) {
    unsigned count=deep_header->count;
    unsigned first=(deep_options&DEEP_BLA_ONE)?1:0;
    if(!deep_header->levels)return count;
    for(unsigned j=0;j<deep_header->length[0];++j){
        Approximation b={0};
        if(first+j*16+16<=count){
            b=single_bla(first+j*16);
            for(unsigned k=1;k<16 && b.steps;++k)b=merge_bla(b,single_bla(first+j*16+k));
        }
        approximations[j]=b;
    }
    for(unsigned l=1;l<deep_header->levels;++l)for(unsigned j=0;j<deep_header->length[l];++j){
        Approximation a=approximations[deep_header->offset[l-1]+j*2],b=approximations[deep_header->offset[l-1]+j*2+1];
        approximations[deep_header->offset[l]+j]=(a.steps && b.steps)?merge_bla(a,b):(Approximation){0};
    }
    return count;
}
/* Compensated 106-bit arithmetic is faster than limb multiplication in the
 * intermediate range. A propagated rounding bound sends uncertain pixels to
 * the full fixed-point path. No fused/fast-math operations are required. */
static DoubleDouble dd_real, dd_imag;
static inline DoubleDouble dd_normal(double hi,double lo){double sum=hi+lo;return (DoubleDouble){sum,lo-(sum-hi)};}
static inline DoubleDouble dd_add(DoubleDouble a,DoubleDouble b){
    double sum=a.hi+b.hi,v=sum-a.hi;
    return dd_normal(sum,((a.hi-(sum-v))+(b.hi-v))+a.lo+b.lo);
}
static inline DoubleDouble dd_negative(DoubleDouble a){return (DoubleDouble){-a.hi,-a.lo};}
static inline DoubleDouble dd_multiply(DoubleDouble a,DoubleDouble b){
    double p=a.hi*b.hi,ac=134217729.0*a.hi,bc=134217729.0*b.hi;
    double ah=ac-(ac-a.hi),al=a.hi-ah,bh=bc-(bc-b.hi),bl=b.hi-bh;
    double error=((ah*bh-p)+ah*bl+al*bh)+al*bl;
    return dd_normal(p,error+a.hi*b.lo+a.lo*b.hi+a.lo*b.lo);
}
static DoubleDouble big_dd(const uint32_t *a,int sign){
    double hi=normal_double(big_extended(a,sign));big_from_extended(scratch[4],ext(hi,0,0));
    int residual=sum_big(scratch[5],a,sign,scratch[4],hi<0?1:-1);
    return (DoubleDouble){hi,normal_double(big_extended(scratch[5],residual))};
}
static inline uint32_t dd_result(uint32_t pixel,unsigned iterations){deep_dd_iterations+=iterations;return pixel;}
static inline __attribute__((always_inline)) uint32_t dd_pixel_impl(Extended dc,int *certain,int cache){
    DoubleDouble cr=dd_add(dd_real,(DoubleDouble){dc.r*power_two(dc.e),0});
    DoubleDouble ci=dd_add(dd_imag,(DoubleDouble){dc.i*power_two(dc.e),0});
    DoubleDouble x={0},y={0},cached_xx={0},cached_yy={0};double error=0,norm=0;
    for(unsigned n=1;n<=limit;++n){
        DoubleDouble xx=cache?cached_xx:dd_multiply(x,x),yy=cache?cached_yy:dd_multiply(y,y),xy=dd_multiply(x,y);
        error=(2*norm+error)*error+0x1p-96*(xx.hi+yy.hi+absd(cr.hi)+absd(ci.hi));
        /* xy is a normalized Fast2Sum result, so dd_add(xy,xy) is exactly
           both components doubled (signed zeros aside, which never reach
           a comparison or colour). */
        x=dd_add(dd_add(xx,dd_negative(yy)),cr);y=dd_add((DoubleDouble){2*xy.hi,2*xy.lo},ci);
        cached_xx=dd_multiply(x,x);cached_yy=dd_multiply(y,y);
        DoubleDouble mag=dd_add(cached_xx,cached_yy);
        norm=__builtin_sqrt(x.hi*x.hi+y.hi*y.hi);
        if(error>0x1p-32*(norm+0x1p-100)){*certain=0;return dd_result(0,n);}
        DoubleDouble margin=dd_add(mag,(DoubleDouble){-4,0});
        if(absd(margin.hi)+absd(margin.lo)<=error*(2*norm+error) && (margin.hi||margin.lo||error)){
            *certain=0;return dd_result(0,n);
        }
        if(margin.hi>0 || (!margin.hi && margin.lo>0))return dd_result(colour(n,mag.hi+mag.lo),n);
    }
    return dd_result(UINT32_C(0xff000000),limit);
}
static uint32_t dd_pixel(Extended dc,int *certain){
    ++deep_dd_fallbacks;
    if(deep_options&DEEP_DD_CACHE)return dd_pixel_impl(dc,certain,1);
    return dd_pixel_impl(dc,certain,0);
}
/* Deferred precise pixels of the current tile (indices below 256*64). Phase 0
 * perturbs every pixel; phase 1 runs the fixed-point orbit for the pixels DD
 * could not certify, resumable after precision growth at pending_position. */
static uint16_t pending[MANDELBROT_TILE_PIXELS],perturb_queue[MANDELBROT_TILE_PIXELS];
static unsigned pending_count,pending_position,tile_phase,queue_count;
/* Interleaved DD fallback: four pixels in two pairs of f64x2 lanes. dd_pixel
 * is a single latency-bound chain; independent lanes fill the pipeline. Each
 * lane performs exactly the operation sequence of dd_pixel_impl with cached
 * squares (no contraction, same order, IEEE sqrt), so its result, escape
 * iteration and certainty are bit-identical to dd_pixel. A finished lane is
 * refilled with the next pending pixel; idle lanes iterate c=0, which never
 * leaves the loop. Native builds use the same code on a two-double struct. */
#if defined(__wasm_simd128__)
typedef v128_t DDVector;
#define dv_splat wasm_f64x2_splat
#define dv_add wasm_f64x2_add
#define dv_sub wasm_f64x2_sub
#define dv_neg wasm_f64x2_neg
#define dv_mul wasm_f64x2_mul
#define dv_sqrt wasm_f64x2_sqrt
#define dv_abs wasm_f64x2_abs
#define dv_gt wasm_f64x2_gt
#define dv_lt wasm_f64x2_lt
#define dv_not wasm_v128_not
#define dv_le wasm_f64x2_le
#define dv_eq wasm_f64x2_eq
#define dv_ne wasm_f64x2_ne
#define dv_and wasm_v128_and
#define dv_or wasm_v128_or
#define dv_any wasm_v128_any_true
static inline unsigned dv_bits(DDVector m){return wasm_i64x2_bitmask(m);}
static inline double dv_get(DDVector v,unsigned lane){return lane?wasm_f64x2_extract_lane(v,1):wasm_f64x2_extract_lane(v,0);}
static inline DDVector dv_set(DDVector v,unsigned lane,double x){return lane?wasm_f64x2_replace_lane(v,1,x):wasm_f64x2_replace_lane(v,0,x);}
#else
typedef struct{double v[2];} DDVector;
static inline DDVector dv_splat(double x){return (DDVector){{x,x}};}
#define DV_BINARY(name,op) static inline DDVector name(DDVector a,DDVector b){return (DDVector){{a.v[0] op b.v[0],a.v[1] op b.v[1]}};}
DV_BINARY(dv_add,+) DV_BINARY(dv_sub,-) DV_BINARY(dv_mul,*)
static inline DDVector dv_neg(DDVector a){return (DDVector){{-a.v[0],-a.v[1]}};}
static inline DDVector dv_sqrt(DDVector a){return (DDVector){{__builtin_sqrt(a.v[0]),__builtin_sqrt(a.v[1])}};}
static inline DDVector dv_abs(DDVector a){return (DDVector){{absd(a.v[0]),absd(a.v[1])}};}
static inline double dv_mask(int x){union{uint64_t u;double f;}m={.u=x?~UINT64_C(0):0};return m.f;}
static inline int dv_true(double x){union{double f;uint64_t u;}m={.f=x};return m.u!=0;}
#define DV_COMPARE(name,op) static inline DDVector name(DDVector a,DDVector b){return (DDVector){{dv_mask(a.v[0] op b.v[0]),dv_mask(a.v[1] op b.v[1])}};}
DV_COMPARE(dv_gt,>) DV_COMPARE(dv_le,<=) DV_COMPARE(dv_eq,==) DV_COMPARE(dv_ne,!=)
DV_COMPARE(dv_lt,<)
static inline DDVector dv_not(DDVector a){return (DDVector){{dv_mask(!dv_true(a.v[0])),dv_mask(!dv_true(a.v[1]))}};}
static inline DDVector dv_and(DDVector a,DDVector b){return (DDVector){{dv_mask(dv_true(a.v[0])&&dv_true(b.v[0])),dv_mask(dv_true(a.v[1])&&dv_true(b.v[1]))}};}
static inline DDVector dv_or(DDVector a,DDVector b){return (DDVector){{dv_mask(dv_true(a.v[0])||dv_true(b.v[0])),dv_mask(dv_true(a.v[1])||dv_true(b.v[1]))}};}
static inline int dv_any(DDVector m){return dv_true(m.v[0])||dv_true(m.v[1]);}
static inline unsigned dv_bits(DDVector m){return (unsigned)dv_true(m.v[0])|(unsigned)dv_true(m.v[1])<<1;}
static inline double dv_get(DDVector v,unsigned lane){return v.v[lane];}
static inline DDVector dv_set(DDVector v,unsigned lane,double x){v.v[lane]=x;return v;}
#endif
typedef struct{DDVector hi,lo;} DDLanes;
static inline DDLanes dl_normal(DDVector hi,DDVector lo){DDVector sum=dv_add(hi,lo);return (DDLanes){sum,dv_sub(lo,dv_sub(sum,hi))};}
static inline DDLanes dl_add(DDLanes a,DDLanes b){
    DDVector sum=dv_add(a.hi,b.hi),v=dv_sub(sum,a.hi);
    return dl_normal(sum,dv_add(dv_add(dv_add(dv_sub(a.hi,dv_sub(sum,v)),dv_sub(b.hi,v)),a.lo),b.lo));
}
static inline DDLanes dl_multiply(DDLanes a,DDLanes b){
    const DDVector split=dv_splat(134217729.0);
    DDVector p=dv_mul(a.hi,b.hi),ac=dv_mul(split,a.hi),bc=dv_mul(split,b.hi);
    DDVector ah=dv_sub(ac,dv_sub(ac,a.hi)),al=dv_sub(a.hi,ah),bh=dv_sub(bc,dv_sub(bc,b.hi)),bl=dv_sub(b.hi,bh);
    DDVector error=dv_add(dv_add(dv_add(dv_sub(dv_mul(ah,bh),p),dv_mul(ah,bl)),dv_mul(al,bh)),dv_mul(al,bl));
    return dl_normal(p,dv_add(dv_add(dv_add(error,dv_mul(a.hi,b.lo)),dv_mul(a.lo,b.hi)),dv_mul(a.lo,b.lo)));
}
typedef struct{DDLanes cr,ci,x,y,xx,yy;DDVector error,norm;} DDBatch;
/* One iteration of dd_pixel_impl for both lanes; returns the uncertain and
 * escaped masks and the magnitude needed for colouring. */
static inline __attribute__((always_inline)) void dd_batch_step(DDBatch *b,DDVector *uncertain,DDVector *escaped,DDLanes *mag){
    DDLanes xy=dl_multiply(b->x,b->y);
    b->error=dv_add(dv_mul(dv_add(dv_mul(dv_splat(2),b->norm),b->error),b->error),
        dv_mul(dv_splat(0x1p-96),dv_add(dv_add(dv_add(b->xx.hi,b->yy.hi),dv_abs(b->cr.hi)),dv_abs(b->ci.hi))));
    DDLanes negative={dv_neg(b->yy.hi),dv_neg(b->yy.lo)};
    b->x=dl_add(dl_add(b->xx,negative),b->cr);
    b->y=dl_add((DDLanes){dv_add(xy.hi,xy.hi),dv_add(xy.lo,xy.lo)},b->ci);
    b->xx=dl_multiply(b->x,b->x);b->yy=dl_multiply(b->y,b->y);
    *mag=dl_add(b->xx,b->yy);
    b->norm=dv_sqrt(dv_add(dv_mul(b->x.hi,b->x.hi),dv_mul(b->y.hi,b->y.hi)));
    DDVector tolerance=dv_mul(dv_splat(0x1p-32),dv_add(b->norm,dv_splat(0x1p-100)));
    DDLanes margin=dl_add(*mag,(DDLanes){dv_splat(-4),dv_splat(0)});
    DDVector zero=dv_splat(0);
    DDVector close=dv_le(dv_add(dv_abs(margin.hi),dv_abs(margin.lo)),dv_mul(b->error,dv_add(dv_mul(dv_splat(2),b->norm),b->error)));
    DDVector nonzero=dv_or(dv_or(dv_ne(margin.hi,zero),dv_ne(margin.lo,zero)),dv_ne(b->error,zero));
    *uncertain=dv_or(dv_gt(b->error,tolerance),dv_and(close,nonzero));
    *escaped=dv_or(dv_gt(margin.hi,zero),dv_and(dv_eq(margin.hi,zero),dv_gt(margin.lo,zero)));
}
static inline void dd_batch_load(DDBatch *b,unsigned half,Extended dc,int active){
    DoubleDouble cr={0},ci={0};
    if(active){cr=dd_add(dd_real,(DoubleDouble){dc.r*power_two(dc.e),0});ci=dd_add(dd_imag,(DoubleDouble){dc.i*power_two(dc.e),0});}
    b->cr.hi=dv_set(b->cr.hi,half,cr.hi);b->cr.lo=dv_set(b->cr.lo,half,cr.lo);
    b->ci.hi=dv_set(b->ci.hi,half,ci.hi);b->ci.lo=dv_set(b->ci.lo,half,ci.lo);
    DDLanes *state[4]={&b->x,&b->y,&b->xx,&b->yy};
    for(unsigned k=0;k<4;++k){state[k]->hi=dv_set(state[k]->hi,half,0);state[k]->lo=dv_set(state[k]->lo,half,0);}
    b->error=dv_set(b->error,half,0);b->norm=dv_set(b->norm,half,0);
}
static Extended pending_dc(unsigned index);
/* Resolve pending[0..count) with DD. Uncertain pixels are compacted to the
 * front, in order, for the fixed-point pass; returns their number. */
static unsigned dd_batch(uint16_t *pending,unsigned count){
    DDBatch batch[2];
    for(unsigned p=0;p<2;++p){
        DDVector z=dv_splat(0);
        batch[p]=(DDBatch){{z,z},{z,z},{z,z},{z,z},{z,z},{z,z},z,z};
    }
    uint64_t tick=0,start[4]={0};
    unsigned slot[4]={0},active=0,refill=15,next=0,uncertain_count=0;
    for(;;){
        for(unsigned lane=0;lane<4;++lane){
            if(!(refill&(1u<<lane)))continue;
            int available=next<count;
            if(available){slot[lane]=pending[next++];start[lane]=tick;active|=1u<<lane;++deep_dd_fallbacks;}
            else active&=~(1u<<lane);
            dd_batch_load(&batch[lane>>1],lane&1,available?pending_dc(slot[lane]):(Extended){0},available);
        }
        refill=0;
        if(!active)return uncertain_count;
        uint64_t end=UINT64_MAX;
        for(unsigned lane=0;lane<4;++lane)if((active&(1u<<lane)) && start[lane]+limit<end)end=start[lane]+limit;
        DDVector u0,u1,e0,e1;DDLanes m0,m1;
        do{
            dd_batch_step(&batch[0],&u0,&e0,&m0);
            dd_batch_step(&batch[1],&u1,&e1,&m1);
            ++tick;
        }while(!dv_any(dv_or(dv_or(u0,e0),dv_or(u1,e1))) && tick<end);
        unsigned uncertain=dv_bits(u0)|dv_bits(u1)<<2,escaped=dv_bits(e0)|dv_bits(e1)<<2;
        for(unsigned lane=0;lane<4;++lane){
            unsigned bit=1u<<lane;
            if(!(active&bit))continue;
            unsigned n=(unsigned)(tick-start[lane]);
            if(uncertain&bit){deep_dd_iterations+=n;pending[uncertain_count++]=(uint16_t)slot[lane];refill|=bit;}
            else if(escaped&bit){
                DDLanes *m=lane<2?&m0:&m1;
                deep_dd_iterations+=n;output[slot[lane]]=colour(n,dv_get(m->hi,lane&1)+dv_get(m->lo,lane&1));refill|=bit;
            }else if(n==limit){deep_dd_iterations+=n;output[slot[lane]]=UINT32_C(0xff000000);refill|=bit;}
        }
    }
}
unsigned deep_configure(unsigned width,unsigned height,double spacing,int exponent,unsigned iterations,int real_sign,int imag_sign) {
    if(!configure(width,height) || !iterations)return 0;
    prefix_dd_active=prefix_dd_used=0;
    limit=iterations;spacing_extended=ext(spacing,0,exponent);cr_sign=real_sign;ci_sign=imag_sign;
    /* Render workers receive only the reference payload, not the reference
       worker's globals. Reconstruct the requested footprint locally; cached
       tables built for a larger footprint remain conservative for this one. */
    image_radius=scale_ext(spacing_extended,0.5*(width+height)+2);
    centre_real=normal_double(big_extended(cr_big,cr_sign));
    centre_imag=normal_double(big_extended(ci_big,ci_sign));
    dd_real=big_dd(cr_big,cr_sign);dd_imag=big_dd(ci_big,ci_sign);
    copy_big(frame_real,cr_big);copy_big(frame_imag,ci_big);frame_rs=cr_sign;frame_is=ci_sign;
    frame_on_axis=1;for(unsigned j=0;j<digits;++j)if(frame_imag[j]){frame_on_axis=0;break;}
    deep_reset_stats();series_start=precision_needed=0;tile_active=0;tile_completed=0;
    reference_origin_x=half_width;reference_origin_y=half_height;
    reference_local=0;reference_ready=1;allow_reference=request_reference=0;return 1;
}
/* A degree-eight perturbation prefix shares the nonlinear early orbit across
 * a tile. The discarded polynomial tail and coefficient rounding are bounded
 * uniformly on |dc| <= image_radius. Stop before any possible skipped escape. */
static void prepare_series_legacy(void){
    Extended coefficients[8]={{0}},next[8],norms[8],bound={0};series_start=0;series_radius=image_radius;
    for(unsigned n=0;n<deep_header->count;++n){
        Extended sum={0},omitted={0};
        for(unsigned k=0;k<8;++k){norms[k]=norm_ext(coefficients[k]);sum=add_ext(sum,norms[k]);}
        for(unsigned j=0;j<8;++j)for(unsigned k=0;k<8;++k)if(j+k+2>8)
            omitted=add_ext(omitted,mul_ext((deep_options&DEEP_SERIES_NORMS)?norms[j]:norm_ext(coefficients[j]),
                (deep_options&DEEP_SERIES_NORMS)?norms[k]:norm_ext(coefficients[k])));
        Extended linear=scale_ext(norm_ext(orbit[n]),2);
        Extended operations=add_ext(add_ext(mul_ext(linear,sum),mul_ext(sum,sum)),image_radius);
        bound=add_ext(add_ext(mul_ext(add_ext(add_ext(linear,scale_ext(sum,2)),bound),bound),omitted),
            mul_ext(ext(1,0,-46),operations));
        for(unsigned k=0;k<8;++k){
            next[k]=mul_ext(scale_ext(orbit[n],2),coefficients[k]);
            if(!k)next[k]=add_ext(next[k],image_radius);
            for(unsigned j=0;j<k;++j)next[k]=add_ext(next[k],mul_ext(coefficients[j],coefficients[k-1-j]));
        }
        Extended next_sum={0};for(unsigned k=0;k<8;++k)next_sum=add_ext(next_sum,norm_ext(next[k]));
        double gap=2-__builtin_sqrt(escape_magnitude(orbit[n+1]));
        if(!less_ext(bound,mul_ext(next_sum,ext(1,0,-34))) || !less_ext(bound,ext(1,0,-48)) ||
            gap<=0 || !less_ext(add_ext(next_sum,bound),ext(gap*0.5,0,0)))break;
        for(unsigned k=0;k<8;++k){coefficients[k]=next[k];series_coefficients[k]=next[k];}
        series_start=n+1;series_error=add_ext(bound,mul_ext(ext(1,0,-45),next_sum));
    }
}
/* These nonnegative bounds round outwards, including underflow. Coefficients
 * below are ordinary doubles; their local rounding is paid for separately. */
static inline double certificate_add(double a,double b){return analytic_up(a+b);}
static inline double certificate_multiply(double a,double b){return analytic_up(a*b);}
static inline double certificate_norm(double r,double i){
    if(!r && !i)return 0;
    return analytic_up(__builtin_sqrt(certificate_add(certificate_multiply(r,r),certificate_multiply(i,i))));
}
static double certificate_reference_norm(unsigned n){
    /* Bound the actual fixed-point state, without assuming that its global
     * reference-error estimate is outward rounded. Three-limb conversion and
     * complex normalization add <8u |Z|, u=2^-53. The 32u inflation and absolute
     * term also cover conversion underflow to an ordinary double. */
    double r=orbit[n].r*power_two(orbit[n].e),i=orbit[n].i*power_two(orbit[n].e);
    return certificate_add(certificate_multiply(certificate_norm(r,i),1+0x1p-48),0x1p-500);
}
/* Certify non-escape only up to the requested limit, not membership in the
 * Mandelbrot set. A tile may be uniformly black now and escape at a larger
 * limit. Neither the normal series prefix nor its colour tolerance changes.
 *
 * Write dc=R*t, |t|<=1, and delta=P(t)+e, P=sum(a[k]*t^(k+1)). With
 * S=sum|a[k]| and O the omitted degree>8 products, a valid remainder update is
 * E' <= (2M+2S+E)E + O + coefficient rounding + rho. Here M bounds the actual
 * fixed-point state F, and |rho|<4*2^(-32*fraction) bounds its single-step
 * truncation residual: the real part loses <1 limb ulp and the imaginary
 * part <2 ulps. Thus no global reference-error estimate enters the proof.
 * Each retained complex product costs <4u times its absolute operands and
 * at most nine additions per coefficient cost <10u times their sum. The
 * aggregate, including <8u reference conversion, is <128u*(2M*S+S*S+R).
 * We use 512u plus an absolute 2^-500 allowance for subnormal arithmetic.
 * All positive bound operations, including coefficient norms, round upwards.
 * Success requires M[n]+S[n]+E[n]<2 at EVERY iteration through limit.
 */
static int certify_black_reference(unsigned width,unsigned height){
    if(!(deep_options&DEEP_BLACK_CERTIFICATE) || width*height<32 ||
       spacing_extended.e < -50 || spacing_extended.e > -26 || fraction<4 ||
       deep_header->count<limit || precision_needed)return 0;
    /* The existing footprint has two extra pixels beyond its L1 half-width.
     * With frame dimensions <=INT32_MAX, local-centre offset rounding is
     * <2^-20 pixel and limb truncation is <2^-70 pixel under these guards.
     * Thus this also contains the exact frame pixels about the limb centre. */
    double radius=analytic_up(normal_double(image_radius));
    if(!(radius>0 && radius<0.01))return 0;
    double residual=certificate_multiply(4,analytic_up(power_two(-32*(int)fraction)));
    double previous=certificate_reference_norm(0),delta=0;
    unsigned n;
    /* A cheap disk is enough for the least sensitive tiles. */
    for(n=0;n<limit;++n){
        ++deep_certificate_iterations;
        delta=certificate_add(certificate_multiply(certificate_add(certificate_multiply(2,previous),delta),delta),
            certificate_add(radius,residual));
        double next=certificate_reference_norm(n+1);
        if(!(certificate_add(next,delta)<2))break;
        previous=next;
    }
    if(n==limit)return 1;
    double ar[8]={0},ai[8]={0},br[8],bi[8],norms[8],error=0;
    previous=certificate_reference_norm(0);
    for(n=0;n<limit;++n){
        ++deep_certificate_iterations;
        double zr=orbit[n].r*power_two(orbit[n].e),zi=orbit[n].i*power_two(orbit[n].e);
        double sum=0,omitted=0;
        for(unsigned j=0;j<8;++j){norms[j]=certificate_norm(ar[j],ai[j]);sum=certificate_add(sum,norms[j]);}
        for(unsigned j=0;j<8;++j)for(unsigned k=0;k<8;++k)if(j+k+2>8)
            omitted=certificate_add(omitted,certificate_multiply(norms[j],norms[k]));
        double linear=certificate_multiply(2,previous);
        double operations=certificate_add(certificate_add(certificate_multiply(linear,sum),certificate_multiply(sum,sum)),radius);
        double amplification=certificate_add(certificate_add(linear,certificate_multiply(2,sum)),error);
        error=certificate_add(certificate_add(certificate_multiply(amplification,error),omitted),
            certificate_add(certificate_add(certificate_multiply(0x1p-44,operations),0x1p-500),residual));
        double next_sum=0;
        for(unsigned k=0;k<8;++k){
            br[k]=2*zr*ar[k]-2*zi*ai[k];bi[k]=2*zr*ai[k]+2*zi*ar[k];
            if(!k)br[k]+=radius;
            for(unsigned j=0;j<k;++j){
                br[k]+=ar[j]*ar[k-1-j]-ai[j]*ai[k-1-j];
                bi[k]+=ar[j]*ai[k-1-j]+ai[j]*ar[k-1-j];
            }
            next_sum=certificate_add(next_sum,certificate_norm(br[k],bi[k]));
        }
        double next=certificate_reference_norm(n+1);
        if(!(certificate_add(next,certificate_add(next_sum,error))<2))return 0;
        for(unsigned k=0;k<8;++k){ar[k]=br[k];ai[k]=bi[k];}
        previous=next;
    }
    return 1;
}
/* Both optional accurate-prefix paths retain the existing 2^-34 relative,
 * 2^-48 absolute and half-bailout-gap stopping tests. Their narrower domain
 * keeps ordinary doubles away from overflow; 2^-500 covers any underflow.
 * The local reference footprint still contains every pixel in the tile. */
static int precise_series_domain(void){
 double radius=normal_double(image_radius);
 return spacing_extended.e>=-50 && spacing_extended.e<=-26 && fraction>=4 && radius>0 && radius<0.01;
}
/* Form the DD polynomial while the actual fixed state F_n is available, before
 * orbit_step overwrites it. A failed black certificate selects a second fixed
 * reference pass; certified tiles therefore never construct DD coefficients.
 * The existing orbit buffer is reused, and identical fixed arithmetic gives
 * identical reference values. A descending update uses old lower coefficients.
 *
 * The remainder invariant is the same as the black certificate: delta=P8+e
 * about F_n, with explicit single-step truncation residual 4q. For u=2^-53,
 * big_dd conversion is <32u²|F|, dd_add <128u² times operand norms and
 * dd_multiply <256u² times their product (including cancellation). Complex
 * arithmetic and at most seven accumulation adds per coefficient give
 * <8192u²*operations. The budget 2^-90=65536u² leaves further reserve.
 * Positive bounds round upwards. Before exporting only the high components,
 * discarded lows must fit inside 32u*S; the unchanged 256u*S final reserve
 * also covers polynomial evaluation and normalization of dc/R.
 */
typedef struct {DoubleDouble r,i;} PrefixComplex;
static PrefixComplex prefix_dd[8];
static double prefix_dd_error,prefix_dd_sum,prefix_dd_radius;
/* Complex DD products and sums with both components in one f64x2 pair.
 * Lane 0 holds the real part, lane 1 the imaginary part. A product forms
 * ar*br+(-(ai*bi)) and ar*bi+ai*br with exactly the scalar dd_multiply and
 * dd_add sequences (the sign flip by -1 equals dd_negative), and every sum
 * adds both components with the scalar dd_add sequence, so all values are
 * bit-identical to the scalar code. This series prefix dominated the cost of
 * a local reference; two lanes roughly halve its instruction count. */
#if defined(__wasm_simd128__)
typedef DDLanes PrefixLanes;
static inline PrefixLanes prefix_lanes(PrefixComplex a){
 return (PrefixLanes){wasm_f64x2_make(a.r.hi,a.i.hi),wasm_f64x2_make(a.r.lo,a.i.lo)};
}
static inline PrefixComplex prefix_scalar(PrefixLanes a){
 return (PrefixComplex){{wasm_f64x2_extract_lane(a.hi,0),wasm_f64x2_extract_lane(a.lo,0)},
  {wasm_f64x2_extract_lane(a.hi,1),wasm_f64x2_extract_lane(a.lo,1)}};
}
static inline __attribute__((always_inline)) PrefixLanes prefix_product_lanes(PrefixComplex a,PrefixLanes b,PrefixLanes swapped){
 DDLanes ar={wasm_f64x2_splat(a.r.hi),wasm_f64x2_splat(a.r.lo)},ai={wasm_f64x2_splat(a.i.hi),wasm_f64x2_splat(a.i.lo)};
 DDLanes direct=dl_multiply(ar,b),cross=dl_multiply(ai,swapped);
 const v128_t sign=wasm_f64x2_make(-1.0,1.0);
 cross.hi=wasm_f64x2_mul(cross.hi,sign);cross.lo=wasm_f64x2_mul(cross.lo,sign);
 return dl_add(direct,cross);
}
static inline PrefixLanes prefix_swap(PrefixLanes a){
 return (PrefixLanes){wasm_i64x2_shuffle(a.hi,a.hi,1,0),wasm_i64x2_shuffle(a.lo,a.lo,1,0)};
}
static inline PrefixLanes prefix_sum(PrefixLanes a,PrefixLanes b){return dl_add(a,b);}
#else
typedef PrefixComplex PrefixLanes;
static inline PrefixLanes prefix_lanes(PrefixComplex a){return a;}
static inline PrefixComplex prefix_scalar(PrefixLanes a){return a;}
static inline PrefixLanes prefix_swap(PrefixLanes a){return a;}
static inline PrefixLanes prefix_product_lanes(PrefixComplex a,PrefixLanes b,PrefixLanes swapped){
 (void)swapped;
 return (PrefixComplex){dd_add(dd_multiply(a.r,b.r),dd_negative(dd_multiply(a.i,b.i))),
  dd_add(dd_multiply(a.r,b.i),dd_multiply(a.i,b.r))};
}
static inline PrefixLanes prefix_sum(PrefixLanes a,PrefixLanes b){return (PrefixComplex){dd_add(a.r,b.r),dd_add(a.i,b.i)};}
#endif
static double prefix_norm(PrefixComplex a){return certificate_add(certificate_norm(a.r.hi,a.i.hi),certificate_norm(a.r.lo,a.i.lo));}
/* The DD helpers have a conservative forward-error bound even through
 * cancellation; this inexpensive envelope also rejects unexpected overlap.
 * The absolute term covers subnormal high/low components. */
static int prefix_component_valid(DoubleDouble a){
 return absd(a.lo)<=certificate_add(certificate_multiply(0x1p-50,absd(a.hi)),0x1p-500);
}
static void prefix_dd_begin(void){
 prefix_dd_active=prefix_dd_used=(deep_options&DEEP_PRECISE_SERIES) && precise_series_domain();
 if(!prefix_dd_active)return;
 for(unsigned k=0;k<8;++k)prefix_dd[k]=(PrefixComplex){0};
 prefix_dd_error=prefix_dd_sum=0;prefix_dd_radius=normal_double(image_radius);series_start=0;series_radius=image_radius;
}
static void prefix_dd_before(void){
 if(!prefix_dd_active)return;
 double norms[8],S=0,O=0,M=certificate_reference_norm(reference_iteration),R=prefix_dd_radius;
 for(unsigned k=0;k<8;++k){norms[k]=prefix_norm(prefix_dd[k]);S=certificate_add(S,norms[k]);}
 if(!(M<=4 && S<=2 && R>0)){prefix_dd_active=0;return;}
 /* O = sum over j+k>=7 of |a_j||a_k| = sum_j |a_j| * (sum over k>=7-j of |a_k|).
  * Upward-rounded suffix sums give an upper bound with 15 instead of 72
  * outward operations (measured 10% of a prefix tile). */
 {double suffix[9];suffix[8]=0;for(unsigned k=8;k--;)suffix[k]=certificate_add(suffix[k+1],norms[k]);
  for(unsigned j=0;j<8;++j)O=certificate_add(O,certificate_multiply(norms[j],suffix[7-j]));}
 double linear=certificate_multiply(2,M),ops=certificate_add(certificate_add(certificate_multiply(linear,S),certificate_multiply(S,S)),R);
 double rho=certificate_multiply(4,analytic_up(power_two(-32*(int)fraction)));
 prefix_dd_error=certificate_add(certificate_add(certificate_multiply(certificate_add(certificate_add(linear,certificate_multiply(2,S)),prefix_dd_error),prefix_dd_error),O),
  certificate_add(certificate_add(certificate_multiply(0x1p-90,ops),rho),0x1p-500));
 PrefixComplex z={big_dd(xr_big,xr_sign),big_dd(xi_big,xi_sign)};
 if(!prefix_component_valid(z.r) || !prefix_component_valid(z.i)){prefix_dd_active=0;return;}
 z.r.hi*=2;z.r.lo*=2;z.i.hi*=2;z.i.lo*=2;
 PrefixLanes old[8],swapped[8];
 for(unsigned k=0;k<8;++k){old[k]=prefix_lanes(prefix_dd[k]);swapped[k]=prefix_swap(old[k]);}
 for(unsigned k=8;k--;){
  PrefixLanes lanes=prefix_product_lanes(z,old[k],swapped[k]);
  for(unsigned j=0;j<k;++j)lanes=prefix_sum(lanes,prefix_product_lanes(prefix_dd[j],old[k-1-j],swapped[k-1-j]));
  PrefixComplex next=prefix_scalar(lanes);
  /* Scalar order: R joins the real part before the cross products. Adding
     it afterwards would change the rounding, so k=0 has no cross terms and
     takes the scalar sum directly. */
  if(!k)next.r=dd_add(next.r,(DoubleDouble){R,0});
  if(!prefix_component_valid(next.r) || !prefix_component_valid(next.i)){prefix_dd_active=0;return;}
  prefix_dd[k]=next;
 }
 prefix_dd_sum=0;for(unsigned k=0;k<8;++k)prefix_dd_sum=certificate_add(prefix_dd_sum,prefix_norm(prefix_dd[k]));
}
static void prefix_dd_after(void){
 if(!prefix_dd_active)return;
 double E=prefix_dd_error,S=prefix_dd_sum,gap=analytic_down(2-certificate_reference_norm(reference_iteration));
 double low=0;for(unsigned k=0;k<8;++k)low=certificate_add(low,certificate_norm(prefix_dd[k].r.lo,prefix_dd[k].i.lo));
 if(!(E<analytic_down(S*0x1p-34) && E<0x1p-48 && gap>0 && certificate_add(S,E)<analytic_down(gap*.5) && low<certificate_multiply(0x1p-48,S))){prefix_dd_active=0;return;}
 for(unsigned k=0;k<8;++k)series_coefficients[k]=ext(prefix_dd[k].r.hi,prefix_dd[k].i.hi,0);
 series_start=reference_iteration;series_error=ext(certificate_add(E,certificate_multiply(0x1p-45,S)),0,0);
}
/* The cheaper optional double path also bounds delta about F_n explicitly.
 * Coefficient operations cost <12u*operations and stored-orbit conversion
 * <8u*operations. The 32u budget replaces the previous 128u estimate, with
 * outward positive arithmetic and the fixed-point residual now explicit.
 * This changes the error estimate, never the stopping tolerances. */
static void prepare_series_tight(void){
 double ar[8]={0},ai[8]={0},br[8],bi[8],norms[8],E=0,R=normal_double(image_radius);
 double rho=certificate_multiply(4,analytic_up(power_two(-32*(int)fraction)));
 series_start=0;series_radius=image_radius;
 for(unsigned n=0;n<deep_header->count;++n){
  double S=0,O=0,M=certificate_reference_norm(n);
  for(unsigned j=0;j<8;++j){norms[j]=certificate_norm(ar[j],ai[j]);S=certificate_add(S,norms[j]);}
  if(!(M<=4 && S<=2 && R>0))break;
  for(unsigned j=0;j<8;++j)for(unsigned k=0;k<8;++k)if(j+k+2>8)O=certificate_add(O,certificate_multiply(norms[j],norms[k]));
  double linear=certificate_multiply(2,M),ops=certificate_add(certificate_add(certificate_multiply(linear,S),certificate_multiply(S,S)),R);
  E=certificate_add(certificate_add(certificate_multiply(certificate_add(certificate_add(linear,certificate_multiply(2,S)),E),E),O),
    certificate_add(certificate_add(certificate_multiply(0x1p-48,ops),rho),0x1p-500));
  double zr=orbit[n].r*power_two(orbit[n].e),zi=orbit[n].i*power_two(orbit[n].e),nextS=0;
  for(unsigned k=0;k<8;++k){
   br[k]=2*zr*ar[k]-2*zi*ai[k];bi[k]=2*zr*ai[k]+2*zi*ar[k];
   if(!k)br[k]+=R;
   for(unsigned j=0;j<k;++j){br[k]+=ar[j]*ar[k-1-j]-ai[j]*ai[k-1-j];bi[k]+=ar[j]*ai[k-1-j]+ai[j]*ar[k-1-j];}
   nextS=certificate_add(nextS,certificate_norm(br[k],bi[k]));
  }
  double gap=analytic_down(2-certificate_reference_norm(n+1));
  if(!(E<analytic_down(nextS*0x1p-34) && E<0x1p-48 && gap>0 && certificate_add(nextS,E)<analytic_down(gap*0.5)))break;
  for(unsigned k=0;k<8;++k){ar[k]=br[k];ai[k]=bi[k];series_coefficients[k]=ext(br[k],bi[k],0);}
  series_start=n+1;series_error=ext(certificate_add(E,certificate_multiply(0x1p-45,nextS)),0,0);
 }
}
static void prepare_series(void){
 if(prefix_dd_used && series_start)return;
 if((deep_options&(DEEP_PRECISE_SERIES|DEEP_TIGHT_SERIES)) && precise_series_domain())prepare_series_tight();
 else prepare_series_legacy();
}
static inline uint32_t fixed_result(uint32_t pixel,unsigned iterations){deep_fixed_iterations+=iterations;return pixel;}
static uint32_t fixed_pixel(Extended dc) {
    ++deep_fallbacks;
    Extended r=dc,i=dc;i.r=dc.i;i.i=0;r.i=0;
    int sr,si;
    if(reference_local && spacing_extended.e < -79){
        /* A local reference is exact in limbs, but its double perturbation
           offset is rounded. Reconstruct fallback coordinates from the frame
           grid, otherwise cancelling offsets can move a real-axis pixel off
           the axis (or move c=i) by a tiny yet decisive residual. */
        double x=(double)tile_x+tile_completed%tile_w+0.5-half_width;
        double y=half_height-(double)tile_y-tile_completed/tile_w-0.5;
        pixel_offset_big(scratch[4],x);pixel_offset_big(scratch[5],y);
        sr=sum_big(scratch[6],frame_real,frame_rs,scratch[4],x<0?-1:1);
        si=sum_big(scratch[7],frame_imag,frame_is,scratch[5],y<0?-1:1);
    }else{
        big_from_extended(scratch[4],r);big_from_extended(scratch[5],i);
        sr=sum_big(scratch[6],cr_big,cr_sign,scratch[4],r.r<0?-1:1);
        si=sum_big(scratch[7],ci_big,ci_sign,scratch[5],i.r<0?-1:1);
    }
    int imaginary_zero=1;for(unsigned j=0;j<digits;++j)if(scratch[7][j]){imaginary_zero=0;break;}
    if(imaginary_zero){
        /* The real interval [-2, 1/4] is in the set. Compare limbs so tiny
         * offsets to the LEFT of -2 cannot disappear in a double conversion. */
        clear_big(scratch[4]);
        if(sr<0)scratch[4][fraction]=2;else scratch[4][fraction-1]=0x40000000u;
        if(compare_big(scratch[6],scratch[4])<=0)return UINT32_C(0xff000000);
    }
    clear_big(xr_big);clear_big(xi_big);xr_sign=xi_sign=1;
    Extended error={0},previous_norm={0};
    for(unsigned n=1;n<=limit;++n){
        rounded_product=0;orbit_step(scratch[6],sr,scratch[7],si);
        Extended z=current_big(),norm=norm_ext(z);
        error=mul_ext(add_ext(scale_ext(previous_norm,2),error),error);
        if(rounded_product)error=add_ext(error,ext(4,0,-32*(int)fraction));
        if(error.r && !less_ext(error,mul_ext(norm,ext(1,0,-48)))){precision_needed=1;return fixed_result(0,n);}
        previous_norm=norm;double mag=escape_magnitude(z);
        if(absd(mag-4)<1e-10){
            rounded_product=0;Extended margin=precise_margin();
            Extended uncertainty=mul_ext(error,add_ext(scale_ext(norm,2),error));
            if(rounded_product)uncertainty=add_ext(uncertainty,ext(4,0,-32*(int)fraction));
            if(uncertainty.r && !less_ext(uncertainty,norm_ext(margin))){precision_needed=1;return fixed_result(0,n);}
            if(margin.r>0)return fixed_result(colour(n,mag),n);
        }
        else if(mag>4)return fixed_result(colour(n,mag),n);}
    return fixed_result(UINT32_C(0xff000000),limit);
}
/* DD (106 bits) is tried only where it can succeed. A pixel reaches this
 * point because the perturbation bound, injected at 2^-48|dc| per step,
 * exceeded 2^-30|z|; DD injects about 2^-96|c| instead and has to stay below
 * 2^-32|z| under the same amplification. With |dc| near the spacing 2^e this
 * fails whenever 2^-48 2^e is below about 2^-94, i.e. from e near -46 on.
 * Measured with the tighter bound: every DD attempt failed at 2^-64, almost
 * every one succeeded at 2^-48. Below the threshold the fixed-point orbit is
 * used directly; results are unchanged, only lost DD work is avoided. */
#define DD_FALLBACK_MIN_EXPONENT (-52)
static int dd_fallback_useful(void){return spacing_extended.e>=DD_FALLBACK_MIN_EXPONENT;}
static uint32_t precise_pixel(Extended dc) {
    if(dd_fallback_useful()){int certain=1;uint32_t pixel=dd_pixel(dc,&certain);if(certain)return pixel;}
    return fixed_pixel(dc);
}
/* While a tile defers its precise pixels, uncertain perturbation results are
 * collected and resolved afterwards by the interleaved DD kernel. */
static int defer_precise,pixel_deferred;
static uint32_t uncertain_pixel(Extended dc){
    if(allow_reference){request_reference=1;return 0;}
    if(defer_precise){pixel_deferred=1;return 0;}
    return precise_pixel(dc);
}
static inline uint32_t perturb_result(uint32_t pixel,unsigned iterations){deep_perturb_iterations+=iterations;return pixel;}
/* Perturbation error bound (both the Extended and the double path).
 *
 * Let Z* be the exact orbit of the reference centre C and Zs=Z*+zeta its stored
 * double-mantissa sample. The fixed-point state is within 2^-64|Z| of Z* (checked
 * by deep_reference at every step, else precision is grown), and the three-limb
 * conversion plus complex normalization add <2.1u|Z|, u=2^-53; so |zeta|<2.2u|Zs|.
 * Define the exact offset d=z-Z* of the pixel orbit z (c=C+dc): d'=2Z*d+d^2+dc.
 * The computed offset t satisfies t'=2Zs*t+t^2+dc+rho. For e=t-d:
 *
 *     e' = e*(2w-e) + 2*zeta*t + rho,   w = Z*+t = (Zs+t)-zeta,
 *
 * hence |e'| <= |e|*(2|w|+|e|) + |2 zeta t| + |rho| with |w| <= |Zs+t|+|zeta|.
 * The old amplification 2(|Zs|+|t|) is a triangle bound on the same quantity and
 * is very loose where t is not small against Zs (the parabolic cusp channel).
 *
 * After every rebase test either Zs=0 exactly (m=0) or |t|<=|Zs+t|(1+2^-45),
 * so |Zs|<=2.01|Zs+t| and |zeta|<4.5u|Zs+t|. The bound norm below inflates
 * the computed |Zs+t| by 2^-46=128u, which covers |zeta| and its own rounding.
 * Before the first step (series start) the triangle form bounds |w| instead.
 *
 * Injection: complex products and the two additions round by <7.2u times
 * |a|+|b|+|dc| (a=2 Zs t, b=t^2), and |2 zeta t|<2.3u|a|. The 2^-48=32u
 * coefficient is therefore more than twice the actual injection (the double
 * path's tighter count is at perturb_rounding). A rebase
 * replaces t by fl(Zs+t) against Z*_0=0 and adds |zeta|+rounding <2.2u|Zs|+2u|z|;
 * it is charged 2^-48(|Zs+t|+|t|), or 2^-47|t| when the test found |Zs+t|<|t|. The escape margin also uses Zs instead of Z*;
 * see perturb_margin for that term and the margin's own roundings.
 *
 * Every positive bound operation rounds to nearest. With injections at least
 * c>1 times their true size, an induction on b'=b(2w+b)+i shows that the
 * computed bound stays above the true error while (1-u)^(8n)>=1/c; for c=1.4
 * that holds for n<2^49 iterations, far beyond INT32_MAX. Extended additions that drop a summand
 * below 2^-56 of the other lose less than u/8 and fall under the same factor.
 * The BLA branch is unchanged: its amplification comes from the certified
 * block remainder, not from the triangle bound replaced here. */
static inline Extended bound_norm_ext(Extended a){return ext(__builtin_sqrt(a.r*a.r+a.i*a.i)*(1+0x1p-46),0,a.e);}
/* Near the bailout circle decide |Z+delta|^2-4 from the precise reference
 * margin. Returns 1 for a certain escape, 0 for certainly bounded, -1 otherwise.
 *
 * Here |z|^2 is within 1e-7 of 4, |Zs|<=2 for m<count and |Zs|<=6 at m=count,
 * so |t|<=|z|+|Zs|<9. Using Zs instead of Z* in the cross term costs
 * 2|zeta t|<4.4u|Zs||t|; the cross and square products, the three-limb margin
 * and both sums round by <12u|Zs||t|+6u|t|^2+2u|margin|, using
 * |margin_ref|<=2|cross|+|t|^2+|margin| for the cancelling case. All of this
 * is <200u|t|. Adding 2^-46|t|_1 >= 128u|t| to the bound enlarges
 * E(2|z|+E) by more than 2^-46|t|*2|z| > 500u|t|; the margin is compared
 * after shrinking it by 2^-50 for its own final rounding.
 * The cross term needs only its real part, formed directly; this avoids the
 * subnormal loss of clearing the imaginary part of a normalized product. */
static inline __attribute__((always_inline)) int perturb_margin(unsigned m,Extended delta,Extended anorm,Extended error){
    Extended z=orbit[m];
    Extended cross=ext(2*(z.r*delta.r+z.i*delta.i),0,z.e+delta.e);
    Extended square=ext(delta.r*delta.r+delta.i*delta.i,0,2*delta.e);
    Extended margin=add_ext(bailout_margin[m],add_ext(cross,square));
    Extended total=add_ext(error,ext((absd(delta.r)+absd(delta.i))*0x1p-46,0,delta.e));
    Extended uncertainty=mul_ext(total,add_ext(shift_ext(anorm,1),total));
    Extended size=ext(absd(margin.r)*(1-0x1p-50),0,margin.e);
    if(!less_ext(uncertainty,size))return -1;
    return margin.r>0;
}
/* Copy the stored orbit into plain doubles behind the limb workspace. The
 * conversion is exact for normal results; an underflowing sample changes by
 * less than 2^-1074, which the double path's absolute 2^-1060 term covers. */
static int prepare_orbit_double(void){
    if(orbit_double_ready)return 1;
    size_t data=deep_data_size();
    uint64_t offset=((uint64_t)data+(uint64_t)digits*18*sizeof(uint32_t)+15)&~(uint64_t)15;
    unsigned count=deep_header->count;
    /* One extra zero sample: idle interleaved lanes gather orbit[1]. */
    uint64_t needed=offset+((uint64_t)count+2)*2*sizeof(double);
    if(needed>UINT32_MAX-65536u || !reserve_arena((size_t)needed))return 0;
    map_arena(data,reference_limit);
    orbit_double=(double *)(arena+offset);
    for(unsigned j=0;j<=count;++j){
        double s=power_two(orbit[j].e);
        orbit_double[2*j]=orbit[j].r*s;orbit_double[2*j+1]=orbit[j].i*s;
    }
    orbit_double[2*count+2]=orbit_double[2*count+3]=0;
    orbit_double_ready=1;return 1;
}
/* The same recurrence and bound as perturb_pixel in plain doubles. Unlike
 * add_ext, double sums never drop small summands, and power-of-two scaling
 * between Extended and double is exact for normal results. The argument above
 * applies unchanged. Any underflow (operands, the orbit copy, conversions of
 * dc, series or BLA values) loses <2^-1074 per operation, at most 16 per step;
 * every step therefore adds an absolute 2^-1060. Correctness needs no lower
 * spacing limit: if dc itself underflowed, the bound would still contain the
 * true error and simply fail the relative test. DOUBLE_PERTURB_MIN_EXPONENT
 * is the useful range: dc and the injection stay normal, and t^2 underflows
 * only where it is negligible against 2 Zs t. An infinite or NaN bound fails
 * the relative test and falls back. BLA blocks and the bailout margin keep the
 * Extended arithmetic, entered with exact conversions.
 * Separate and not inlined: the Extended loop must keep its code layout. */
#define DOUBLE_PERTURB_MIN_EXPONENT (-480)
/* One pixel's double perturbation state. The scalar function and the
 * interleaved kernel below share these steps, so a lane that takes the slow
 * path (BLA, bailout margin, rebase, exit) runs exactly the scalar code. */
typedef struct {
    double dr,di,dcr,dci,error,znorm,dn2,cnorm,Zr,Zi;
    unsigned n,m,computed,index;int within;Extended dc,cnorm_ext;
} PerturbState;
static const double perturb_tiny=0x1p-1060;
/* Rounding coefficient of the plain double step (M3), u=2^-53. With a=2Zs t
 * and b=t^2: 2(Zr dr-Zi di) and 2(Zr di+Zi dr) err by <2u per component sum,
 * <sqrt(2)u|a| in norm; dr^2-di^2 and 2 dr di by <sqrt(5)u|b|; the two
 * additions by <u(2|a|+2|b|+|dc|); and 2|zeta t|<2.26u|a| (three-limb sample,
 * dropped component <u/4, reference error 2^-64). In total <5.7u(|a|+|b|+|dc|),
 * so 2^-50=8u exceeds the true injection by a factor 1.4. The induction above
 * then needs (1-u)^(8n)>=1/1.4, i.e. n<2^49, as before. The computed |a| and
 * |b| round by <3u, which the same factor covers. The Extended path keeps 2^-48:
 * its add_ext may also drop summands, which this count does not include. */
static const double perturb_rounding=0x1p-50;
static inline __attribute__((always_inline)) void perturb_start(PerturbState *p,Extended dc){
    const double *z=orbit_double;
    p->dc=dc;p->dcr=dc.r*power_two(dc.e);p->dci=dc.i*power_two(dc.e);
    p->cnorm_ext=norm_ext(dc);p->cnorm=normal_double(p->cnorm_ext);
    p->within=!less_ext(image_radius,p->cnorm_ext);
    p->dr=p->di=p->error=0;p->n=p->m=p->computed=0;
    if(series_start && p->within){
        Extended t=ext(dc.r/series_radius.r,dc.i/series_radius.r,dc.e-series_radius.e);
        Extended delta=series_coefficients[7];
        for(unsigned k=7;k--;)delta=add_ext(mul_ext(delta,t),series_coefficients[k]);
        delta=mul_ext(delta,t);
        double s=power_two(delta.e);p->dr=delta.r*s;p->di=delta.i*s;
        p->error=normal_double(series_error)+perturb_tiny;p->n=p->m=series_start;deep_skipped+=series_start;
    }
    p->dn2=p->dr*p->dr+p->di*p->di;p->Zr=z[2*p->m];p->Zi=z[2*p->m+1];
    p->znorm=__builtin_sqrt(p->Zr*p->Zr+p->Zi*p->Zi)*(1+0x1p-46)+__builtin_sqrt(p->dn2)*(1+0x1p-50);
}
static inline __attribute__((always_inline)) int perturb_bla_due(const PerturbState *p,unsigned first){
    return p->within && p->m>=first && !((p->m-first)%16);
}
static inline __attribute__((always_inline)) const Approximation *perturb_choose(const PerturbState *p,unsigned first){
    const Approximation *chosen=NULL;
    Extended reach=ext(__builtin_sqrt(p->dn2)*(1+0x1p-50)+p->error,0,0);
    for(unsigned l=0;l<deep_header->levels;++l){
        unsigned block=16u<<l;if((p->m-first)%block)break;
        unsigned index=(p->m-first)/block;if(index>=deep_header->length[l])break;
        const Approximation *b=approximations+deep_header->offset[l]+index;
        if(!b->steps || b->steps>limit-p->n || !less_ext(reach,b->radius))break;
        chosen=b;
    }
    return chosen;
}
static inline __attribute__((always_inline)) void perturb_bla(PerturbState *p,const Approximation *chosen){
    Extended delta=ext(p->dr,p->di,0),err=ext(p->error,0,0),dnorm=norm_ext(delta);
    Extended t=add_ext(dnorm,p->cnorm_ext),remainder=mul_ext(chosen->q,mul_ext(t,t));
    Extended amplification=add_ext(norm_ext(chosen->a),mul_ext(chosen->q,add_ext(shift_ext(t,1),err)));
    Extended ad=perturb_mul_ext(chosen->a,delta),bc=perturb_mul_ext(chosen->b,p->dc);
    Extended round=mul_ext(scale_ext(ext(1,0,-48),chosen->steps),add_ext(norm_ext(ad),norm_ext(bc)));
    err=add_ext(add_ext(mul_ext(amplification,err),remainder),round);
    delta=add_ext(ad,bc);p->n+=chosen->steps;p->m+=chosen->steps;deep_skipped+=chosen->steps-1;
    double s=power_two(delta.e);p->dr=delta.r*s;p->di=delta.i*s;
    p->error=normal_double(err)*(1+0x1p-50)+perturb_tiny;
}
static inline __attribute__((always_inline)) void perturb_plain(PerturbState *p){
    double dr=p->dr,di=p->di,Zr=p->Zr,Zi=p->Zi;
    double ar=2*(Zr*dr-Zi*di),ai=2*(Zr*di+Zi*dr);
    double br=dr*dr-di*di,bi=2*(dr*di);
    p->error=(2*p->znorm+p->error)*p->error+(perturb_rounding*((__builtin_sqrt(ar*ar+ai*ai)+p->dn2)+p->cnorm)+perturb_tiny);
    p->dr=(ar+br)+p->dcr;p->di=(ai+bi)+p->dci;++p->n;++p->m;
}
/* Everything after the recurrence step: returns 0 to continue, 1 with *pixel
 * for a decided pixel and 2 for an uncertain one. */
static inline __attribute__((always_inline)) int perturb_finish(PerturbState *p,uint32_t *pixel){
    const double *z=orbit_double;
    p->Zr=z[2*p->m];p->Zi=z[2*p->m+1];
    double xr=p->Zr+p->dr,xi=p->Zi+p->di,magnitude=xr*xr+xi*xi,anorm=__builtin_sqrt(magnitude);
    p->znorm=anorm*(1+0x1p-46);
    if(!(p->error<0x1p-30*anorm))return 2;
    if(absd(magnitude-4)<1e-7){
        int escaped=perturb_margin(p->m,ext(p->dr,p->di,0),ext(anorm*(1+0x1p-50),0,0),ext(p->error,0,0));
        if(escaped<0)return 2;
        if(escaped){*pixel=colour(p->n,magnitude);return 1;}
    }else if(magnitude>4){*pixel=colour(p->n,magnitude);return 1;}
    p->dn2=p->dr*p->dr+p->di*p->di;
    if(p->m>=deep_header->count || magnitude<p->dn2){
        p->error+=0x1p-48*(anorm+__builtin_sqrt(p->dn2))*(1+0x1p-50);
        p->dr=xr;p->di=xi;p->dn2=magnitude;p->m=0;p->Zr=p->Zi=0;
    }
    return 0;
}
/* The scalar loop; returns 1 with *pixel, or 2 for an uncertain pixel. */
static inline __attribute__((always_inline)) int perturb_run(PerturbState *p,uint32_t *pixel){
    const unsigned first=(deep_options&DEEP_BLA_ONE)?1:0;
    while(p->n<limit){
        ++p->computed;
        const Approximation *chosen=perturb_bla_due(p,first)?perturb_choose(p,first):NULL;
        if(chosen)perturb_bla(p,chosen);else perturb_plain(p);
        int state=perturb_finish(p,pixel);
        if(state)return state;
    }
    *pixel=UINT32_C(0xff000000);return 1;
}
static __attribute__((noinline)) uint32_t perturb_pixel_double(Extended dc){
    PerturbState p;uint32_t pixel=0;perturb_start(&p,dc);
    int state=perturb_run(&p,&pixel);
    return perturb_result(state==2?uncertain_pixel(dc):pixel,p.computed);
}

/* Interleaved double perturbation: four pixels in two pairs of f64x2 lanes.
 * The scalar loop is a latency-bound chain of about 16 cycles; independent
 * lanes fill the pipeline. The common iteration (no BLA block due, plain
 * recurrence, no event) runs vectorized with exactly the scalar operations of
 * perturb_plain and perturb_finish in the same order, without contraction,
 * so every lane value is bit-identical. Any lane event - a due BLA check,
 * relative test, bailout margin, escape, rebase or the limit - is handled by
 * the scalar functions on that lane's state. A due BLA check that chooses a
 * block replaces the lane's vector step by the scalar BLA step. */
typedef struct {DDVector dr,di,dcr,dci,error,znorm,dn2,cnorm,Zr,Zi;} PerturbLanes;
static inline void perturb_lane_store(PerturbLanes *v,unsigned half,const PerturbState *p){
    v->dr=dv_set(v->dr,half,p->dr);v->di=dv_set(v->di,half,p->di);
    v->dcr=dv_set(v->dcr,half,p->dcr);v->dci=dv_set(v->dci,half,p->dci);
    v->error=dv_set(v->error,half,p->error);v->znorm=dv_set(v->znorm,half,p->znorm);
    v->dn2=dv_set(v->dn2,half,p->dn2);v->cnorm=dv_set(v->cnorm,half,p->cnorm);
    v->Zr=dv_set(v->Zr,half,p->Zr);v->Zi=dv_set(v->Zi,half,p->Zi);
}
static inline void perturb_lane_load(const PerturbLanes *v,unsigned half,PerturbState *p){
    p->dr=dv_get(v->dr,half);p->di=dv_get(v->di,half);
    p->error=dv_get(v->error,half);p->znorm=dv_get(v->znorm,half);
    p->dn2=dv_get(v->dn2,half);p->Zr=dv_get(v->Zr,half);p->Zi=dv_get(v->Zi,half);
}
/* The vectorized perturb_plain, the orbit gather and perturb_finish's
 * arithmetic. Returns the lane event mask (relative test, margin band,
 * escape, rebase by magnitude) before the integer events are added. */
static inline __attribute__((always_inline)) unsigned perturb_lanes_step(PerturbLanes *v,const double *za,const double *zb){
    const DDVector two=dv_splat(2);
    DDVector dr=v->dr,di=v->di,Zr=v->Zr,Zi=v->Zi;
    DDVector ar=dv_mul(two,dv_sub(dv_mul(Zr,dr),dv_mul(Zi,di))),ai=dv_mul(two,dv_add(dv_mul(Zr,di),dv_mul(Zi,dr)));
    DDVector br=dv_sub(dv_mul(dr,dr),dv_mul(di,di)),bi=dv_mul(two,dv_mul(dr,di));
    v->error=dv_add(dv_mul(dv_add(dv_mul(two,v->znorm),v->error),v->error),
        dv_add(dv_mul(dv_splat(perturb_rounding),dv_add(dv_add(dv_sqrt(dv_add(dv_mul(ar,ar),dv_mul(ai,ai))),v->dn2),v->cnorm)),dv_splat(perturb_tiny)));
    dr=dv_add(dv_add(ar,br),v->dcr);di=dv_add(dv_add(ai,bi),v->dci);
#if defined(__wasm_simd128__)
    v128_t pa=wasm_v128_load(za),pb=wasm_v128_load(zb);
    Zr=wasm_i64x2_shuffle(pa,pb,0,2);Zi=wasm_i64x2_shuffle(pa,pb,1,3);
#else
    Zr=(DDVector){{za[0],zb[0]}};Zi=(DDVector){{za[1],zb[1]}};
#endif
    DDVector xr=dv_add(Zr,dr),xi=dv_add(Zi,di),magnitude=dv_add(dv_mul(xr,xr),dv_mul(xi,xi)),anorm=dv_sqrt(magnitude);
    v->znorm=dv_mul(anorm,dv_splat(1+0x1p-46));
    DDVector dn2=dv_add(dv_mul(dr,dr),dv_mul(di,di));
    DDVector events=dv_or(dv_or(dv_not(dv_lt(v->error,dv_mul(dv_splat(0x1p-30),anorm))),
        dv_lt(dv_abs(dv_sub(magnitude,dv_splat(4))),dv_splat(1e-7))),dv_or(dv_gt(magnitude,dv_splat(4)),dv_lt(magnitude,dn2)));
    v->dr=dr;v->di=di;v->Zr=Zr;v->Zi=Zi;v->dn2=dn2;
    return dv_bits(events);
}
static Extended pending_dc(unsigned index);
/* Perturb queue[0..count); uncertain pixels are appended to pending.
 * Lanes leave the vector loop for every event. Where events are frequent
 * (orbits along the bailout circle near c=-2 enter the margin band at almost
 * every step) the scalar loop is faster; after a sample of 4096 lane steps,
 * an event rate above 1/8 stops refilling and the rest of the tile runs
 * scalar. Either way every pixel is computed by identical operations. */
static __attribute__((noinline)) void perturb_queue_scalar(const uint16_t *queue,unsigned count){
    for(unsigned k=0;k<count;++k){
        PerturbState p;uint32_t pixel=0;unsigned index=queue[k];
        perturb_start(&p,pending_dc(index));
        int state=perturb_run(&p,&pixel);deep_perturb_iterations+=p.computed;
        if(state==2)pending[pending_count++]=(uint16_t)index;else output[index]=pixel;
    }
}
static void perturb_batch(const uint16_t *queue,unsigned count){
    const unsigned first=(deep_options&DEEP_BLA_ONE)?1:0,bla=deep_header->levels!=0;
    const unsigned reference_count=deep_header->count;
    const double *z=orbit_double;
    PerturbLanes lanes[2];
    for(unsigned k=0;k<2;++k){DDVector zero=dv_splat(0);lanes[k]=(PerturbLanes){zero,zero,zero,zero,zero,zero,zero,zero,zero,zero};}
    PerturbState state[4];
    unsigned active=0,refill=15,next=0,scalar=0;uint64_t steps=0,slow=0;
    for(unsigned lane=0;lane<4;++lane){state[lane].n=state[lane].m=0;state[lane].within=0;}
    for(;;){
        if(!scalar && steps>=4096 && slow*8>steps)scalar=1;
        /* Load lanes; a pixel can finish during its first scalar iteration. */
        for(unsigned lane=0;refill;lane=(lane+1)&3){
            unsigned bit=1u<<lane;
            if(!(refill&bit))continue;
            refill&=~bit;active&=~bit;
            PerturbState *p=&state[lane];
            while(next<count && !scalar){
                unsigned index=queue[next++];
                perturb_start(p,pending_dc(index));p->index=index;
                if(p->n>=limit){deep_perturb_iterations+=p->computed;output[index]=UINT32_C(0xff000000);continue;}
                active|=bit;break;
            }
            if(!(active&bit)){
                p->dr=p->di=p->dcr=p->dci=p->error=p->znorm=p->dn2=p->cnorm=p->Zr=p->Zi=0;p->n=p->m=0;p->within=0;
            }
            perturb_lane_store(&lanes[lane>>1],lane&1,p);
        }
        if(!active){perturb_queue_scalar(queue+next,count-next);return;}
        unsigned finished=0;
        do{
            /* Integer events at the top of an iteration: a BLA block is due. */
            unsigned bla_lanes=0;
            if(bla)for(unsigned lane=0;lane<4;++lane)
                if((active&(1u<<lane)) && perturb_bla_due(&state[lane],first))bla_lanes|=1u<<lane;
            unsigned chosen_lanes=0;const Approximation *chosen[4]={0};
            for(unsigned lane=0;bla_lanes>>lane;++lane){
                if(!(bla_lanes&(1u<<lane)))continue;
                PerturbState *p=&state[lane];perturb_lane_load(&lanes[lane>>1],lane&1,p);
                chosen[lane]=perturb_choose(p,first);
                if(chosen[lane])chosen_lanes|=1u<<lane;
            }
            unsigned events=perturb_lanes_step(&lanes[0],z+2*(state[0].m+1),z+2*(state[1].m+1))|
                perturb_lanes_step(&lanes[1],z+2*(state[2].m+1),z+2*(state[3].m+1))<<2;
            for(unsigned lane=0;lane<4;++lane){
                PerturbState *p=&state[lane];
                if(!(active&(1u<<lane)))continue;
                ++p->computed;++p->n;++p->m;
                if(p->m>=reference_count || p->n>=limit)events|=1u<<lane;
            }
            events=(events|chosen_lanes)&active;
            steps+=(unsigned)__builtin_popcount(active);slow+=(unsigned)__builtin_popcount(events|bla_lanes);
            for(unsigned lane=0;events>>lane;++lane){
                unsigned bit=1u<<lane;
                if(!(events&bit))continue;
                PerturbState *p=&state[lane];
                if(chosen_lanes&bit){
                    /* Undo the vector step's counters, then take the BLA step
                       from the state saved before it (still in p). */
                    --p->n;--p->m;
                    perturb_bla(p,chosen[lane]);
                }else perturb_lane_load(&lanes[lane>>1],lane&1,p);
                uint32_t pixel=0;int result=perturb_finish(p,&pixel);
                if(!result && p->n>=limit){result=1;pixel=UINT32_C(0xff000000);}
                if(result){
                    deep_perturb_iterations+=p->computed;
                    if(result==2)pending[pending_count++]=(uint16_t)p->index;
                    else output[p->index]=pixel;
                    finished|=bit;
                }else perturb_lane_store(&lanes[lane>>1],lane&1,p);
            }
        }while(!finished);
        refill=finished;
    }
}
static inline __attribute__((always_inline)) uint32_t perturb_pixel(Extended dc) {
    if((deep_options&DEEP_DOUBLE_PERTURB) && spacing_extended.e>=DOUBLE_PERTURB_MIN_EXPONENT && prepare_orbit_double())
        return perturb_pixel_double(dc);
    Extended delta={0},error={0};unsigned n=0,m=0,computed=0;
    const Extended cnorm=norm_ext(dc);
    const int within_reference_radius=!less_ext(image_radius,cnorm);
    if(series_start && within_reference_radius){
        Extended t=ext(dc.r/series_radius.r,dc.i/series_radius.r,dc.e-series_radius.e);
        delta=series_coefficients[7];
        for(unsigned k=7;k--;)delta=add_ext(mul_ext(delta,t),series_coefficients[k]);
        delta=mul_ext(delta,t);error=series_error;n=m=series_start;deep_skipped+=series_start;
    }
    Extended dnorm=norm_ext(delta),znorm=add_ext(bound_norm_ext(orbit[m]),dnorm);
    const Extended rounding=ext(1,0,-48);
    const unsigned first=(deep_options&DEEP_BLA_ONE)?1:0;
    while(n<limit){
        ++computed;
        const Approximation *chosen=NULL;
        if(within_reference_radius && m>=first && !((m-first)%16))for(unsigned l=0;l<deep_header->levels;++l){
            unsigned block=16u<<l;if((m-first)%block)break;
            unsigned index=(m-first)/block;if(index>=deep_header->length[l])break;
            const Approximation *b=approximations+deep_header->offset[l]+index;
            if(!b->steps || b->steps>limit-n || !less_ext(add_ext(dnorm,error),b->radius))break;
            chosen=b;
        }
        if(chosen){
            Extended t=add_ext(dnorm,cnorm),remainder=mul_ext(chosen->q,mul_ext(t,t));
            Extended amplification=add_ext(norm_ext(chosen->a),mul_ext(chosen->q,add_ext(shift_ext(t,1),error)));
            Extended ad=perturb_mul_ext(chosen->a,delta),bc=perturb_mul_ext(chosen->b,dc);
            Extended round=mul_ext(scale_ext(rounding,chosen->steps),add_ext(norm_ext(ad),norm_ext(bc)));
            error=add_ext(add_ext(mul_ext(amplification,error),remainder),round);
            delta=add_ext(ad,bc);n+=chosen->steps;m+=chosen->steps;deep_skipped+=chosen->steps-1;
        }else{
            Extended a=perturb_mul_ext(shift_ext(orbit[m],1),delta),b=perturb_mul_ext(delta,delta);
            Extended amplification=add_ext(shift_ext(znorm,1),error);
            error=add_ext(mul_ext(amplification,error),shift_ext(add_ext(add_ext(norm_ext(a),norm_ext(b)),cnorm),-48));
            delta=add_three_ext(a,b,dc);++n;++m;
        }
        Extended actual=add_ext(orbit[m],delta),anorm=norm_ext(actual);
        /* anorm carries 2^-50; the extra factor reaches the 2^-46 bound norm. */
        znorm=(Extended){anorm.r*(1+0x1p-46),0,anorm.e,0};
        if(!less_ext(error,shift_ext(anorm,-30)) && error.r)return perturb_result(uncertain_pixel(dc),computed);
        double magnitude=escape_magnitude(actual);
        if(absd(magnitude-4)<1e-7){
            int escaped=perturb_margin(m,delta,anorm,error);
            if(escaped<0)return perturb_result(uncertain_pixel(dc),computed);
            if(escaped)return perturb_result(colour(n,magnitude),computed);
        }else if(magnitude>4)return perturb_result(colour(n,magnitude),computed);
        if(m>=deep_header->count){
            error=add_ext(error,shift_ext(add_ext(anorm,norm_ext(delta)),-48));
            delta=actual;dnorm=anorm;m=0;
        }else {
            /* The next iteration needs the same norm as this rebase test.
             * A rebase makes delta equal to actual, whose norm is already known. */
            dnorm=norm_ext(delta);
            if(less_ext(anorm,dnorm)){error=add_ext(error,shift_ext(dnorm,-47));delta=actual;dnorm=anorm;m=0;}
        }
    }
    return perturb_result(UINT32_C(0xff000000),computed);
}
static int prepare_local_reference_pass(unsigned tx,unsigned ty,unsigned width,unsigned height);
static int dd_perturbation_ready(void);
static int prepare_local_reference(unsigned tx,unsigned ty,unsigned width,unsigned height){
    reference_dd_enabled=0;
    int ready=prepare_local_reference_pass(tx,ty,width,height);
    reference_dd_enabled=1;reference_dd_fraction=fraction;
    return ready;
}
/* Repeat a local reference's fixed-point pass with the DD copy. The limb
 * centre, signs, footprint and precision are unchanged, so the orbit, margins
 * and count are reproduced bit for bit; BLA tables and series stay valid. */
static int rebuild_reference_dd(void){
    if(!reference_local || !reference_ready || fraction!=reference_dd_fraction)return 0;
    unsigned count=deep_header->count;
    deep_begin(cr_sign,ci_sign,spacing_extended.r,spacing_extended.e,reference_width,reference_height);
    while(!deep_reference(128)){}
    if(precision_needed || deep_header->count!=count){precision_needed=0;orbit_dd_error[0]=__builtin_inf();deep_header->count=count;return 0;}
    return dd_perturbation_ready();
}
#define PRECISE_SERIES_MIN_PIXELS 512
static int prepare_local_reference_pass(unsigned tx,unsigned ty,unsigned width,unsigned height){
    reference_x=tx;reference_y=ty;reference_width=width;reference_height=height;
    reference_origin_x=(double)tx+0.5*width;reference_origin_y=(double)ty+0.5*height;
    reference_local=1;reference_ready=0;reference_bounded=0;
    Extended r=ext(((double)tx+0.5*width-half_width)*spacing_extended.r,0,spacing_extended.e);
    Extended i=ext((half_height-(double)ty-0.5*height)*spacing_extended.r,0,spacing_extended.e);
    if(spacing_extended.e < -79){
        if((int64_t)fraction*32<54-(int64_t)spacing_extended.e){precision_needed=1;return 0;}
        pixel_offset_big(scratch[4],reference_origin_x-half_width);
        pixel_offset_big(scratch[5],half_height-reference_origin_y);
    }else{big_from_extended(scratch[4],r);big_from_extended(scratch[5],i);}
    int rs=sum_big(cr_big,frame_real,frame_rs,scratch[4],r.r<0?-1:1);
    int is=sum_big(ci_big,frame_imag,frame_is,scratch[5],i.r<0?-1:1);
    deep_begin(rs,is,spacing_extended.r,spacing_extended.e,width,height);
    ++deep_local_references;
    while(!deep_reference(128)){}
    if(precision_needed)return 0;
    reference_bounded=certify_black_reference(width,height);
    if(reference_bounded)series_start=0;
    else {
        /* Certified tiles return black immediately and need neither BLA
         * tables nor the DD fallback centre or colour-accurate prefix. */
        /* Measured setup-amortization guards, not mathematical restrictions:
         * small tiles and short reference orbits use the cheaper tight series.
         * With the faster pixel paths the DD prefix no longer pays at 256
         * pixels (32x8: cusp38 -27%, elefant -14%, branch29 -6% with the tight
         * series); from 1024 pixels it is equal or far better (cusp38 2-3x). */
        if((deep_options&DEEP_PRECISE_SERIES) && width*height>=PRECISE_SERIES_MIN_PIXELS && deep_header->count>=1024 && precise_series_domain()){
            /* Replay the same fixed orbit only after the inexpensive black
             * proof has failed. deep_begin preserves the reference centre,
             * output and counters; both passes count as actual reference work. */
            /* The replay recomputes bit-identical orbit and margin samples, so
               it can stop as soon as the DD prefix is finished. Restore the
               first pass's final orbit state; nothing after this reads limbs. */
            unsigned first_count=deep_header->count,first_iteration=reference_iteration;
            Extended first_error=reference_error;
            /* The replay covers only the prefix; keep the full orbit's DD bound. */
            double first_dd_error=orbit_dd_error[0];
            deep_begin(rs,is,spacing_extended.r,spacing_extended.e,width,height);
            prefix_dd_begin();
            while(prefix_dd_active && !deep_reference(128)){}
            if(precision_needed)return 0;
            deep_header->count=first_count;reference_iteration=first_iteration;reference_error=first_error;
            if(!(orbit_dd_error[0]>=first_dd_error))orbit_dd_error[0]=first_dd_error;
        }
        deep_finish();
        dd_real=big_dd(cr_big,cr_sign);dd_imag=big_dd(ci_big,ci_sign);
        prepare_series();
    }
    /* Record construction precision: later growth retains this reference's
     * original rounded centre rather than reconstructing it at higher bits. */
    reference_reuse_safe=(int64_t)fraction*32+spacing_extended.e>=32;
    reference_options=deep_options;reference_ready=1;return 1;
}
static int local_reference_contains(unsigned tx,unsigned ty,unsigned width,unsigned height){
    /* Test every pixel against the ORIGINAL reference disk, without enlarging
     * its series/BLA/certificate domain. Twice the corner coordinates and
     * radius are integers, so these comparisons need no rounded square root.
     * A gap of two squared units leaves >=1/(2*324) pixel of radial reserve,
     * well above the <2^-20 pixel floating-coordinate error. The construction
     * precision guard additionally limits limb truncation to <2^-30 pixel. */
    if(!reference_reuse_safe || !width || !height || !reference_width || reference_width>256 || !reference_height || reference_height>64)return 0;
    int64_t left=2*(int64_t)tx+1-2*(int64_t)reference_x-reference_width;
    int64_t top=2*(int64_t)ty+1-2*(int64_t)reference_y-reference_height;
    int64_t right=left+2*(int64_t)(width-1),bottom=top+2*(int64_t)(height-1);
    uint64_t dx=(uint64_t)(left<0?-left:left),dy=(uint64_t)(top<0?-top:top);
    uint64_t far_x=(uint64_t)(right<0?-right:right),far_y=(uint64_t)(bottom<0?-bottom:bottom);
    if(far_x>dx)dx=far_x;if(far_y>dy)dy=far_y;
    uint64_t radius=reference_width+reference_height+4;
    if(dx>=radius || dy>=radius)return 0;
    return dx*dx+dy*dy+2<=radius*radius;
}
static Extended pending_dc(unsigned index){
    double x=(double)(tile_x+index%tile_w)+0.5,y=(double)(tile_y+index/tile_w)+0.5;
    if(reference_local)return ext((x-reference_origin_x)*spacing_extended.r,(reference_origin_y-y)*spacing_extended.r,spacing_extended.e);
    return ext((x-half_width)*spacing_extended.r,(half_height-y)*spacing_extended.r,spacing_extended.e);
}
/* x*2^e for finite x, splitting large shifts. An underflowing result loses
 * less than 2^-1074 in absolute value; the result is 0 only below that. */
static inline double scale_two(double x,int e){
    while(e< -1000 && x){x*=0x1p-1000;e+=1000;}
    while(e>1000){x*=0x1p1000;e-=1000;}
    return x*power_two(e);
}
static inline int binary_exponent(double x){
    union{double f;uint64_t u;}b={.f=x};int e=(int)((b.u>>52)&2047);
    if(!e){b.f=x*0x1p64;return (int)((b.u>>52)&2047)-1023-64;}
    return e-1023;
}
/* a*2^e < b for a,b>=0, decided through exponents without overflow. */
static inline int scaled_less(double a,int e,double b){
    if(!(a>0))return b>0;
    if(!(b>0))return 0;
    int ea=binary_exponent(a),eb=binary_exponent(b);int64_t d=(int64_t)ea+e-eb;
    if(d< -2)return 1;
    if(d>2)return 0;
    return scale_two(a,-ea)*power_two((int)d)<scale_two(b,-eb);
}
/* Double-double perturbation (M4): the stage between the double/Extended
 * perturbation and the fixed-point orbit. The offset is t=T*2^E with a DD
 * mantissa T kept near 1 and a per-pixel exponent E, so it reaches any zoom.
 * The reference is the DD copy of the fixed-point state (orbit_dd).
 *
 * The bound is the one proved at perturb_pixel with other constants, all in
 * units of 2^E. dd_add errs by <128u^2 and dd_multiply by <256u^2 of their
 * operand sizes (see the precise prefix); the complex products, the square
 * and the two sums give <3000u^2(|a|+|b|+|dc|). The reference sample errs by
 * |zeta|<(32u^2+r)|Zs|, r=orbit_dd_error (outward bound of reference_error/|Z|),
 * so 2|zeta t|<(32u^2+r)|a|. The coefficient 2^-88+r=2^18u^2+r is more than
 * twice that. A rebase charges (2^-88+r)*2(|z|+|t|) for zeta and its sum.
 * The amplification uses |z| from high parts inflated by 2^-46, which covers
 * zeta and the dropped low parts (<6u|z| with |Zs|,|t|<=2.01|z|). Scaling by
 * powers of two is exact except for underflow, which loses <2^-1074 per
 * operation in units of 2^E; every step adds 2^-1060. A sample whose DD form
 * cannot hold 106 bits (exponent below -960) makes the pixel uncertain. The
 * bailout margin reuses perturb_margin with the exact Extended high parts;
 * its 2^-46|t| term covers the dropped low parts as well. */
static int dd_perturbation_ready(void){return deep_header->count && orbit_dd_error[0]<0x1p-90;}
static int dd_perturb_pixel(Extended dc,uint32_t *pixel){
    const double coefficient=0x1p-88+orbit_dd_error[0],tiny=0x1p-1060;
    const unsigned count=deep_header->count;
    int E=dc.e;
    DoubleDouble tr={0,0},ti={0,0};
    double cr=dc.r,ci=dc.i,cnorm=__builtin_sqrt(cr*cr+ci*ci)*(1+0x1p-50),error=0,znorm=0;
    unsigned n=0,m=0;
    ++deep_dd_perturb_pixels;
    while(n<limit){
        if(orbit[m].e< -960 && (orbit[m].r || orbit[m].i)){deep_dd_perturb_iterations+=n;return 2;}
        const double *Z=orbit_dd+4*m;
        DoubleDouble Zr={Z[0],Z[1]},Zi={Z[2],Z[3]};
        DoubleDouble ar=dd_add(dd_multiply(Zr,tr),dd_negative(dd_multiply(Zi,ti)));
        DoubleDouble ai=dd_add(dd_multiply(Zr,ti),dd_multiply(Zi,tr));
        ar.hi*=2;ar.lo*=2;ai.hi*=2;ai.lo*=2;
        DoubleDouble br=dd_add(dd_multiply(tr,tr),dd_negative(dd_multiply(ti,ti))),bi=dd_multiply(tr,ti);
        bi.hi*=2;bi.lo*=2;
        br.hi=scale_two(br.hi,E);br.lo=scale_two(br.lo,E);bi.hi=scale_two(bi.hi,E);bi.lo=scale_two(bi.lo,E);
        double na=__builtin_sqrt(ar.hi*ar.hi+ai.hi*ai.hi),nb=__builtin_sqrt(br.hi*br.hi+bi.hi*bi.hi);
        double amplification=2*znorm+scale_two(error,E)+0x1p-1070;
        error=(amplification*error+coefficient*((na+nb)+cnorm)*(1+0x1p-50))+tiny;
        tr=dd_add(dd_add(ar,br),(DoubleDouble){cr,0});ti=dd_add(dd_add(ai,bi),(DoubleDouble){ci,0});
        ++n;++m;
        Z=orbit_dd+4*m;
        double xr=Z[0]+scale_two(tr.hi,E),xi=Z[2]+scale_two(ti.hi,E);
        double magnitude=xr*xr+xi*xi,anorm=__builtin_sqrt(magnitude);
        znorm=anorm*(1+0x1p-46);
        if(!scaled_less(error,E,0x1p-30*anorm)){deep_dd_perturb_iterations+=n;return 2;}
        if(absd(magnitude-4)<1e-7){
            int escaped=perturb_margin(m,ext(tr.hi,ti.hi,E),ext(anorm*(1+0x1p-50),0,0),ext(error,0,E));
            if(escaped<0){deep_dd_perturb_iterations+=n;return 2;}
            if(escaped){*pixel=colour(n,magnitude);deep_dd_perturb_iterations+=n;return 1;}
        }else if(magnitude>4){*pixel=colour(n,magnitude);deep_dd_perturb_iterations+=n;return 1;}
        double tnorm=__builtin_sqrt(tr.hi*tr.hi+ti.hi*ti.hi);
        if(m>=count || scaled_less(anorm,-E,tnorm)){
            double scaled_z=scale_two(anorm,-E);
            error+=coefficient*2*(scaled_z+tnorm)*(1+0x1p-50);
            tr=dd_add((DoubleDouble){scale_two(Z[0],-E),scale_two(Z[1],-E)},tr);
            ti=dd_add((DoubleDouble){scale_two(Z[2],-E),scale_two(Z[3],-E)},ti);
            m=0;
        }
        double largest=absd(tr.hi)>absd(ti.hi)?absd(tr.hi):absd(ti.hi);
        if(largest>0x1p32 || (largest<0x1p-32 && largest>0)){
            int k=binary_exponent(largest);double s=power_two(-k);
            E+=k;tr.hi*=s;tr.lo=scale_two(tr.lo,-k);ti.hi*=s;ti.lo=scale_two(ti.lo,-k);
            error=scale_two(error,-k);
            cr=scale_two(dc.r,dc.e-E);ci=scale_two(dc.i,dc.e-E);
            cnorm=__builtin_sqrt(cr*cr+ci*ci)*(1+0x1p-50)+tiny;
        }
    }
    *pixel=UINT32_C(0xff000000);deep_dd_perturb_iterations+=n;return 1;
}
/* Resolve pending pixels by DD perturbation; compacts the uncertain ones. */
static unsigned dd_perturb_pending(uint16_t *list,unsigned count){
    unsigned remaining=0;
    for(unsigned k=0;k<count;++k){
        uint32_t pixel=0;unsigned index=list[k];
        if(dd_perturb_pixel(pending_dc(index),&pixel)==1)output[index]=pixel;
        else list[remaining++]=(uint16_t)index;
    }
    return remaining;
}
static unsigned finish_pending(void){
    for(;pending_position<pending_count;++pending_position){
        unsigned index=pending[pending_position];
        uint32_t pixel=fixed_pixel(pending_dc(index));
        if(precision_needed)return 0;
        output[index]=pixel;
    }
    pending_count=pending_position=0;tile_phase=0;
    return tile_w*tile_h*4;
}
/* The real segment [-2,1/4] lies in the Mandelbrot set: a real c keeps a real
 * orbit, and on that segment it stays in [-2,2]. A pixel row whose grid points
 * are exactly real (odd heights through a real centre, or an axis row after
 * alignAxis) is therefore black, as fixed_pixel already
 * proves with limbs. Deciding it here avoids its local reference: centred on
 * the axis, that real orbit is chaotic near c=-2 and needs about one more bit
 * per iteration (measured: 200 precision retries, 13 000 bits, ~55 s for one
 * 256x1 tile). The pixel row offset is an exact half-integer difference and
 * the frame imaginary limbs are exactly zero, so c is exactly real. Its real
 * part is a rounded double within 16u(|a|+|s|)<2^-47 (certified_interior);
 * the 2^-40 margin keeps every accepted point strictly inside the segment. */
static inline int real_axis_interior(double real){return real>-2+0x1p-40 && real<0.25-0x1p-40;}
/* Is the frame-grid row exactly on the real axis? The grid imaginary part is
 * frame_imag + offset*spacing with a half-integer offset; compare it in limbs.
 * This also covers views snapped by alignAxis, whose axis row is off-centre.
 * pixel_offset_big is exact when the limbs hold the spacing's 53 bits. */
static int exact_axis_row(unsigned row){
    double offset=half_height-(double)row-0.5;
    if(!offset)return frame_on_axis;
    if(frame_on_axis || (int64_t)fraction*32<54-(int64_t)spacing_extended.e || (offset<0?-1:1)==frame_is)return 0;
    pixel_offset_big(scratch[5],offset);
    return !compare_big(scratch[5],frame_imag);
}
static unsigned render_deep_tile(unsigned tx,unsigned ty,unsigned width,unsigned height,int resume){
    if(!frame_width || !width || !height || width>256 || height>64 || width>frame_width || height>frame_height ||
       tx>frame_width-width || ty>frame_height-height)return 0;
    if(resume){if(!tile_active || tx!=tile_x || ty!=tile_y || width!=tile_w || height!=tile_h)return 0;}
    else {tile_x=tx;tile_y=ty;tile_w=width;tile_h=height;tile_completed=0;tile_active=1;pending_count=pending_position=tile_phase=queue_count=0;}
    deep_reset_stats();precision_needed=0;
    if(tile_phase)return finish_pending();
    /* Deferral needs one fixed dc per pixel: adaptive references may move the
     * reference within a tile, and fixed_pixel's frame-grid reconstruction
     * reads the in-order tile position. Both occur only with that option. */
    const int defer=!(deep_options&DEEP_ADAPTIVE_REFERENCE);
    /* With deferral, double-path pixels are queued for the interleaved kernel. */
    const int batch=defer && (deep_options&DEEP_DOUBLE_PERTURB) && spacing_extended.e>=DOUBLE_PERTURB_MIN_EXPONENT;
    int local=spacing_extended.e>=-79;
    /* configure invalidates reference_local on every frame. Precision growth
     * preserves its exact centre, orbit and all certified bounds; incomplete
     * reference builds remain ineligible until their retry succeeds. */
    if((deep_options&DEEP_REUSE_REFERENCE) && reference_local && reference_ready && reference_options!=deep_options)
        reference_ready=0;
    int cached=(deep_options&DEEP_REUSE_REFERENCE) && reference_local && reference_ready && reference_options==deep_options;
    int prepared=cached && local_reference_contains(tx,ty,width,height);
    unsigned rebases=0;
    if(!cached){series_start=0;reference_bounded=0;}
    if(prepared && reference_bounded){
        for(unsigned index=tile_completed;index<width*height;++index)output[index]=UINT32_C(0xff000000);
        deep_certified_pixels+=width*height-tile_completed;tile_completed=width*height;
        return width*height*4;
    }
    if(!local && reference_local && !reference_ready){
        if(!prepare_local_reference(reference_x,reference_y,reference_width,reference_height))return 0;
    }
    if(local && !prepared && !(deep_options&DEEP_LAZY_REFERENCE)){
        if(!prepare_local_reference(tx,ty,width,height))return 0;
        prepared=1;
        if(reference_bounded){
            for(unsigned index=tile_completed;index<width*height;++index)output[index]=UINT32_C(0xff000000);
            deep_certified_pixels+=width*height-tile_completed;tile_completed=width*height;
            return width*height*4;
        }
    }
    unsigned x=tile_completed%width,y=tile_completed/width;
    /* Only rows within a pixel of the axis can be exactly real. */
    const int axis_possible=frame_on_axis || absd(centre_imag)<=(half_height+1)*normal_double(spacing_extended);
    int axis_row=axis_possible && exact_axis_row(ty+y);
    for(unsigned index=tile_completed;index<width*height;++index){
        Extended dc=ext(((double)(tx+x)+0.5-half_width)*spacing_extended.r,
            (half_height-(double)(ty+y)-0.5)*spacing_extended.r,spacing_extended.e);
        uint32_t pixel;
        if(known_interior(centre_real+dc.r*power_two(dc.e),centre_imag+dc.i*power_two(dc.e)) ||
           (axis_row && real_axis_interior(centre_real+dc.r*power_two(dc.e))))
            pixel=UINT32_C(0xff000000);
        else {
            if(local && !prepared){
                if(!prepare_local_reference(tx,ty,width,height))return 0;prepared=1;
                if(reference_bounded){
                    for(unsigned remaining=index;remaining<width*height;++remaining)output[remaining]=UINT32_C(0xff000000);
                    deep_certified_pixels+=width*height-index;tile_completed=width*height;
                    return width*height*4;
                }
            }
            if(batch && prepare_orbit_double()){
                perturb_queue[queue_count++]=(uint16_t)index;tile_completed=index+1;
                if(++x==width){x=0;++y;}
                continue;
            }
            for(;;){
                if(reference_local)dc=ext(((double)(tx+x)+0.5-reference_origin_x)*spacing_extended.r,
                    (reference_origin_y-(double)(ty+y)-0.5)*spacing_extended.r,spacing_extended.e);
                unsigned rx=tx+(x/32)*32,ry=ty+(y/8)*8;
                unsigned rw=tx+width-rx<32?tx+width-rx:32,rh=ty+height-ry<8?ty+height-ry:8;
                allow_reference=!local && (deep_options&DEEP_ADAPTIVE_REFERENCE) && rebases<4 &&
                    (!reference_local || reference_x!=rx || reference_y!=ry || reference_width!=rw || reference_height!=rh);
                request_reference=0;pixel_deferred=0;defer_precise=defer;
                pixel=perturb_pixel(dc);allow_reference=0;defer_precise=0;
                if(pixel_deferred)pending[pending_count++]=(uint16_t)index;
                if(precision_needed)return 0;
                if(!request_reference)break;
                ++rebases;
                if(!prepare_local_reference(rx,ry,rw,rh))return 0;
            }
        }
        output[index]=pixel;tile_completed=index+1;
        if(++x==width){x=0;++y;axis_row=axis_possible && y<height && exact_axis_row(ty+y);}
    }
    if(queue_count){perturb_batch(perturb_queue,queue_count);queue_count=0;}
    if(!pending_count)return width*height*4;
    if(dd_fallback_useful())pending_count=dd_batch(pending,pending_count);
    if(pending_count && (deep_options&DEEP_DD_PERTURB) && (dd_perturbation_ready() || rebuild_reference_dd()))
        pending_count=dd_perturb_pending(pending,pending_count);
    pending_position=0;tile_phase=1;
    return finish_pending();
}
unsigned deep_render_tile(unsigned tx,unsigned ty,unsigned width,unsigned height){return render_deep_tile(tx,ty,width,height,0);}
unsigned deep_render_tile_resume(unsigned tx,unsigned ty,unsigned width,unsigned height){return render_deep_tile(tx,ty,width,height,1);}
unsigned deep_tile_completed_pixels(void){return tile_completed;}
double deep_stat_skipped(void){return (double)deep_skipped;}
unsigned deep_stat_fallbacks(void){return deep_fallbacks;}
double deep_stat_dd_fallbacks(void){return (double)deep_dd_fallbacks;}
double deep_stat_dd_iterations(void){return (double)deep_dd_iterations;}
double deep_stat_fixed_iterations(void){return (double)deep_fixed_iterations;}
double deep_stat_reference_iterations(void){return (double)deep_reference_iterations;}
double deep_stat_local_references(void){return (double)deep_local_references;}
double deep_stat_perturb_iterations(void){return (double)deep_perturb_iterations;}
double deep_stat_certified_pixels(void){return (double)deep_certified_pixels;}
double deep_stat_certificate_iterations(void){return (double)deep_certificate_iterations;}
double deep_stat_dd_perturb_iterations(void){return (double)deep_dd_perturb_iterations;}
double deep_stat_dd_perturb_pixels(void){return (double)deep_dd_perturb_pixels;}
