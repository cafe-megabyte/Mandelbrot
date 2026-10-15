#include <stdio.h>
#include <stdlib.h>
#include <math.h>
#include <string.h>
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
static void check_bla_pruning(void){
    const char *real[]={"0","1","0.25","0"},*imag[]={"0","0","0","1"};
    const int radii[]={-1600,-512,-30};unsigned saved=deep_options;
    for(unsigned fixture=0;fixture<4;++fixture){
        require(deep_allocate(288,65),"BLA pruning fixture allocation failed");
        input_decimal(cr_big,real[fixture]);input_decimal(ci_big,imag[fixture]);
        deep_begin(1,1,1,-512,33,17);while(!deep_reference(128)){}
        require(!precision_needed,"BLA pruning reference needs precision");
        for(unsigned phase=0;phase<2;++phase)for(unsigned radius=0;radius<3;++radius){
            deep_set_options((saved&~DEEP_BLA_ONE)|(phase?DEEP_BLA_ONE:0));
            image_radius=ext(1,0,radii[radius]);
            unsigned count=0;for(unsigned level=0;level<deep_header->levels;++level)count+=deep_header->length[level];
            memset(approximations,0xa5,count*sizeof(*approximations));deep_finish();
            for(unsigned level=0;level<deep_header->levels;++level)for(unsigned j=0;j<deep_header->length[level];++j){
                Approximation b=approximations[deep_header->offset[level]+j];
                /* c=0 has zero derivative; c=1 escapes before a full block.
                 * c=1/4 and c=i stay bounded and have nonzero derivatives
                 * after n=0. The two tiny footprints retain every such block;
                 * 2^-30 exceeds all single-step radii and rejects every merge. */
                int valid=fixture>=2 && radius<2 && (phase || j);
                if(!valid){Approximation zero={0};require(!memcmp(&b,&zero,sizeof(b)),"Invalid BLA block was not pruned");continue;}
                unsigned steps=16u<<level,start=phase+j*steps;
                require(b.steps==steps && b.radius.r>0,"Pruning removed a valid BLA block");
                /* Independently differentiate the orbit step by step. This
                 * checks retained jumps without reproducing merge_bla. */
                double ar=1,ai=0,br=0,bi=0;
                for(unsigned n=start;n<start+steps;++n){
                    double zr=2*normal_double(orbit[n]),zi=2*orbit[n].i*power_two(orbit[n].e);
                    double next_ar=zr*ar-zi*ai,next_br=zr*br-zi*bi+1;
                    ai=zr*ai+zi*ar;ar=next_ar;bi=zr*bi+zi*br;br=next_br;
                }
                double actual[]={normal_double(b.a),b.a.i*power_two(b.a.e),normal_double(b.b),b.b.i*power_two(b.b.e)};
                double expected[]={ar,ai,br,bi};
                for(unsigned k=0;k<4;++k)require(fabs(actual[k]-expected[k])<=1e-12*(1+fabs(expected[k])),
                    "Pruning changed a retained BLA derivative");
            }
        }
    }
    deep_set_options(saved);
}
static void check_local_reference_reuse(void){
    unsigned saved=deep_options;uint32_t expected[32*8];
    for(unsigned certificate=0;certificate<2;++certificate){
        unsigned iterations=certificate?16:128;
        deep_set_options(saved|DEEP_REUSE_REFERENCE|DEEP_LAZY_REFERENCE|DEEP_BLACK_CERTIFICATE);
        require(deep_allocate(288,iterations),"Reference reuse allocation failed");
        input_decimal(cr_big,"0.75");input_decimal(ci_big,"0.1");
        require(deep_configure(129,65,1,-40,iterations,-1,1),"Reference reuse configuration failed");
        require(deep_render_tile(0,0,32,8)==sizeof(expected) && deep_local_references==1,"Initial reference reuse miss failed");
        require(reference_bounded==(int)certificate,"Reference reuse certificate fixture changed");
        require(local_reference_contains(0,8,32,8) && !local_reference_contains(0,16,32,8),
            "Reference reuse containment accepted an outside corner");
        require(deep_render_tile(0,8,32,8)==sizeof(expected) && !deep_local_references,"Contained tile did not reuse its reference");
        if(certificate)require(deep_certified_pixels==256 && !deep_certificate_iterations,"Cached certificate was recomputed");
        memcpy(expected,output,sizeof(expected));
        require(deep_grow_precision(fraction*32+64),"Reference reuse precision growth failed");
        require(deep_render_tile(0,8,32,8)==sizeof(expected) && !deep_local_references && !memcmp(expected,output,sizeof(expected)),
            "Precision growth invalidated or damaged a finished local reference");
        require(deep_render_tile(32,8,32,8)==sizeof(expected) && deep_local_references==1,"Outside tile reused the wrong reference");
        deep_set_options(deep_options^DEEP_SERIES_NORMS);
        require(deep_render_tile(32,8,32,8)==sizeof(expected) && deep_local_references==1,"Option change retained a stale reference");
        input_decimal(cr_big,"0.9");input_decimal(ci_big,"0.3");
        require(deep_configure(129,65,1,-40,iterations,-1,1),"Reference reuse frame change failed");
        require(deep_render_tile(32,8,32,8)==sizeof(expected) && deep_local_references==1,"New frame reused the old centre");
    }
    /* A low-precision API caller can have a limb quantum larger than a pixel.
     * Growing the arena preserves that already-rounded reference centre, so
     * only a freshly built reference can acquire the containment guarantee. */
    deep_set_options(saved|DEEP_REUSE_REFERENCE|DEEP_LAZY_REFERENCE);
    require(deep_allocate(64,16),"Low-precision reference reuse allocation failed");
    input_decimal(cr_big,"0.5");input_decimal(ci_big,"0.5");
    require(deep_configure(64,16,1,-80,16,1,1),"Low-precision reference reuse configuration failed");
    require(deep_render_tile(16,4,32,8)==sizeof(expected),"Low-precision reference fixture failed");
    require(!local_reference_contains(16,5,32,8),"Low-precision reference acquired an unjustified containment proof");
    require(deep_grow_precision(128),"Low-precision reference growth failed");
    require(!local_reference_contains(16,5,32,8),"Growth retroactively certified a rounded reference centre");
    require(deep_render_tile(16,5,32,8)==sizeof(expected) && deep_local_references==1,
        "Growth reused a reference built below the containment precision");
    require(deep_render_tile(16,6,32,8)==sizeof(expected) && !deep_local_references,
        "Fresh high-precision reference did not become reusable");
    deep_set_options(saved);
}
static void check_squares(void){
    const unsigned precisions[]={64,96,256,1024,3424};uint32_t random=0x691683b7u;
    for(unsigned p=0;p<sizeof(precisions)/sizeof(precisions[0]);++p){
        require(deep_allocate(precisions[p],32),"Square allocation failed");
        uint32_t *expected=malloc(2*digits*sizeof(uint32_t));require(expected!=NULL,"Square fixture allocation failed");
        for(unsigned sample=0;sample<400;++sample){
            for(unsigned j=0;j<digits;++j){random=random*1664525u+1013904223u;
                cr_big[j]=sample==0?UINT32_MAX:sample==1?(j%2?0:UINT32_MAX):sample==2?0:random;}
            rounded_product=0;multiply_big(scratch[6],cr_big,cr_big);int rounded=rounded_product;
            memcpy(expected,product,2*digits*sizeof(uint32_t));
            rounded_product=0;square_big(scratch[7],cr_big);
            require(!memcmp(expected,product,2*digits*sizeof(uint32_t)),"Specialized square lost a carry");
            require(!memcmp(scratch[6],scratch[7],digits*sizeof(uint32_t)),"Specialized square changed truncation");
            require(rounded==rounded_product,"Specialized square changed rounding flag");
        }
        free(expected);
    }
}
static void check_karatsuba(void){
    const unsigned sizes[]={31,32,33,34,54,64,108,128};unsigned saved=deep_options;
    uint32_t random=0x91f273a5u;
    for(unsigned test=0;test<sizeof(sizes)/sizeof(sizes[0]);++test){
        require(deep_allocate((sizes[test]-1)*32,32),"Karatsuba allocation failed");
        uint32_t *expected=malloc(2*digits*sizeof(uint32_t));require(expected!=NULL,"Karatsuba fixture allocation failed");
        for(unsigned sample=0;sample<80;++sample){
            for(unsigned j=0;j<digits;++j){
                random=random*1664525u+1013904223u;cr_big[j]=sample==0?UINT32_MAX:sample==1?0:random;
                random=random*1664525u+1013904223u;ci_big[j]=sample==0?UINT32_MAX:sample==2?0:random;
            }
            deep_set_options(saved&~DEEP_KARATSUBA);rounded_product=0;multiply_big(scratch[6],cr_big,ci_big);
            int rounded=rounded_product;memcpy(expected,product,2*digits*sizeof(uint32_t));
            deep_set_options(saved|DEEP_KARATSUBA);rounded_product=0;multiply_big(scratch[7],cr_big,ci_big);
            require(!memcmp(expected,product,2*digits*sizeof(uint32_t)),"Karatsuba product mismatch");
            require(!memcmp(scratch[6],scratch[7],digits*sizeof(uint32_t)),"Karatsuba truncation mismatch");
            require(rounded==rounded_product,"Karatsuba rounding flag mismatch");
        }
        free(expected);
    }
    deep_set_options(saved);
}
static void check_growth_and_resume(void){
    for(unsigned local=0;local<2;++local){
    prepare("0.0",1,"1.0",1,local?-40:-400,2048);
    image_radius=(Extended){0};
    require(deep_configure(33,17,1,local?-40:-400,2048,1,1),"Imported reference configuration failed");
    require(deep_render_tile(0,0,7,3)==7*3*4,"Growth fixture render failed");
    if(!local)require(deep_skipped>0,"Imported reference lost its BLA footprint");
    unsigned data=deep_data_size(),old_digits=digits;uint32_t saved[21];memcpy(saved,output,sizeof(saved));
    unsigned char *reference=malloc(data);uint32_t *centre=malloc(4*digits*sizeof(uint32_t));
    require(reference && centre,"Growth fixture allocation failed");memcpy(reference,arena,data);
    memcpy(centre,cr_big,digits*4);memcpy(centre+digits,ci_big,digits*4);
    memcpy(centre+2*digits,frame_real,digits*4);memcpy(centre+3*digits,frame_imag,digits*4);
    require(deep_grow_precision(fraction*32+64),"Precision growth failed");
    require(digits==old_digits+2 && !memcmp(reference,arena,data),"Precision growth damaged reference payload");
    uint32_t *centres[]={cr_big,ci_big,frame_real,frame_imag};
    for(unsigned k=0;k<4;++k)require(!centres[k][0] && !centres[k][1] &&
        !memcmp(centre+k*old_digits,centres[k]+2,old_digits*4),"Precision growth moved the centre");
    require(!memcmp(saved,output,sizeof(saved)),"Precision growth damaged tile output");
    /* Simulate an interrupted boundary after a valid prefix, then make sure
       resume neither rewrites that prefix nor loses the remaining coordinates. */
    tile_completed=8;for(unsigned j=8;j<21;++j)output[j]=0;
    require(deep_render_tile_resume(0,0,7,3)==7*3*4 && tile_completed==21,"Tile resume failed");
    require(!memcmp(saved,output,sizeof(saved)),"Tile resume changed pixel values");
    require(!deep_render_tile_resume(0,0,6,3),"Resume accepted a different tile");
    free(reference);free(centre);
    }
    prepare("0.0",1,"0.0",1,-40,2048);
    require(deep_render_tile(0,0,33,17)==33*17*4 && !deep_local_references && !deep_reference_iterations,
        "Analytical interior unnecessarily prepared a local reference");
    deep_skipped=(UINT64_C(1)<<33)+17;
    require(deep_stat_skipped()==8589934609.0,"Skipped iteration statistics overflowed");
    deep_reset_stats();
}
static void check_rescaled_addition(void){
    unsigned saved_options=deep_options;deep_set_options(saved_options|DEEP_RESCALED);
    uint32_t random=0xe61a57c3u;
    for(unsigned sample=0;sample<20000;++sample){
        double values[6];
        for(unsigned j=0;j<6;++j){random=random*1664525u+1013904223u;values[j]=(int32_t)random*0x1p-31;}
        if(!(sample%17))values[0]=0;
        if(!(sample%23))values[3]=0x1p-500;
        int exponent=sample%3==0?-1600:sample%3==1?-40:1000;
        Extended a=ext(values[0],values[1],exponent),b=ext(values[2],values[3],exponent-(int)(sample%33));
        Extended c=ext(values[4],values[5],exponent-4-(int)(sample%29));
        Extended expected=add_ext(add_ext(a,b),c),actual=add_three_ext(a,b,c);
        require(!memcmp(&expected,&actual,sizeof(expected)),"Rescaled addition changed exact floating-point result");
    }
    deep_set_options(saved_options);
}
static void check_exact_exponent_shifts(void){
    /* Complex values are only doubled by the hot loop. In particular, even
       a subnormal secondary mantissa must survive multiplication by two and
       the old normalization's exact division by two. Negative shifts are
       used only on real scalar norms/bounds: applying them to an arbitrary
       subnormal complex component would not reproduce the old underflow. */
    const Extended complex_values[]={
        {0.5,0x1p-1074,-1600,0},{-0x1.fffffffffffffp-1,-0x1p-1074,1600,0},
        {0x1p-1074,-0.5,-1000000,0},{-0x1p-1022,0x1.fffffffffffffp-1,1000000,0},
        {0.75,-0.75,0,0},{0,0,0,0}
    };
    for(unsigned j=0;j<sizeof(complex_values)/sizeof(complex_values[0]);++j){
        Extended a=complex_values[j],expected=scale_ext(a,2),actual=shift_ext(a,1);
        require(!memcmp(&expected,&actual,sizeof(actual)),"Exponent doubling changed a complex mantissa");
    }
    const int exponents[]={-1000000,-1600,-1074,-1022,0,1024,1600,1000000};
    const double mantissas[]={0.5,0x1.0000000000001p-1,0.75,0x1.fffffffffffffp-1};
    const int shifts[]={-48,-30,1};
    for(unsigned e=0;e<sizeof(exponents)/sizeof(exponents[0]);++e)
        for(unsigned m=0;m<sizeof(mantissas)/sizeof(mantissas[0]);++m)
            for(unsigned s=0;s<sizeof(shifts)/sizeof(shifts[0]);++s){
                Extended a={mantissas[m],0,exponents[e],0};
                Extended expected=scale_ext(a,power_two(shifts[s])),actual=shift_ext(a,shifts[s]);
                require(!memcmp(&expected,&actual,sizeof(actual)),"Exponent shift changed a scalar bound");
            }
    for(unsigned s=0;s<sizeof(shifts)/sizeof(shifts[0]);++s){
        Extended zero={0},actual=shift_ext(zero,shifts[s]);
        require(!memcmp(&zero,&actual,sizeof(zero)),"Exponent shift changed canonical zero");
    }
}
static void check_reference_coordinates(void){
    require(deep_allocate(1024,32),"Reference coordinate fixture allocation failed");
    spacing_extended=ext(1.1764705882352942,0,-400);
    const double offsets[]={0,0.5,-0.5,31.5,-16383.5,1000000000.0};
    for(unsigned j=0;j<sizeof(offsets)/sizeof(offsets[0]);++j){
        big_from_extended(xr_big,spacing_extended);big_from_extended(xi_big,ext(absd(offsets[j]),0,0));
        multiply_big(ci_big,xr_big,xi_big);pixel_offset_big(cr_big,offsets[j]);
        require(!memcmp(cr_big,ci_big,digits*sizeof(uint32_t)),"Local reference centre lost coordinate bits");
    }
}
static void check_big_conversion(void){
    require(deep_allocate(2048,32),"Conversion fixture allocation failed");
    for(unsigned j=0;j<fraction;++j)cr_big[j]=UINT32_MAX;
    cr_big[fraction]=1;
    require(normal_double(big_extended(cr_big,-1))==-2.0,
        "A coordinate just above -2 lost significant bits in conversion");
    clear_big(cr_big);cr_big[fraction]=1;cr_big[fraction-1]=1;cr_big[fraction-2]=4096;
    require(normal_double(big_extended(cr_big,1))==0x1.0000000100001p0,
        "Fixed-point conversion omitted a mantissa bit in the third limb");
    /* Move the same 53-bit value far below the normal-double exponent range. */
    clear_big(cr_big);cr_big[2]=1;cr_big[1]=1;cr_big[0]=4096;
    Extended converted=big_extended(cr_big,1);
    require(converted.r==0x1.0000000100001p-1 && converted.e==65-32*(int)fraction,
        "Extended conversion changed the leading mantissa or exponent");
}
static void check_adaptive_boundaries(void){
    unsigned saved=deep_options;
    const unsigned variants[]={11,27,267,511};
    const unsigned regions[][4]={{112,56,33,17},{113,57,33,17},{111,55,33,17}};
    uint32_t expected[561];
    for(unsigned fixture=0;fixture<2;++fixture){
        unsigned w=fixture?33:257,h=fixture?17:129,zoom=fixture?1600:400;
        double base=fmax(3.0/w,2.5/h);int exponent=(int)floor(log2(base)-zoom);
        double spacing=ldexp(base,-(int)zoom-exponent);
        for(unsigned region=0;region<(fixture?1u:3u);++region){
            unsigned tx=fixture?0:regions[region][0],ty=fixture?0:regions[region][1];
            for(unsigned variant=0;variant<sizeof(variants)/sizeof(variants[0]);++variant){
                deep_set_options(variants[variant]);
                require(deep_allocate((unsigned)(-2*exponent+192),4096),"Adaptive boundary allocation failed");
                input_decimal(cr_big,fixture?"0":"2");input_decimal(ci_big,fixture?"1":"0");
                deep_begin(fixture?1:-1,1,spacing,exponent,w,h);
                while(!deep_reference(128)){}deep_finish();
                require(deep_configure(w,h,spacing,exponent,4096,fixture?1:-1,1),"Adaptive boundary configuration failed");
                require(deep_render_tile(tx,ty,33,17)==sizeof(expected),"Adaptive boundary render failed");
                if(!variant)memcpy(expected,output,sizeof(expected));
                else require(!memcmp(expected,output,sizeof(expected)),"Local reference changed a boundary pixel");
                for(unsigned y=0;y<17;++y)for(unsigned x=0;x<33;++x){
                    unsigned px=tx+x,py=ty+y;
                    if(!fixture && py==h/2){
                        /* Independent exact set membership: [-2,1/4] is in
                           the set; every real c<-2 escapes on the first step. */
                        require((output[y*33+x]==UINT32_C(0xff000000))==(px>=w/2),
                            "Local reference moved an exact real-axis pixel");
                    }
                    if(fixture && px==w/2 && py==h/2){
                        /* c=i has orbit i, -1+i, -i, -1+i, ... exactly. */
                        require(output[y*33+x]==UINT32_C(0xff000000),
                            "Local reference moved the exact c=i centre");
                    }
                }
            }
        }
    }
    deep_set_options(saved);
}
static void check_analytic_deep_boundaries(void){
    for(unsigned fixture=0;fixture<2;++fixture){
        require(deep_allocate(512,32),"Analytical deep boundary allocation failed");
        clear_big(cr_big);clear_big(ci_big);
        cr_big[fraction-1]=UINT32_C(0x40000000);
        if(fixture)cr_big[fraction]=1;
        /* The displacement exists in limbs even though the double centre
           rounds onto +1/4 or -5/4. Neither point may bypass the orbit. */
        unsigned bit=fraction*32-400;
        cr_big[bit/32]|=UINT32_C(1)<<(bit%32);
        int sign=fixture?-1:1;
        deep_begin(sign,1,1,-400,1,1);
        while(!deep_reference(32)){}deep_finish();
        require(!deep_needs_precision(),"Analytical deep boundary reference failed");
        require(deep_configure(1,1,1,-400,32,sign,1),"Analytical deep boundary configuration failed");
        require(centre_real==(fixture?-1.25:0.25),"Analytical deep boundary did not exercise rounding");
        require(!known_interior(centre_real,centre_imag),"Rounded deep boundary accepted as interior");
        require(deep_render_tile(0,0,1,1)==4 && deep_stat_perturb_iterations()>0,
                "Deep limb boundary bypassed the orbit path");
    }
}
static void prepare_cusp_certificate(unsigned iterations){
    require(deep_allocate(288,iterations),"Black certificate allocation failed");
    input_decimal(cr_big,"0.25001303030608202512367228146490787920114208693622703805203855154104530811309814453125");
    input_decimal(ci_big,"0.0000000749182661172659014323139709291501879399356733646442307872348465025424957275390625");
    require(deep_configure(3840,2160,1.7996498782013155,-43,iterations,1,-1),
        "Black certificate configuration failed");
}
static void check_black_certificates(void){
    unsigned saved=deep_options;
    const unsigned cases[][4]={{960,540,8,4},{1920,1080,32,8},{0,0,8,4}};
    uint32_t expected[256];
    for(unsigned fixture=0;fixture<3;++fixture){
        unsigned tx=cases[fixture][0],ty=cases[fixture][1],w=cases[fixture][2],h=cases[fixture][3];
        for(unsigned enabled=0;enabled<2;++enabled){
            deep_set_options((saved&~DEEP_BLACK_CERTIFICATE)|(enabled?DEEP_BLACK_CERTIFICATE:0));
            prepare_cusp_certificate(9216);
            require(deep_render_tile(tx,ty,w,h)==w*h*4,"Black certificate render failed");
            if(!enabled){
                memcpy(expected,output,w*h*4);
                require(!deep_certificate_iterations && !deep_certified_pixels,"Disabled certificate did work");
            }else{
                require(!memcmp(expected,output,w*h*4),"Black certificate changed a pixel");
                if(fixture<2){
                    require(deep_certified_pixels==w*h && !deep_perturb_iterations && !deep_dd_iterations,
                        "Black certificate did not replace the pixel orbits");
                    require(fixture?(deep_certificate_iterations>9216 && deep_certificate_iterations<2*9216):
                        deep_certificate_iterations==9216,
                        "Black certificate did not exercise its expected scalar/series path");
                    /* Independently run fixed-point pixel orbits at four
                       corners and the centre after the uniform proof. */
                    const unsigned sample_x[]={0,w-1,0,w-1,w/2},sample_y[]={0,0,h-1,h-1,h/2};
                    for(unsigned j=0;j<5;++j){
                        Extended dc=ext(((double)sample_x[j]+0.5-0.5*w)*spacing_extended.r,
                            (0.5*h-(double)sample_y[j]-0.5)*spacing_extended.r,spacing_extended.e);
                        require(fixed_pixel(dc)==UINT32_C(0xff000000) && !precision_needed,
                            "Certified black pixel escaped in a fixed-point orbit");
                    }
                }else require(!deep_certified_pixels && expected[0]!=UINT32_C(0xff000000),
                    "Escaping reference incorrectly certified black");
            }
        }
    }
    /* A larger footprint cannot be certified, so it must retain exactly the
       original colour-accurate prefix instead of using the coarse remainder. */
    Extended original[8];unsigned prefix;
    deep_set_options(saved&~DEEP_BLACK_CERTIFICATE);prepare_cusp_certificate(9216);
    require(prepare_local_reference(1920,1080,64,32),"Certificate fallback reference failed");
    prefix=series_start;memcpy(original,series_coefficients,sizeof(original));
    deep_set_options(saved|DEEP_BLACK_CERTIFICATE);prepare_cusp_certificate(9216);
    require(prepare_local_reference(1920,1080,64,32) && !reference_bounded,
        "Wide uncertain footprint was certified");
    require(prefix==series_start && !memcmp(original,series_coefficients,sizeof(original)),
        "Failed certificate changed the normal series prefix");
    /* The same exact centre really escapes later. A finite-budget proof may
       never become a permanent membership shortcut. */
    prepare_cusp_certificate(40000);
    require(prepare_local_reference(1904,1076,32,8),"Long certificate reference failed");
    require(deep_header->count==34366 && !reference_bounded && !deep_certificate_iterations,
        "Finite-budget certificate incorrectly claimed permanent membership");
    deep_set_options(saved);
}
static void prepare_cusp_precise_series(void){
    require(deep_allocate(288,10496),"Precise prefix allocation failed");
    input_decimal(cr_big,"0.2500130302909066233189455074779471041381893800707269907845908818444513599388301372528076171875");
    input_decimal(ci_big,"0.000000075132663698447208529708670575067558725977190196843036318341546575538814067840576171875");
    require(deep_configure(3840,2160,1.0530572952760489,-48,10496,1,-1),"Precise prefix configuration failed");
}
static void check_precise_series(void){
    unsigned saved=deep_options;
    const unsigned variants[]={0,DEEP_TIGHT_SERIES,DEEP_PRECISE_SERIES,DEEP_PRECISE_SERIES|DEEP_TIGHT_SERIES};
    const unsigned cases[][4]={{0,0,32,8},{1920,1080,32,8},{1916,1078,8,4}};
    uint32_t expected[256];
    for(unsigned fixture=0;fixture<3;++fixture){
        unsigned before_prefix=0,dd_prefix=0,before_count=0;uint64_t before_iterations=0,before_reference=0;
        unsigned tx=cases[fixture][0],ty=cases[fixture][1],w=cases[fixture][2],h=cases[fixture][3];
        for(unsigned variant=0;variant<sizeof(variants)/sizeof(variants[0]);++variant){
            deep_set_options(779|variants[variant]);prepare_cusp_precise_series();
            require(deep_render_tile(tx,ty,w,h)==w*h*4 && !precision_needed,"Precise prefix render failed");
            if(!variant){
                memcpy(expected,output,w*h*4);before_prefix=series_start;before_iterations=deep_perturb_iterations;
                before_count=deep_header->count;before_reference=deep_reference_iterations;
                require(!prefix_dd_used && !prefix_dd_active,"Disabled precise prefix constructed DD coefficients");
            }else{
                require(!memcmp(expected,output,w*h*4),"More accurate prefix changed a pixel");
                require(series_start>before_prefix && deep_perturb_iterations<before_iterations,
                    "Accurate prefix did not replace ordinary iterations");
                require((prefix_dd_used!=0)==((variants[variant]&DEEP_PRECISE_SERIES)!=0 && w*h>=128),
                    "Accurate prefix chose the wrong arithmetic");
                require(deep_header->count==before_count && deep_reference_iterations==before_reference*(prefix_dd_used?2:1),
                    "Precise prefix replay changed the reference or hid its work");
                if(variant==2)dd_prefix=series_start;
                if(variant==3)require(series_start==dd_prefix,"Tight option overrode an already built DD prefix");
            }
            if(variant==2){
                /* Independent fixed arithmetic checks coloured and difficult
                   pixels; it shares neither the polynomial nor DD arithmetic. */
                const unsigned sx[]={0,w-1,w/2},sy[]={0,h-1,h/2};
                for(unsigned j=0;j<3;++j){
                    Extended dc=ext(((double)sx[j]+0.5-0.5*w)*spacing_extended.r,
                        (0.5*h-(double)sy[j]-0.5)*spacing_extended.r,spacing_extended.e);
                    uint32_t actual=output[sy[j]*w+sx[j]],independent=fixed_pixel(dc);
                    require(!precision_needed && (actual==UINT32_C(0xff000000))==(independent==UINT32_C(0xff000000)),
                        "Precise prefix disagreed with fixed-point membership");
                    for(unsigned channel=0;channel<4;++channel)
                        require(abs((int)((actual>>(8*channel))&255)-(int)((independent>>(8*channel))&255))<=1,
                            "Precise prefix disagreed with fixed-point colour");
                }
            }
        }
    }
    /* A successful finite-budget proof must bypass the precise replay even
       when requested. This is a non-analytic high-period cusp32 tile. */
    deep_set_options(779|DEEP_PRECISE_SERIES);prepare_cusp_certificate(9216);
    require(deep_render_tile(1920,1080,32,8)==sizeof(expected) && deep_certified_pixels==256,
        "Precise replay certificate fixture failed");
    require(!prefix_dd_used && !prefix_dd_active && !series_start && deep_reference_iterations==9216,
        "Certified tile unnecessarily replayed its reference");
    /* A completed prefix survives reference reuse and limb-precision growth. */
    deep_set_options(779|DEEP_PRECISE_SERIES|DEEP_REUSE_REFERENCE);prepare_cusp_precise_series();
    require(deep_render_tile(0,0,32,8)==sizeof(expected),"Precise prefix reuse fixture failed");
    memcpy(expected,output,sizeof(expected));unsigned prefix=series_start;
    Extended coefficients[8];memcpy(coefficients,series_coefficients,sizeof(coefficients));
    require(deep_grow_precision(352),"Precise prefix precision growth failed");
    require(!prefix_dd_active && series_start==prefix && !memcmp(coefficients,series_coefficients,sizeof(coefficients)),
        "Precision growth damaged a completed prefix");
    require(deep_render_tile(0,0,32,8)==sizeof(expected) && !deep_reference_iterations && series_start==prefix &&
        !memcmp(expected,output,sizeof(expected)),"Cached precise prefix changed after growth");
    /* A short reference selects tight coefficients without a second pass. */
    deep_set_options((779&~DEEP_BLACK_CERTIFICATE)|DEEP_PRECISE_SERIES);
    prepare("0.1",-1,"0.1",1,-48,128);
    deep_reset_stats();
    require(prepare_local_reference(0,0,33,17) && !prefix_dd_used && !prefix_dd_active && series_start==128 &&
        deep_reference_iterations==128,"Short reference unnecessarily replayed its orbit");
    /* Explicitly start in-flight construction, then exercise public reference
       and import resets independently of the setup-amortization policy. */
    deep_begin(-1,1,1,-48,33,17);prefix_dd_begin();deep_reference(32);
    require(prefix_dd_used && prefix_dd_active && series_start==32,"Precise prefix lifecycle fixture failed");
    deep_begin(-1,1,1,-48,33,17);
    require(!prefix_dd_active && !prefix_dd_used,"Public reference begin retained stale DD coefficients");
    while(!deep_reference(128)){}
    require(!prefix_dd_active && !prefix_dd_used,"Public reference unexpectedly constructed a local prefix");
    deep_begin(-1,1,1,-48,33,17);prefix_dd_begin();deep_reference(32);
    require(prefix_dd_active,"Precise prefix import fixture failed");
    require(deep_configure(33,17,1,-48,128,-1,1) && !prefix_dd_active && !prefix_dd_used,
        "Frame configuration retained an in-flight precise prefix");
    /* Outside its proved exponent domain both new options retain the old
       algorithm and its exact bytes. */
    for(unsigned variant=0;variant<2;++variant){
        deep_set_options(779|(variant?DEEP_PRECISE_SERIES|DEEP_TIGHT_SERIES:0));
        prepare("0.743643887037151",-1,"0.13182590420533",1,-24,4096);
        require(deep_render_tile(13,7,7,3)==84 && !prefix_dd_used,"Precise prefix escaped its exponent guard");
        if(!variant)memcpy(expected,output,84);
        else require(!memcmp(expected,output,84),"Guarded precise prefix changed the legacy path");
    }
    deep_set_options(saved);
}
static void check_variants(void){
    unsigned saved_options=deep_options;
    const unsigned variants[]={11,15,27,43,75,139,255,267,511,779};uint32_t expected[561];
    for(unsigned fixture=0;fixture<3;++fixture){
        for(unsigned variant=0;variant<sizeof(variants)/sizeof(variants[0]);++variant){
            /* The exponent-1600 case needs only the baseline and adaptive
               combination here; independent BigInt WASM fixtures cover its colours. */
            if(fixture==2 && variant!=0 && variant!=2 && variant!=7 && variant!=8)continue;
            deep_set_options(variants[variant]);
            if(!fixture)prepare("0.743643887037151",-1,"0.13182590420533",1,-32,4096);
            else prepare("0.0",1,"1.0",1,fixture==1?-400:-1600,2048);
            unsigned width=fixture?33:7,height=fixture?17:3,tx=fixture?0:13,ty=fixture?0:7;
            unsigned bytes=deep_render_tile(tx,ty,width,height),retries=0;
            while(!bytes && deep_needs_precision() && retries++<32){
                require(deep_grow_precision(fraction*32+64),"Variant precision growth failed");
                bytes=deep_render_tile_resume(tx,ty,width,height);
            }
            require(bytes==width*height*4,"Variant render did not settle");
            if(!variant)memcpy(expected,output,bytes);
            else for(unsigned pixel=0;pixel<width*height;++pixel){
                require((expected[pixel]==UINT32_C(0xff000000))==(output[pixel]==UINT32_C(0xff000000)),
                    "Variant changed membership");
                for(unsigned channel=0;channel<4;++channel){
                    int a=(expected[pixel]>>(channel*8))&255,b=(output[pixel]>>(channel*8))&255;
                    require(abs(a-b)<=1,"Variant colour differs beyond the existing one-channel bound");
                }
            }
        }
    }
    deep_set_options(saved_options);
}
int main(void){
    require(!deep_allocate(0,512),"Invalid precision accepted");
    require(!deep_allocate(0x7fffffbfu,0x7fffffbfu),"Workspace size overflow was accepted");
    check_bla_pruning();check_local_reference_reuse();check_squares();check_karatsuba();check_growth_and_resume();check_rescaled_addition();check_exact_exponent_shifts();check_reference_coordinates();
    check_big_conversion();check_adaptive_boundaries();check_analytic_deep_boundaries();check_black_certificates();check_precise_series();check_variants();
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
