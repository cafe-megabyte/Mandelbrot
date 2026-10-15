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
static int frame_rs, frame_is;
static unsigned checkpoint_iteration;
static int checkpoint_rs, checkpoint_is;
static int cr_sign, ci_sign, xr_sign, xi_sign;
static DeepHeader *deep_header;
static Extended *orbit;
static Extended *bailout_margin;
static Approximation *approximations;
static Extended spacing_extended, image_radius;
static uint64_t deep_skipped;
static unsigned deep_fallbacks;
enum { DEEP_SQUARE=1, DEEP_LAZY_REFERENCE=2, DEEP_BLA_ONE=4,
       DEEP_SERIES_NORMS=8, DEEP_ADAPTIVE_REFERENCE=16, DEEP_RESCALED=32,
       DEEP_DD_CACHE=64, DEEP_SIMD=128, DEEP_KARATSUBA=256, DEEP_BLACK_CERTIFICATE=512,
       DEEP_PRECISE_SERIES=1024, DEEP_REUSE_REFERENCE=2048, DEEP_TIGHT_SERIES=4096 };
static unsigned deep_options=DEEP_SQUARE|DEEP_LAZY_REFERENCE|DEEP_SERIES_NORMS|DEEP_KARATSUBA|DEEP_BLACK_CERTIFICATE|DEEP_PRECISE_SERIES|DEEP_REUSE_REFERENCE;
static uint64_t deep_dd_fallbacks, deep_dd_iterations, deep_fixed_iterations;
static uint64_t deep_reference_iterations, deep_local_references, deep_perturb_iterations;
static uint64_t deep_certified_pixels, deep_certificate_iterations;
static int reference_bounded;
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
static void prefix_dd_begin(void);
static void prefix_dd_before(void);
static void prefix_dd_after(void);

unsigned deep_default_options(void){return DEEP_SQUARE|DEEP_LAZY_REFERENCE|DEEP_SERIES_NORMS|DEEP_KARATSUBA|DEEP_BLACK_CERTIFICATE|DEEP_PRECISE_SERIES|DEEP_REUSE_REFERENCE;}
void deep_set_options(unsigned options){deep_options=options;}
void deep_reset_stats(void){
    deep_skipped=deep_fallbacks=0;
    deep_dd_fallbacks=deep_dd_iterations=deep_fixed_iterations=0;
    deep_reference_iterations=deep_local_references=deep_perturb_iterations=0;
    deep_certified_pixels=deep_certificate_iterations=0;
}

static inline double absd(double x) { return x < 0 ? -x : x; }
static inline double power_two(int e) {
    union { uint64_t u; double f; } v;
    if (e < -1074) return 0;
    if (e < -1022) { v.u = UINT64_C(1) << (e + 1074); return v.f; }
    if (e > 1023) return __builtin_inf();
    v.u = (uint64_t)(e + 1023) << 52; return v.f;
}
static inline Extended ext(double r, double i, int e) {
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
static void map_arena(size_t data,unsigned iterations){
    deep_header=(DeepHeader *)arena;
    orbit=(Extended *)(arena+sizeof(DeepHeader));
    bailout_margin=orbit+iterations+1;
    approximations=(Approximation *)(bailout_margin+iterations+1);
    cr_big=(uint32_t *)(arena+data);ci_big=cr_big+digits;
    xr_big=ci_big+digits;xi_big=xr_big+digits;
    for(unsigned k=0;k<8;++k)scratch[k]=xi_big+(k+1)*digits;
    product=scratch[7]+digits;
    checkpoint_real=product+2*digits;checkpoint_imag=checkpoint_real+digits;
    frame_real=checkpoint_imag+digits;frame_imag=frame_real+digits;
}
unsigned deep_allocate(unsigned bits, unsigned iterations) {
    if (bits < 64 || bits > INT32_MAX-64 || !iterations || iterations > INT32_MAX-64) return 0;
    prefix_dd_active=prefix_dd_used=0;
    fraction = (bits+31)/32; digits = fraction+1; reference_limit = iterations;
    size_t count = 0;
    for (unsigned n=iterations/16; n; n/=2) count += n;
    uint64_t data64 = sizeof(DeepHeader)+(uint64_t)(iterations+1)*2*sizeof(Extended)+(uint64_t)count*sizeof(Approximation);
    uint64_t needed64 = data64+(uint64_t)digits*18*sizeof(uint32_t);
    if (needed64 > UINT32_MAX-65536u || !reserve_arena((size_t)needed64)) return 0;
    size_t data=(size_t)data64;
    map_arena(data,iterations);deep_header->count=deep_header->levels=0;tile_active=0;
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
unsigned deep_data_size(void) {
    size_t count=0;for(unsigned n=reference_limit/16;n;n/=2)count+=n;
    return (unsigned)(sizeof(DeepHeader)+(size_t)(reference_limit+1)*2*sizeof(Extended)+count*sizeof(Approximation));
}
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
    fraction=next_fraction;digits=next_digits;map_arena(data,reference_limit);
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
static void multiply_words(uint32_t *out,const uint32_t *a,const uint32_t *b,unsigned n,uint32_t *work){
    if(n<32 || (n&1)){
        for(unsigned j=0;j<2*n;++j)out[j]=0;
        for(unsigned j=0;j<n;++j){
            uint64_t carry=0;
            for(unsigned k=0;k<n;++k){uint64_t value=(uint64_t)a[j]*b[k]+out[j+k]+carry;out[j+k]=(uint32_t)value;carry=value>>32;}
            out[j+n]=(uint32_t)carry;
        }
        return;
    }
    unsigned half=n/2;int as=1,bs=1;
    for(unsigned j=half;j--;)if(a[half+j]!=a[j]){as=a[half+j]>a[j]?1:-1;break;}
    for(unsigned j=half;j--;)if(b[j]!=b[half+j]){bs=b[j]>b[half+j]?1:-1;break;}
    uint64_t borrow_a=0,borrow_b=0;
    for(unsigned j=0;j<half;++j){
        uint64_t av=as>0?a[half+j]:a[j],bv=(uint64_t)(as>0?a[j]:a[half+j])+borrow_a;
        work[j]=(uint32_t)(av-bv);borrow_a=av<bv;
        av=bs>0?b[j]:b[half+j];bv=(uint64_t)(bs>0?b[half+j]:b[j])+borrow_b;
        work[half+j]=(uint32_t)(av-bv);borrow_b=av<bv;
    }
    /* Compute the signed difference product first, temporarily in the middle
       of the output. Retain it in the first half of the existing workspace;
       the second half is enough scratch for both recursive half products. */
    multiply_words(out+half,work,work+half,half,work+n);
    for(unsigned j=0;j<n;++j)work[j]=out[half+j];
    multiply_words(out,a,b,half,work+n);
    multiply_words(out+n,a+half,b+half,half,work+n);
    int64_t carry=0;
    for(unsigned j=0;j<n;++j){
        int64_t value=(int64_t)out[j]+out[n+j]+(as==bs?(int64_t)work[j]:-(int64_t)work[j])+carry;
        work[n+j]=(uint32_t)value;carry=value<0?-1:value>>32;
    }
    uint64_t addition=0;
    for(unsigned j=0;j<n;++j){uint64_t value=(uint64_t)out[half+j]+work[n+j]+addition;out[half+j]=(uint32_t)value;addition=value>>32;}
    addition+=(uint64_t)carry;
    for(unsigned j=half+n;addition && j<2*n;++j){addition+=out[j];out[j]=(uint32_t)addition;addition>>=32;}
}
static void multiply_big(uint32_t *out,const uint32_t *a,const uint32_t *b) {
    if((deep_options&DEEP_KARATSUBA) && digits>=32 && !(digits&1)){
        /* scratch[4:6] is dead during orbit multiplication: fixed_pixel has
           already copied its coordinate into scratch[6] and scratch[7]. */
        multiply_words(product,a,b,digits,scratch[4]);
    }else{
    for(unsigned j=0;j<2*digits;++j)product[j]=0;
    for(unsigned j=0;j<digits;++j){
        uint64_t carry=0;
        for(unsigned k=0;k<digits;++k){uint64_t v=(uint64_t)a[j]*b[k]+product[j+k]+carry;product[j+k]=(uint32_t)v;carry=v>>32;}
        product[j+digits]=(uint32_t)carry;
    }
    }
    for(unsigned j=0;j<digits;++j)out[j]=product[j+fraction];
    for(unsigned j=0;j<fraction;++j)if(product[j]){rounded_product=1;break;}
}
/* Accumulate each off-diagonal product once, double the complete result, then
 * add the diagonal. All carries use at most 64 bits; unlike doubling a single
 * 32x32 product this never needs an overflowing 65-bit temporary. The existing
 * product workspace and exactly the same truncation rule are reused. */
static void square_big(uint32_t *out,const uint32_t *a){
    if(!(deep_options&DEEP_SQUARE)){multiply_big(out,a,a);return;}
    for(unsigned j=0;j<2*digits;++j)product[j]=0;
    for(unsigned j=0;j<digits;++j){
        uint64_t carry=0;
        for(unsigned k=j+1;k<digits;++k){
            uint64_t value=(uint64_t)a[j]*a[k]+product[j+k]+carry;
            product[j+k]=(uint32_t)value;carry=value>>32;
        }
        product[j+digits]=(uint32_t)carry;
    }
    uint32_t bit=0;
    for(unsigned j=0;j<2*digits;++j){uint32_t next=product[j]>>31;product[j]=(product[j]<<1)|bit;bit=next;}
    uint64_t carry=0;
    for(unsigned j=0;j<digits;++j){
        uint64_t diagonal=(uint64_t)a[j]*a[j];
        uint64_t low=(uint64_t)product[2*j]+(uint32_t)diagonal+carry;
        product[2*j]=(uint32_t)low;
        uint64_t high=(uint64_t)product[2*j+1]+(diagonal>>32)+(low>>32);
        product[2*j+1]=(uint32_t)high;carry=high>>32;
    }
    for(unsigned j=0;j<digits;++j)out[j]=product[j+fraction];
    for(unsigned j=0;j<fraction;++j)if(product[j]){rounded_product=1;break;}
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
    prefix_dd_active=prefix_dd_used=0;
    cr_sign=real_sign;ci_sign=imag_sign;xr_sign=xi_sign=1;
    clear_big(xr_big);clear_big(xi_big);orbit[0]=(Extended){0};reference_iteration=0;
    reference_error=(Extended){0};precision_needed=0;
    bailout_margin[0]=ext(-4,0,0);
    clear_big(checkpoint_real);clear_big(checkpoint_imag);checkpoint_iteration=0;checkpoint_rs=checkpoint_is=1;
    spacing_extended=ext(spacing,0,exponent);
    image_radius=scale_ext(spacing_extended,0.5*(width+height)+2);
    return 1;
}
unsigned deep_reference(unsigned batch) {
    unsigned computed=0;
    unsigned end=reference_iteration+batch;
    if(end<reference_iteration || end>reference_limit)end=reference_limit;
    while(reference_iteration<end){
        Extended previous_norm=norm_ext(orbit[reference_iteration]);rounded_product=0;
        if(prefix_dd_active)prefix_dd_before();
        orbit_step(cr_big,cr_sign,ci_big,ci_sign);++computed;
        Extended z=current_big();orbit[++reference_iteration]=z;
        if(prefix_dd_active)prefix_dd_after();
        reference_error=mul_ext(add_ext(scale_ext(previous_norm,2),reference_error),reference_error);
        if(rounded_product)reference_error=add_ext(reference_error,ext(4,0,-32*(int)fraction));
        if(reference_error.r && !less_ext(reference_error,mul_ext(norm_ext(z),ext(1,0,-64)))){
            precision_needed=1;break;
        }
        double magnitude=escape_magnitude(z);
        bailout_margin[reference_iteration]=absd(magnitude-4)<1e-10?precise_margin():ext(magnitude-4,0,0);
        if(bailout_margin[reference_iteration].r>0)break;
        if(!(reference_iteration%16)){
            if(!reference_error.r && xr_sign==checkpoint_rs && xi_sign==checkpoint_is && !compare_big(xr_big,checkpoint_real) && !compare_big(xi_big,checkpoint_imag)){
                unsigned period=reference_iteration-checkpoint_iteration;
                for(unsigned j=reference_iteration+1;j<=reference_limit;++j){
                    unsigned source=checkpoint_iteration+(j-checkpoint_iteration)%period;
                    orbit[j]=orbit[source];bailout_margin[j]=bailout_margin[source];
                }
                reference_iteration=reference_limit;break;
            }
            copy_big(checkpoint_real,xr_big);copy_big(checkpoint_imag,xi_big);
            checkpoint_iteration=reference_iteration;checkpoint_rs=xr_sign;checkpoint_is=xi_sign;
        }
    }
    deep_header->count=reference_iteration;
    deep_reference_iterations+=computed;
    return precision_needed || reference_iteration==reference_limit || bailout_margin[reference_iteration].r>0;
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
typedef struct { double hi, lo; } DoubleDouble;
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
        x=dd_add(dd_add(xx,dd_negative(yy)),cr);y=dd_add(dd_add(xy,xy),ci);
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
static PrefixComplex prefix_product(PrefixComplex a,PrefixComplex b){
 return (PrefixComplex){dd_add(dd_multiply(a.r,b.r),dd_negative(dd_multiply(a.i,b.i))),
  dd_add(dd_multiply(a.r,b.i),dd_multiply(a.i,b.r))};
}
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
 for(unsigned j=0;j<8;++j)for(unsigned k=0;k<8;++k)if(j+k+2>8)O=certificate_add(O,certificate_multiply(norms[j],norms[k]));
 double linear=certificate_multiply(2,M),ops=certificate_add(certificate_add(certificate_multiply(linear,S),certificate_multiply(S,S)),R);
 double rho=certificate_multiply(4,analytic_up(power_two(-32*(int)fraction)));
 prefix_dd_error=certificate_add(certificate_add(certificate_multiply(certificate_add(certificate_add(linear,certificate_multiply(2,S)),prefix_dd_error),prefix_dd_error),O),
  certificate_add(certificate_add(certificate_multiply(0x1p-90,ops),rho),0x1p-500));
 PrefixComplex z={big_dd(xr_big,xr_sign),big_dd(xi_big,xi_sign)};
 if(!prefix_component_valid(z.r) || !prefix_component_valid(z.i)){prefix_dd_active=0;return;}
 z.r.hi*=2;z.r.lo*=2;z.i.hi*=2;z.i.lo*=2;
 for(unsigned k=8;k--;){
  PrefixComplex next=prefix_product(z,prefix_dd[k]);
  if(!k)next.r=dd_add(next.r,(DoubleDouble){R,0});
  for(unsigned j=0;j<k;++j){PrefixComplex product=prefix_product(prefix_dd[j],prefix_dd[k-1-j]);next.r=dd_add(next.r,product.r);next.i=dd_add(next.i,product.i);}
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
static uint32_t precise_pixel(Extended dc) {
    if(spacing_extended.e>=-80){int certain=1;uint32_t pixel=dd_pixel(dc,&certain);if(certain)return pixel;}
    return fixed_pixel(dc);
}
static uint32_t uncertain_pixel(Extended dc){
    if(allow_reference){request_reference=1;return 0;}
    return precise_pixel(dc);
}
static inline uint32_t perturb_result(uint32_t pixel,unsigned iterations){deep_perturb_iterations+=iterations;return pixel;}
static uint32_t perturb_pixel(Extended dc) {
    Extended delta={0},error={0};unsigned n=0,m=0,computed=0;
    const Extended cnorm=norm_ext(dc);
    const int within_reference_radius=!less_ext(image_radius,cnorm);
    if(series_start && within_reference_radius){
        Extended t=ext(dc.r/series_radius.r,dc.i/series_radius.r,dc.e-series_radius.e);
        delta=series_coefficients[7];
        for(unsigned k=7;k--;)delta=add_ext(mul_ext(delta,t),series_coefficients[k]);
        delta=mul_ext(delta,t);error=series_error;n=m=series_start;deep_skipped+=series_start;
    }
    Extended dnorm=norm_ext(delta);
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
            Extended zref=norm_ext(orbit[m]);
            Extended a=perturb_mul_ext(shift_ext(orbit[m],1),delta),b=perturb_mul_ext(delta,delta);
            Extended amplification=add_ext(shift_ext(add_ext(zref,dnorm),1),error);
            error=add_ext(mul_ext(amplification,error),shift_ext(add_ext(add_ext(norm_ext(a),norm_ext(b)),cnorm),-48));
            delta=add_three_ext(a,b,dc);++n;++m;
        }
        Extended actual=add_ext(orbit[m],delta),anorm=norm_ext(actual);
        if(!less_ext(error,shift_ext(anorm,-30)) && error.r)return perturb_result(uncertain_pixel(dc),computed);
        double magnitude=escape_magnitude(actual);
        if(absd(magnitude-4)<1e-7){
            Extended cross=mul_ext(orbit[m],(Extended){delta.r,-delta.i,delta.e,0});cross.i=0;
            Extended square=ext(delta.r*delta.r+delta.i*delta.i,0,2*delta.e);
            /* Clearing cross.i can remove its normalizing component. */
            Extended margin=add_ext(bailout_margin[m],add_ext(scale_ext(cross,2),square));
            Extended uncertainty=mul_ext(error,add_ext(shift_ext(anorm,1),error));
            if(!less_ext(uncertainty,norm_ext(margin)) && (uncertainty.r||margin.r))return perturb_result(uncertain_pixel(dc),computed);
            if(margin.r>0)return perturb_result(colour(n,magnitude),computed);
        }else if(magnitude>4)return perturb_result(colour(n,magnitude),computed);
        if(m>=deep_header->count){delta=actual;dnorm=anorm;m=0;}
        else {
            /* The next iteration needs the same norm as this rebase test.
             * A rebase makes delta equal to actual, whose norm is already known. */
            dnorm=norm_ext(delta);
            if(less_ext(anorm,dnorm)){delta=actual;dnorm=anorm;m=0;}
        }
    }
    return perturb_result(UINT32_C(0xff000000),computed);
}
static int prepare_local_reference(unsigned tx,unsigned ty,unsigned width,unsigned height){
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
         * small tiles and short reference orbits use the cheaper tight series. */
        if((deep_options&DEEP_PRECISE_SERIES) && width*height>=128 && deep_header->count>=1024 && precise_series_domain()){
            /* Replay the same fixed orbit only after the inexpensive black
             * proof has failed. deep_begin preserves the reference centre,
             * output and counters; both passes count as actual reference work. */
            deep_begin(rs,is,spacing_extended.r,spacing_extended.e,width,height);
            prefix_dd_begin();
            while(!deep_reference(128)){}
            if(precision_needed)return 0;
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
static unsigned render_deep_tile(unsigned tx,unsigned ty,unsigned width,unsigned height,int resume){
    if(!frame_width || !width || !height || width>256 || height>64 || width>frame_width || height>frame_height ||
       tx>frame_width-width || ty>frame_height-height)return 0;
    if(resume){if(!tile_active || tx!=tile_x || ty!=tile_y || width!=tile_w || height!=tile_h)return 0;}
    else {tile_x=tx;tile_y=ty;tile_w=width;tile_h=height;tile_completed=0;tile_active=1;}
    deep_reset_stats();precision_needed=0;
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
    for(unsigned index=tile_completed;index<width*height;++index){
        Extended dc=ext(((double)(tx+x)+0.5-half_width)*spacing_extended.r,
            (half_height-(double)(ty+y)-0.5)*spacing_extended.r,spacing_extended.e);
        uint32_t pixel;
        if(known_interior(centre_real+dc.r*power_two(dc.e),centre_imag+dc.i*power_two(dc.e)))
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
            for(;;){
                if(reference_local)dc=ext(((double)(tx+x)+0.5-reference_origin_x)*spacing_extended.r,
                    (reference_origin_y-(double)(ty+y)-0.5)*spacing_extended.r,spacing_extended.e);
                unsigned rx=tx+(x/32)*32,ry=ty+(y/8)*8;
                unsigned rw=tx+width-rx<32?tx+width-rx:32,rh=ty+height-ry<8?ty+height-ry:8;
                allow_reference=!local && (deep_options&DEEP_ADAPTIVE_REFERENCE) && rebases<4 &&
                    (!reference_local || reference_x!=rx || reference_y!=ry || reference_width!=rw || reference_height!=rh);
                request_reference=0;pixel=perturb_pixel(dc);allow_reference=0;
                if(precision_needed)return 0;
                if(!request_reference)break;
                ++rebases;
                if(!prepare_local_reference(rx,ry,rw,rh))return 0;
            }
        }
        output[index]=pixel;tile_completed=index+1;
        if(++x==width){x=0;++y;}
    }
    return width*height*4;
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
