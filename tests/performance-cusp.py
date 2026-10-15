#!/usr/bin/env python3
"""Compile and compare the full native Cusp image; writes only to build/internal/performance.

Run: python3 tests/performance-cusp.py
Requires clang and the original core snapshot in build/internal/performance/before/core/.
"""

import datetime
import hashlib
import json
from pathlib import Path
import platform
import statistics
import subprocess


ROOT = Path(__file__).resolve().parents[1]
DESTINATION = ROOT / "build/internal/performance"
DESTINATION.mkdir(parents=True, exist_ok=True)
COMPILER_OPTIONS = ["-O3", "-ffp-contract=off", "-fno-math-errno", "-std=c11",
                    "-Wall", "-Wextra", "-Werror"]
VERSIONS = ("before", "after")


def compile_versions():
    for version in VERSIONS:
        command = ["clang", *COMPILER_OPTIONS]
        if version == "before":
            command.append("-DBASELINE")
        command.extend(["tests/performance-cusp.c", "-lm", "-o",
                        f"build/internal/performance/cusp-{version}"])
        subprocess.run(command, cwd=ROOT, check=True)


def run_pair(order):
    samples = {}
    for version in order:
        output = subprocess.check_output([str(DESTINATION / f"cusp-{version}")],
                                         cwd=ROOT, text=True)
        samples[version] = json.loads(output)
    images = {version: (DESTINATION / f"full-cusp-{version}.rgba").read_bytes()
              for version in VERSIONS}
    expected_bytes = 1024 * 768 * 4
    if any(len(image) != expected_bytes for image in images.values()):
        raise RuntimeError("Incomplete Cusp image")
    before, after = (images[version] for version in VERSIONS)
    return {
        "order": list(order),
        "samples": samples,
        "exactBytesEqual": before == after,
        "differentPixels": sum(before[i:i + 4] != after[i:i + 4]
                               for i in range(0, expected_bytes, 4)),
        "comparedPixels": 1024 * 768,
        "comparedBytes": expected_bytes,
        "sha256": {version: hashlib.sha256(image).hexdigest()
                   for version, image in images.items()},
    }


def main():
    compile_versions()
    warmup = run_pair(VERSIONS)
    pairs = [run_pair(VERSIONS if index % 2 == 0 else VERSIONS[::-1])
             for index in range(3)]
    medians = {version: statistics.median(pair["samples"][version]["milliseconds"]
                                         for pair in pairs)
               for version in VERSIONS}
    result = {
        "date": datetime.datetime.now(datetime.timezone.utc).isoformat(),
        "runtime": "Native clang executable; one fresh process per image",
        "platform": platform.platform(),
        "compiler": subprocess.check_output(["clang", "--version"], text=True).splitlines()[0],
        "compilerOptions": COMPILER_OPTIONS,
        "method": "One warmup per version, then three alternating measured pairs; median time",
        "scope": "Entire image in sequential 256x64 deep_render_tile calls, including local reference "
                 "preparation, render telemetry and RGBA copies. Compilation, allocation, initial "
                 "configuration and image file writes excluded. No browser, workers, canvas or PNG.",
        "warmupsPerVersion": 1,
        "samplesPerVersion": 3,
        "region": {"x": "0.25", "y": "0", "zoom": 18, "width": 1024, "height": 768,
                   "iterations": 5120},
        "flags": {"before": None, "after": 267},
        "baselineTelemetry": "ddFallbacks is null because the original core does not expose it",
        "warmup": warmup,
        "pairs": pairs,
        "mediansMs": medians,
        "relativeTimeChangePercent": 100 * (medians["after"] / medians["before"] - 1),
        "passed": all(pair["exactBytesEqual"] for pair in [warmup, *pairs]),
    }
    result_path = DESTINATION / "full-cusp-native.json"
    result_path.write_text(json.dumps(result, indent=2) + "\n")
    print(json.dumps({"result": str(result_path), "mediansMs": medians,
                      "relativeTimeChangePercent": result["relativeTimeChangePercent"],
                      "passed": result["passed"]}))
    if not result["passed"]:
        raise SystemExit("Cusp pixel regression: see full-cusp-native.json")


if __name__ == "__main__":
    main()
