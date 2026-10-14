# Original source archives

`toolchain/xcc/` contains exactly one unmodified upstream source archive. Its
filename and extension are arbitrary; extraction uses the archive's contents.
No hashes are used for validation or cache keys.

- Project: [XCC](https://github.com/tyfkda/xcc), MIT license.
- Original URL: https://codeload.github.com/tyfkda/xcc/tar.gz/refs/heads/main
- Snapshot downloaded: 3 October 2026, 502,170 bytes.
- Local filename initially: `source.tar.gz`.
- Patch: `build-support/patches/xcc-host-only.patch` removes the WASI library
  follow-up from the native `wcc` target. Apple Clang compiles our C sources;
  `wcc` is used only as the WebAssembly object linker.

The archive is the project's upstream snapshot. The build never downloads anything.
Replacing it requires a version compatible with our patch and WASM checks.
The upstream license is included in the generated website package.
