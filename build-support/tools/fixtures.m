#import <Foundation/Foundation.h>
/* Isolated browser-test deployments; never change the published product. */
int main(int argc, const char **argv) {
    @autoreleasepool {
        if(argc!=3)return 2;
        NSFileManager *fm=NSFileManager.defaultManager;NSError *error=nil;
        NSString *source=@(argv[1]),*tests=@(argv[2]);
        NSString *run=NSUUID.UUID.UUIDString.lowercaseString;
        NSString *relative=[@"fixtures/" stringByAppendingString:run];
        NSString *parent=[tests stringByAppendingPathComponent:relative];
        if(![fm createDirectoryAtPath:parent withIntermediateDirectories:YES attributes:nil error:&error]){fprintf(stderr,"%s\n",error.description.UTF8String);return 1;}
        NSString *release=[[NSString stringWithContentsOfFile:[source stringByAppendingPathComponent:@"release.txt"] encoding:NSUTF8StringEncoding error:nil] stringByTrimmingCharactersInSet:NSCharacterSet.whitespaceAndNewlineCharacterSet];
        for(NSString *name in @[@"missing",@"update"]){
            NSString *destination=[parent stringByAppendingPathComponent:name];
            if(![fm copyItemAtPath:source toPath:destination error:&error]){fprintf(stderr,"%s\n",error.description.UTF8String);return 1;}
            if([name isEqual:@"missing"]){
                NSString *file=[destination stringByAppendingPathComponent:[NSString stringWithFormat:@"releases/%@/engine-simd.wasm",release]];
                if(![fm moveItemAtPath:file toPath:[file stringByAppendingString:@".missing"] error:&error]){fprintf(stderr,"%s\n",error.description.UTF8String);return 1;}
            }
        }
        NSDictionary *result=@{@"missing":[NSString stringWithFormat:@"/internal/tests/%@/missing/",relative],
            @"update":[NSString stringWithFormat:@"/internal/tests/%@/update/",relative],@"release":release};
        NSData *json=[NSJSONSerialization dataWithJSONObject:result options:NSJSONWritingPrettyPrinted error:nil];
        if(![json writeToFile:[tests stringByAppendingPathComponent:@"fixtures.json"] options:0 error:&error]){fprintf(stderr,"%s\n",error.description.UTF8String);return 1;}
        puts("Isolated missing-resource and update deployments prepared.");
    }
    return 0;
}
