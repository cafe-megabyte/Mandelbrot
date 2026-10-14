#include <stdio.h>
#include <stdlib.h>
#include <math.h>
#include "../core/mandelbrot.c"
#include "../core/deep-zoom.c"
static void require(int valid,const char *message){if(!valid){fprintf(stderr,"%s\n",message);exit(1);}}
static void input_decimal(uint32_t *target,const char *text){
    /* Independent base-10 long division of the fractional part. All fixtures
       have |coordinate|<4. This does not use the core's double conversion. */
    unsigned integer=(unsigned)strtoul(text,NULL,10);
    char decimal[1024];unsigned length=0;while(*text && *text!='.')++text;if(*text)++text;
    while(*text){decimal[length++]=*text++-'0';}
    clear_big(target);target[fraction]=integer;
    for(unsigned bit=0;bit<fraction*32;++bit){
        unsigned carry=0;for(unsigned j=length;j--;){unsigned d=decimal[j]*2+carry;decimal[j]=d%10;carry=d/10;}
        if(carry)target[fraction-1-bit/32]|=1u<<(31-bit%32);
    }
}
static void prepare(const char *real,int rs,const char *imag,int is,int exponent,unsigned iterations){
    require(deep_allocate((unsigned)(-2*exponent+192),iterations),"Allocation failed");
    input_decimal(cr_big,real);input_decimal(ci_big,imag);
    if(real[0]=='2')cr_big[fraction]=2;
    deep_begin(rs,is,1,exponent,33,17);
    while(!deep_reference(128)){}deep_finish();
    deep_configure(33,17,1,exponent,iterations,rs,is);
}
int main(void){
    require(!deep_allocate(0,512),"Invalid precision accepted");
    require(!deep_allocate(0x7fffffbfu,0x7fffffbfu),"Workspace size overflow was accepted");
    prepare("0.743643887037151",-1,"0.13182590420533",1,-32,4096);
    unsigned comparisons=0;
    for(unsigned y=0;y<17;++y)for(unsigned x=0;x<33;++x){
        Extended dc=ext((double)x+0.5-16.5,8.5-(double)y-0.5,-32);
        uint32_t accelerated=perturb_pixel(dc),expected=fixed_pixel(dc);
        for(unsigned channel=0;channel<3;++channel){
            int difference=(int)((accelerated>>(8*channel))&255)-(int)((expected>>(8*channel))&255);
            require(abs(difference)<=1,"Perturbation differs from precise orbit");
        }
        ++comparisons;
    }
    prepare("0.0",1,"1.0",1,-400,2048);
    unsigned skipped_before=deep_skipped;
    for(unsigned y=0;y<17;++y)for(unsigned x=0;x<33;++x){
        Extended dc=ext((double)x-16,8-(double)y,-400);
        uint32_t a=perturb_pixel(dc),b=fixed_pixel(dc);
        for(unsigned ch=0;ch<3;++ch)require(abs((int)((a>>(ch*8))&255)-(int)((b>>(ch*8))&255))<=1,"Scaled deep orbit mismatch");
        ++comparisons;
    }
    require(deep_skipped>skipped_before,"Extreme deep zoom did not use BLA");
    prepare("0.0",1,"1.0",1,-1600,4096);
    for(int j=-3;j<=3;++j){Extended dc=ext(j,j,-1600);require(perturb_pixel(dc)==fixed_pixel(dc),"Extended exponent mismatch");}
    /* Exercise normalized multiplication and exact fixed-point limb carries. */
    for(unsigned j=1;j<1000;++j){
        Extended a=ext(j*0.123,-(double)j*0.031,-400),b=ext(j*0.017,j*0.023,390),p=mul_ext(a,b);
        double r=(j*0.123*j*0.017+j*0.031*j*0.023)*0x1p-10;
        require(fabs(normal_double(p)-r)<1e-11*fabs(r),"Scaled multiplication mismatch");
    }
    printf("Deep fixed-point, perturbation/BLA, fallback and extended exponents passed (%u pixel comparisons; depths 2^32, 2^400, 2^1600).\n",comparisons+7);
    return 0;
}
