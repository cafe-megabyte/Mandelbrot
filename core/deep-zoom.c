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
static unsigned deep_skipped, deep_fallbacks;
static Extended series_coefficients[8], series_error, series_radius;
static unsigned series_start;
static Extended reference_error;
static unsigned precision_needed;
static int rounded_product;

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
static inline Extended scale_ext(Extended a, double s) { return ext(a.r*s,a.i*s,a.e); }
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
unsigned deep_allocate(unsigned bits, unsigned iterations) {
    if (bits < 64 || bits > INT32_MAX-64 || !iterations || iterations > INT32_MAX-64) return 0;
    fraction = (bits+31)/32; digits = fraction+1; reference_limit = iterations;
    size_t count = 0;
    for (unsigned n=iterations/16; n; n/=2) count += n;
    uint64_t data64 = sizeof(DeepHeader)+(uint64_t)(iterations+1)*2*sizeof(Extended)+(uint64_t)count*sizeof(Approximation);
    uint64_t needed64 = data64+(uint64_t)digits*18*sizeof(uint32_t);
    if (needed64 > UINT32_MAX-65536u || !reserve_arena((size_t)needed64)) return 0;
    size_t data=(size_t)data64;
    deep_header = (DeepHeader *)arena; deep_header->count = 0; deep_header->levels = 0;
    orbit = (Extended *)(arena+sizeof(DeepHeader));
    bailout_margin=orbit+iterations+1;
    approximations = (Approximation *)(bailout_margin+iterations+1);
    unsigned offset=0;
    for (unsigned n=iterations/16; n; n/=2) {
        unsigned level=deep_header->levels++;
        deep_header->offset[level]=offset; deep_header->length[level]=n; offset+=n;
    }
    cr_big=(uint32_t *)(arena+data); ci_big=cr_big+digits;
    xr_big=ci_big+digits; xi_big=xr_big+digits;
    for (unsigned k=0;k<8;++k) scratch[k]=xi_big+(k+1)*digits;
    product=scratch[7]+digits;
    checkpoint_real=product+2*digits;checkpoint_imag=checkpoint_real+digits;
    frame_real=checkpoint_imag+digits;frame_imag=frame_real+digits;
    return 1;
}
unsigned deep_input_address(void) { return (unsigned)(uintptr_t)cr_big; }
unsigned deep_digits(void) { return digits; }
unsigned deep_data_address(void) { return (unsigned)(uintptr_t)arena; }
unsigned deep_data_size(void) {
    size_t count=0;for(unsigned n=reference_limit/16;n;n/=2)count+=n;
    return (unsigned)(sizeof(DeepHeader)+(size_t)(reference_limit+1)*2*sizeof(Extended)+count*sizeof(Approximation));
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
static void multiply_big(uint32_t *out,const uint32_t *a,const uint32_t *b) {
    for(unsigned j=0;j<2*digits;++j)product[j]=0;
    for(unsigned j=0;j<digits;++j){
        uint64_t carry=0;
        for(unsigned k=0;k<digits;++k){uint64_t v=(uint64_t)a[j]*b[k]+product[j+k]+carry;product[j+k]=(uint32_t)v;carry=v>>32;}
        product[j+digits]=(uint32_t)carry;
    }
    for(unsigned j=0;j<digits;++j)out[j]=product[j+fraction];
    for(unsigned j=0;j<fraction;++j)if(product[j]){rounded_product=1;break;}
}
static Extended big_extended(const uint32_t *a,int sign) {
    unsigned j=digits;while(j && !a[j-1])--j;
    if(!j)return (Extended){0};
    double value=a[j-1];if(j>1)value+=a[j-2]*0x1p-32;
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
static void orbit_step(const uint32_t *real,int sr,const uint32_t *imag,int si) {
    multiply_big(scratch[0],xr_big,xr_big);multiply_big(scratch[1],xi_big,xi_big);
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
    multiply_big(scratch[0],xr_big,xr_big);multiply_big(scratch[1],xi_big,xi_big);
    sum_big(scratch[2],scratch[0],1,scratch[1],1);
    clear_big(scratch[3]);scratch[3][fraction]=4;
    int sign=sum_big(scratch[0],scratch[2],1,scratch[3],-1);
    return big_extended(scratch[0],sign);
}
unsigned deep_begin(int real_sign,int imag_sign,double spacing,int exponent,unsigned width,unsigned height) {
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
    unsigned end=reference_iteration+batch;
    if(end<reference_iteration || end>reference_limit)end=reference_limit;
    while(reference_iteration<end){
        Extended previous_norm=norm_ext(orbit[reference_iteration]);rounded_product=0;
        orbit_step(cr_big,cr_sign,ci_big,ci_sign);
        Extended z=current_big();orbit[++reference_iteration]=z;
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
    return precision_needed || reference_iteration==reference_limit || bailout_margin[reference_iteration].r>0;
}
unsigned deep_needs_precision(void){return precision_needed;}
static Approximation single_bla(unsigned n) {
    Extended a=scale_ext(orbit[n],2),radius=norm_ext(a);radius.e-=40;
    Extended z=orbit[n+1];
    double gap=2-__builtin_sqrt(escape_magnitude(z));
    Extended safe=gap>0?divide_positive(ext(gap*0.25,0,0),add_ext(norm_ext(a),ext(1,0,0))):(Extended){0};
    if(less_ext(safe,radius))radius=safe;
    if(!less_ext(image_radius,ext(gap*0.25,0,0)))radius=(Extended){0};
    return (Approximation){a,ext(1,0,0),ext(1,0,0),radius,1,0};
}
static Approximation merge_bla(Approximation x,Approximation y) {
    Extended ax=norm_ext(x.a),bx=norm_ext(x.b);
    Extended constant=add_ext(mul_ext(bx,image_radius),mul_ext(x.q,mul_ext(image_radius,image_radius)));
    Extended denominator=add_ext(ax,mul_ext(x.q,add_ext(scale_ext(image_radius,2),x.radius)));
    Extended radius=divide_positive(subtract_positive(y.radius,constant),denominator);
    if(less_ext(x.radius,radius))radius=x.radius;
    Extended k=add_ext(add_ext(ax,bx),add_ext(ext(1,0,0),mul_ext(x.q,add_ext(radius,image_radius))));
    Extended q=add_ext(mul_ext(norm_ext(y.a),x.q),mul_ext(y.q,mul_ext(k,k)));
    return (Approximation){mul_ext(y.a,x.a),add_ext(mul_ext(y.a,x.b),y.b),q,radius,x.steps+y.steps,0};
}
unsigned deep_finish(void) {
    unsigned count=deep_header->count;
    if(!deep_header->levels)return count;
    for(unsigned j=0;j<deep_header->length[0];++j){
        Approximation b={0};
        if(j*16+16<=count){b=single_bla(j*16);for(unsigned k=1;k<16;++k)b=merge_bla(b,single_bla(j*16+k));}
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
static uint32_t dd_pixel(Extended dc,int *certain){
    DoubleDouble cr=dd_add(dd_real,(DoubleDouble){dc.r*power_two(dc.e),0});
    DoubleDouble ci=dd_add(dd_imag,(DoubleDouble){dc.i*power_two(dc.e),0});
    DoubleDouble x={0},y={0};double error=0,norm=0;
    for(unsigned n=1;n<=limit;++n){
        DoubleDouble xx=dd_multiply(x,x),yy=dd_multiply(y,y),xy=dd_multiply(x,y);
        error=(2*norm+error)*error+0x1p-96*(xx.hi+yy.hi+absd(cr.hi)+absd(ci.hi));
        x=dd_add(dd_add(xx,dd_negative(yy)),cr);y=dd_add(dd_add(xy,xy),ci);
        DoubleDouble mag=dd_add(dd_multiply(x,x),dd_multiply(y,y));
        norm=__builtin_sqrt(x.hi*x.hi+y.hi*y.hi);
        if(error>0x1p-32*(norm+0x1p-100)){*certain=0;return 0;}
        DoubleDouble margin=dd_add(mag,(DoubleDouble){-4,0});
        if(absd(margin.hi)+absd(margin.lo)<=error*(2*norm+error) && (margin.hi||margin.lo||error)){
            *certain=0;return 0;
        }
        if(margin.hi>0 || (!margin.hi && margin.lo>0))return colour(n,mag.hi+mag.lo);
    }
    return UINT32_C(0xff000000);
}
unsigned deep_configure(unsigned width,unsigned height,double spacing,int exponent,unsigned iterations,int real_sign,int imag_sign) {
    if(!configure(width,height) || !iterations)return 0;
    limit=iterations;spacing_extended=ext(spacing,0,exponent);cr_sign=real_sign;ci_sign=imag_sign;
    centre_real=normal_double(big_extended(cr_big,cr_sign));
    centre_imag=normal_double(big_extended(ci_big,ci_sign));
    dd_real=big_dd(cr_big,cr_sign);dd_imag=big_dd(ci_big,ci_sign);
    copy_big(frame_real,cr_big);copy_big(frame_imag,ci_big);frame_rs=cr_sign;frame_is=ci_sign;
    deep_skipped=deep_fallbacks=series_start=precision_needed=0;return 1;
}
/* A degree-eight perturbation prefix shares the nonlinear early orbit across
 * a tile. The discarded polynomial tail and coefficient rounding are bounded
 * uniformly on |dc| <= image_radius. Stop before any possible skipped escape. */
static void prepare_series(void){
    Extended coefficients[8]={{0}},next[8],bound={0};series_start=0;series_radius=image_radius;
    for(unsigned n=0;n<deep_header->count;++n){
        Extended sum={0},omitted={0};
        for(unsigned k=0;k<8;++k)sum=add_ext(sum,norm_ext(coefficients[k]));
        for(unsigned j=0;j<8;++j)for(unsigned k=0;k<8;++k)if(j+k+2>8)
            omitted=add_ext(omitted,mul_ext(norm_ext(coefficients[j]),norm_ext(coefficients[k])));
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
static uint32_t fixed_pixel(Extended dc) {
    ++deep_fallbacks;
    Extended r=dc,i=dc;i.r=dc.i;i.i=0;r.i=0;
    big_from_extended(scratch[4],r);big_from_extended(scratch[5],i);
    int sr=sum_big(scratch[6],cr_big,cr_sign,scratch[4],r.r<0?-1:1);
    int si=sum_big(scratch[7],ci_big,ci_sign,scratch[5],i.r<0?-1:1);
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
        if(error.r && !less_ext(error,mul_ext(norm,ext(1,0,-48)))){precision_needed=1;return 0;}
        previous_norm=norm;double mag=escape_magnitude(z);
        if(absd(mag-4)<1e-10){
            rounded_product=0;Extended margin=precise_margin();
            Extended uncertainty=mul_ext(error,add_ext(scale_ext(norm,2),error));
            if(rounded_product)uncertainty=add_ext(uncertainty,ext(4,0,-32*(int)fraction));
            if(uncertainty.r && !less_ext(uncertainty,norm_ext(margin))){precision_needed=1;return 0;}
            if(margin.r>0)return colour(n,mag);
        }
        else if(mag>4)return colour(n,mag);}
    return UINT32_C(0xff000000);
}
static uint32_t precise_pixel(Extended dc) {
    if(spacing_extended.e>=-80){int certain=1;uint32_t pixel=dd_pixel(dc,&certain);if(certain)return pixel;}
    return fixed_pixel(dc);
}
static uint32_t perturb_pixel(Extended dc) {
    Extended delta={0},error={0};unsigned n=0,m=0;
    if(series_start){
        Extended t=ext(dc.r/series_radius.r,dc.i/series_radius.r,dc.e-series_radius.e);
        delta=series_coefficients[7];
        for(unsigned k=7;k--;)delta=add_ext(mul_ext(delta,t),series_coefficients[k]);
        delta=mul_ext(delta,t);error=series_error;n=m=series_start;deep_skipped+=series_start;
    }
    const Extended rounding=ext(1,0,-48),tolerance=ext(1,0,-30);
    const Extended cnorm=norm_ext(dc);
    while(n<limit){
        Extended dnorm=norm_ext(delta);
        const Approximation *chosen=NULL;
        if(!(m%16))for(unsigned l=0;l<deep_header->levels;++l){
            unsigned block=16u<<l;if(m%block)break;
            unsigned index=m/block;if(index>=deep_header->length[l])break;
            const Approximation *b=approximations+deep_header->offset[l]+index;
            if(!b->steps || b->steps>limit-n || !less_ext(add_ext(dnorm,error),b->radius))break;
            chosen=b;
        }
        if(chosen){
            Extended t=add_ext(dnorm,cnorm),remainder=mul_ext(chosen->q,mul_ext(t,t));
            Extended amplification=add_ext(norm_ext(chosen->a),mul_ext(chosen->q,add_ext(scale_ext(t,2),error)));
            Extended ad=mul_ext(chosen->a,delta),bc=mul_ext(chosen->b,dc);
            Extended round=mul_ext(scale_ext(rounding,chosen->steps),add_ext(norm_ext(ad),norm_ext(bc)));
            error=add_ext(add_ext(mul_ext(amplification,error),remainder),round);
            delta=add_ext(ad,bc);n+=chosen->steps;m+=chosen->steps;deep_skipped+=chosen->steps-1;
        }else{
            Extended zref=norm_ext(orbit[m]);
            Extended a=mul_ext(scale_ext(orbit[m],2),delta),b=mul_ext(delta,delta);
            Extended amplification=add_ext(scale_ext(add_ext(zref,dnorm),2),error);
            error=add_ext(mul_ext(amplification,error),mul_ext(rounding,add_ext(add_ext(norm_ext(a),norm_ext(b)),cnorm)));
            delta=add_ext(add_ext(a,b),dc);++n;++m;
        }
        Extended actual=add_ext(orbit[m],delta),anorm=norm_ext(actual);
        if(!less_ext(error,mul_ext(anorm,tolerance)) && error.r)return precise_pixel(dc);
        double magnitude=escape_magnitude(actual);
        if(absd(magnitude-4)<1e-7){
            Extended cross=mul_ext(orbit[m],(Extended){delta.r,-delta.i,delta.e,0});cross.i=0;
            Extended square=ext(delta.r*delta.r+delta.i*delta.i,0,2*delta.e);
            Extended margin=add_ext(bailout_margin[m],add_ext(scale_ext(cross,2),square));
            Extended uncertainty=mul_ext(error,add_ext(scale_ext(anorm,2),error));
            if(!less_ext(uncertainty,norm_ext(margin)) && (uncertainty.r||margin.r))return precise_pixel(dc);
            if(margin.r>0)return colour(n,magnitude);
        }else if(magnitude>4)return colour(n,magnitude);
        if(m>=deep_header->count || less_ext(anorm,norm_ext(delta))){delta=actual;m=0;}
    }
    return UINT32_C(0xff000000);
}
unsigned deep_render_tile(unsigned tx,unsigned ty,unsigned width,unsigned height) {
    if(!frame_width || !width || !height || width>256 || height>64 || width>frame_width || height>frame_height ||
       tx>frame_width-width || ty>frame_height-height)return 0;
    deep_skipped=deep_fallbacks=precision_needed=0;
    int local=spacing_extended.e>=-79;
    if(local){
        Extended r=ext(((double)tx+0.5*width-half_width)*spacing_extended.r,0,spacing_extended.e);
        Extended i=ext((half_height-(double)ty-0.5*height)*spacing_extended.r,0,spacing_extended.e);
        big_from_extended(scratch[4],r);big_from_extended(scratch[5],i);
        int rs=sum_big(cr_big,frame_real,frame_rs,scratch[4],r.r<0?-1:1);
        int is=sum_big(ci_big,frame_imag,frame_is,scratch[5],i.r<0?-1:1);
        deep_begin(rs,is,spacing_extended.r,spacing_extended.e,width,height);
        while(!deep_reference(128)){}
        if(precision_needed)return 0;
        deep_finish();
        dd_real=big_dd(cr_big,cr_sign);dd_imag=big_dd(ci_big,ci_sign);
        prepare_series();
    }else series_start=0;
    uint32_t *dst=output;
    for(unsigned y=0;y<height;++y)for(unsigned x=0;x<width;++x){
        Extended dc=ext(((double)(tx+x)+0.5-half_width)*spacing_extended.r,
            (half_height-(double)(ty+y)-0.5)*spacing_extended.r,spacing_extended.e);
        if(known_interior(centre_real+dc.r*power_two(dc.e),centre_imag+dc.i*power_two(dc.e)))
            *dst++=UINT32_C(0xff000000);
        else {
            if(local)dc=ext(((double)x+0.5-0.5*width)*spacing_extended.r,
                (0.5*height-(double)y-0.5)*spacing_extended.r,spacing_extended.e);
            *dst++=perturb_pixel(dc);
            if(precision_needed)return 0;
        }
    }
    return width*height*4;
}
unsigned deep_stat_skipped(void){return deep_skipped;}
unsigned deep_stat_fallbacks(void){return deep_fallbacks;}
