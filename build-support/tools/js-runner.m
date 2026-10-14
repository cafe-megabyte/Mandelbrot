#import <Foundation/Foundation.h>
#import <JavaScriptCore/JavaScriptCore.h>
int main(int argc, const char **argv) {
    @autoreleasepool {
        if (argc < 3) return 2;
        NSData *data = [NSData dataWithContentsOfFile:@(argv[1])];
        NSString *script = [NSString stringWithContentsOfFile:@(argv[2]) encoding:NSUTF8StringEncoding error:nil];
        if (!data || !script) return 2;
        NSMutableArray *bytes = [NSMutableArray new];
        const uint8_t *p = data.bytes;
        for (NSUInteger i = 0; i < data.length; ++i) [bytes addObject:@(p[i])];
        JSContext *context = [JSContext new];
        __block BOOL failed = NO;
        context.exceptionHandler = ^(JSContext *ctx, JSValue *exception) {
            (void)ctx; fprintf(stderr, "%s\n", exception.toString.UTF8String); failed = YES;
        };
        context[@"moduleBytes"] = bytes;
        context[@"report"] = ^(NSString *s) { puts(s.UTF8String); fflush(stdout); };
        context[@"readText"] = ^NSString *(NSString *path) { return [NSString stringWithContentsOfFile:path encoding:NSUTF8StringEncoding error:nil]; };
        context[@"readBytes"] = ^NSArray *(NSString *path) {
            NSData *d = [NSData dataWithContentsOfFile:path]; if (!d) return nil;
            NSMutableArray *values = [NSMutableArray new]; const uint8_t *p = d.bytes;
            for (NSUInteger i = 0; i < d.length; i++) [values addObject:@(p[i])];
            return values;
        };
        context[@"writeBytes"] = ^BOOL(NSString *path, NSArray *values) {
            NSString *root = [[[NSFileManager defaultManager] currentDirectoryPath] stringByAppendingString:@"/build/internal/"];
            NSString *absolute = [[NSURL fileURLWithPath:path].path stringByStandardizingPath];
            if (![absolute hasPrefix:root]) return NO;
            NSMutableData *d = [NSMutableData dataWithLength:values.count];
            uint8_t *target = d.mutableBytes;
            for (NSUInteger i = 0; i < values.count; ++i) target[i] = [values[i] unsignedCharValue];
            return [d writeToFile:absolute atomically:NO];
        };
        [context evaluateScript:script withSourceURL:[NSURL fileURLWithPath:@(argv[2])]];
        if (failed || ![context[@"testDone"] toBool]) return 1;
        return 0;
    }
}
