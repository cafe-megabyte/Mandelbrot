import {renderBands} from './view.js';

// Keep jobs bounded, and split expensive work only at exact pixel boundaries.
// A mirrored band's top half maps to the bottom half of its reflected band.
export function createTileQueue(width, height, view, {adaptive = true, targetMilliseconds = 12, compact = false, minPixels = 1} = {}) {
  if (!Number.isFinite(minPixels)) throw new RangeError('minPixels must be finite');
  minPixels = Math.max(1, Math.ceil(minPixels));
  // Start at the established size so cheap deep regions retain the same
  // message/reference count. Subdivide only after observing expensive work.
  const plan = renderBands(height, view, 64);
  const jobs = [];
  for (const band of plan.bands) for (let x = 0; x < width; x += 256)
    jobs.push({x, ...band, width: Math.min(256, width - x)});
  let cursor = 0, total = jobs.length, costPerPixel = 0;
  const split = [];
  return {
    computedRows: plan.computedRows, mirroredRows: plan.mirroredRows,
    get total() { return total; },
    get exhausted() { return cursor === jobs.length && !split.length; },
    observe(milliseconds, pixels) {
      if (!adaptive || !view.deep || !(milliseconds > 0) || !pixels) return;
      const sample = milliseconds / pixels;
      costPerPixel = costPerPixel ? Math.max(sample, costPerPixel * 0.85) : sample;
    },
    take() {
      let job = split.pop() || jobs[cursor++];
      if (!job) { cursor = jobs.length; return null; }
      while (adaptive && view.deep && costPerPixel * job.width * job.height > targetMilliseconds) {
        // A compact footprint tightens the local-reference radius without
        // increasing its pixel budget. Keep both horizontal children >=32;
        // original narrow frame-edge tiles remain valid.
        const splitWidth = compact ? job.width >= 64 : job.width > 32;
        if (splitWidth && (job.height === 1 || (compact && job.width > job.height))) {
          const first = Math.ceil(job.width / 2);
          // Splitting duplicates reference setup. An optional area floor
          // amortizes that cost; both children must satisfy the floor.
          // Original narrow/short frame-edge jobs may already be smaller.
          if ((job.width - first) * job.height < minPixels) break;
          split.push({...job, x: job.x + first, width: job.width - first});
          job = {...job, width: first};
        } else if (job.height > 1) {
          const first = Math.ceil(job.height / 2), remainder = job.height - first;
          if (job.width * remainder < minPixels) break;
          split.push({...job, y: job.y + first, height: remainder});
          job = {...job, height: first, mirrorY: job.mirrorY === null ? null : job.mirrorY + remainder};
        } else break;
        ++total;
      }
      return job;
    }
  };
}
