# PNG metadata and sRGB

Every completed export records the **final frame's rendering snapshot**, before
any pixel strips are read. Navigation after that point cannot change its metadata.
The native image menu saves this same PNG through the existing File/object URL.
Copying an image through another application's clipboard may discard metadata.

## Authoritative JSON (schema version 1)

The uncompressed UTF-8 `iTXt` field `Mandelbrot.Metadata` is authoritative.
All text, XMP and EXIF copies are generated from this one record.

| JSON field | Meaning |
| --- | --- |
| `schema_version` | Integer `1` |
| `fractal` | `Mandelbrot` |
| `center_x`, `center_y` | Exact decimal **strings** of the binary fixed-point centre; real part and imaginary part, positive upwards |
| `zoom_exponent` | Decimal **string** of the actual JavaScript Number, using `String(view.zoom)` without rounding |
| `zoom_base` | Integer `2`: zoom exponent `5` means magnification `2^5 = 32` |
| `width`, `height` | Integer pixel dimensions of the exported PNG |
| `imaginary_axis` | `up` |
| `pixel_mapping` | `mandelbrot-view-v1` |
| `precision_bits` | Number of binary fractional bits in the centre coordinates |
| `iterations` | Rendering snapshot's iteration limit |
| `pixel_step_mantissa` | Decimal **string** of the actual `view.mantissa` Number |
| `pixel_step_exponent` | Actual integer `view.exponent` |
| `color_space` | `sRGB` |
| `icc_profile` | `sRGB IEC61966-2.1` |

Coordinates come from `fixedDecimal(view.real, view.bits)` and
`fixedDecimal(view.imag, view.bits)`, retaining **every** digit of the terminating
decimal expansion. Never convert them to floating point when reading the file.
Zoom and step mantissa retain the available Number precision; JavaScript's
exponential decimal notation is possible for extreme Number values. No export
computes `2 ** zoom`, which can overflow even for valid deep-zoom views.

### Pixel mapping

For physical image dimensions `W`, `H` and zoom exponent `Z`, the nominal step is
`max(3 / W, 2.5 / H) * 2^(-Z)`. The actual snapshot stores the step as
`pixel_step_mantissa * 2^pixel_step_exponent`; use those saved values to reproduce
the scale, including the renderer's floating-point evaluation of the nominal
formula. Pixel centres `(px, py)`, with `(0, 0)` at the PNG's top left, map to:

```text
x = center_x + (px + 0.5 - W/2) * pixel_step
y = center_y + (H/2 - py - 0.5) * pixel_step
```

At shallow zoom the existing renderer evaluates coordinates with doubles; deep
zoom uses its adaptive arithmetic. The centre fields preserve the exact chosen
fixed-point view in either case. Metadata does not alter the render kernel.

## Other representations

Three ASCII `tEXt` fields expose `Mandelbrot.CenterX`, `Mandelbrot.CenterY` and
`Mandelbrot.ZoomExponent` directly.

The uncompressed UTF-8 `iTXt` field `XML:com.adobe.xmp` contains an XMP packet
using the namespace `https://github.com/cafe-megabyte/Mandelbrot/ns/1.0/`.
Properties are text elements: `mb:SchemaVersion`, `mb:Fractal`, `mb:CenterX`,
`mb:CenterY`, `mb:ZoomExponent`, `mb:ZoomBase`, `mb:Width`, `mb:Height`,
`mb:ImaginaryAxis`, `mb:PixelMapping`, `mb:PrecisionBits`, `mb:Iterations`,
`mb:PixelStepMantissa`, `mb:PixelStepExponent`, `mb:ColorSpace` and `mb:ICCProfile`.
In particular, coordinates have no floating-point RDF datatype.

Exactly one `eXIf` chunk contains little-endian TIFF, starting with `II`, magic
`42`, and the IFD0 offset. There is **no** JPEG APP1 header or `Exif\0\0` prefix.
Offsets are relative to the TIFF header, values are word-aligned, directories
are sorted by tag ID and next-IFD pointers are zero.

| Directory / tag | Type and content |
| --- | --- |
| IFD0 `0xFF58` | TIFF ASCII, null-terminated exact `center_x` |
| IFD0 `0xFF59` | TIFF ASCII, null-terminated exact `center_y` |
| IFD0 `0xFF5A` | TIFF ASCII, null-terminated `zoom_exponent` |
| IFD0 `0x8769` | LONG pointer to ExifIFD |
| ExifIFD `0x9286` UserComment | UNDEFINED: eight bytes `ASCII\0\0\0`, followed by the full JSON as ASCII, escaping non-ASCII UTF-16 code units as `\uXXXX` |
| ExifIFD standard fields | ExifVersion `0232`, RGB ComponentsConfiguration, FlashpixVersion `0100`, ColorSpace `1` (sRGB), PixelXDimension and PixelYDimension |

The private IDs are proprietary and **not exclusively registered**. They were
checked against the upstream [ExifTool EXIF table](https://github.com/exiftool/exiftool/blob/master/lib/Image/ExifTool/Exif.pm)
on 2026-10-17; no assignments for these three IDs were present. Recheck before
publishing. `0xFE58` is Adobe Camera Raw's MoireFilter and must not be used.
Other software may expose the private IDs under generic names or ignore them;
XMP and UserComment provide self-describing copies.

## Embedded colour profile

`iCCP` embeds the complete, unchanged **ICC v2 sRGB IEC61966-2.1 profile**,
copyright Hewlett-Packard Company, 1998. The source bytes were taken from
macOS's `/System/Library/ColorSync/Profiles/sRGB Profile.icc`; the profile's
internal description is exactly `sRGB IEC61966-2.1`.
This assigns the existing RGB samples to standard sRGB (IEC 61966-2-1); it does
not convert or modify pixel values. ExifIFD also identifies sRGB.

The 3144-byte profile is precompressed with zlib in `web/srgb-profile.js`, so
neither building nor exporting needs a network request, an installed system
profile, a compression API for the profile, or an extra runtime dependency.
Its SHA-256 after decompression is:

```text
2b3aa1645779a9e634744faf9b01e9102b0c9b88fd6deced7934df86b949af7e
```

The original Hewlett-Packard copyright tag and all profile bytes are preserved.
`gAMA` (`45455`) and `cHRM`
(standard sRGB/D65 chromaticities) provide fallback information for readers
without ICC support. There is no additional `sRGB` chunk, following the
[PNG specification's recommendation](https://www.w3.org/TR/png/#11iCCP)
against combining it with `iCCP`.

The chunk order is `IHDR`, `iCCP`, `gAMA`, `cHRM`, three `tEXt`, JSON `iTXt`,
XMP `iTXt`, `eXIf`, consecutive `IDAT`, `IEND`. Image data still uses the same
strip buffers and deflate/store compression paths.

## Verification

`make check` includes metadata serialization and TIFF layout checks and verifies
that the release includes both new modules. The browser's `export.html` check
also verifies all chunk CRCs and ordering, JSON/text/XMP/EXIF agreement, the ICC
hash, every raw and browser-decoded RGBA byte, buffer bounds, native context
menu handling and offline repair. It covers fractional zoom, deep zoom through
`2^4000` and the final frame snapshot during later navigation, on both encoders.

For an independent saved-file inspection:

```sh
exiftool -a -G1 -s -u -H mandelbrot.png
pngcheck -v mandelbrot.png
```

ExifTool need not assign friendly names to private tags to read their values.
Custom XMP properties likewise remain discoverable by their namespace.
