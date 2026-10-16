# Offline builds require only Apple's Command Line Tools.
.PHONY: all web check serve clean rebuild-toolchain inspect bench bench-optimizations
.NOTPARALLEL:
all web check serve rebuild-toolchain inspect bench bench-optimizations:
	@/bin/sh build-support/scripts/build.sh $@

clean:
	@for attempt in 1 2 3; do \
		/bin/sh build-support/scripts/build.sh clean; \
	done
