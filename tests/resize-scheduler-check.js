const {createResizeScheduler, LIVE_BUDGET_MS, RESIZE_SETTLE_MS} = new Function(
  readText('web/resize-scheduler.js').replace(/^export /gm, '') +
  '\nreturn {createResizeScheduler, LIVE_BUDGET_MS, RESIZE_SETTLE_MS};')();
const assert = (condition, message) => { if (!condition) throw new Error(message); };
const size = (width, height = 100) => ({width, height, cssWidth: width, cssHeight: height});
let checks = 0;
function fixture() {
  let time = 0, sequence = 0, canReuse = true;
  const tasks = new Map(), starts = [], cancels = [], states = [], reused = [];
  const timer = (fn, ms) => { const id = ++sequence; tasks.set(id, {fn, at: time + ms}); return id; };
  const scheduler = createResizeScheduler({
    start: (target, job) => starts.push({...job, size: target}),
    cancel: id => cancels.push(id), reuse: frame => { reused.push(frame.id); return canReuse; },
    state: info => states.push(info), now: () => time,
    setTimer: timer, clearTimer: id => tasks.delete(id),
    requestFrame: fn => timer(fn, 16), cancelFrame: id => tasks.delete(id)
  });
  function advance(ms) {
    const end = time + ms;
    for (;;) {
      let next;
      for (const [id, task] of tasks) if (task.at <= end && (!next || task.at < next[1].at)) next = [id, task];
      if (!next) break;
      time = Math.max(time, next[1].at); tasks.delete(next[0]); next[1].fn();
    }
    time = end;
  }
  return {scheduler, starts, cancels, states, reused, advance, tasks,
    jump: ms => { time += ms; }, disallowReuse: () => { canReuse = false; },
    last: () => starts[starts.length - 1], mode: () => states[states.length - 1]?.mode};
}
function initial(f, milliseconds = 2, width = 100) {
  f.scheduler.update(size(width)); f.advance(milliseconds);
  assert(f.scheduler.complete(f.last().id), 'Initial frame was rejected');
}
function check(name, fn) { fn(); ++checks; report(`PASS: ${name}`); }

check('initial/final frames are unbounded; duplicate sizes do not restart work', () => {
  const f = fixture(); f.scheduler.update(size(100)); f.advance(500);
  f.scheduler.update(size(100)); assert(f.starts.length === 1, 'Duplicate restarted frame');
  assert(f.scheduler.complete(f.last().id), 'Initial frame had a live deadline');
  f.scheduler.update(size(101)); f.advance(RESIZE_SETTLE_MS);
  assert(f.last().kind === 'final', 'Expensive resize did not settle to final');
  f.advance(500); assert(f.scheduler.complete(f.last().id), 'Settled final had a deadline');
});
check('one live frame runs while newer sizes replace only the target', () => {
  const f = fixture(); initial(f); f.scheduler.update(size(101)); f.advance(16);
  const live = f.last(); assert(live.kind === 'live', 'Live job missing');
  f.advance(3); f.scheduler.update(size(102)); f.scheduler.update(size(103));
  assert(f.starts.length === 2 && !f.cancels.length, 'Resize aborted or duplicated live work');
  f.advance(4); assert(f.scheduler.complete(live.id), 'Fast live frame rejected');
  f.advance(16); assert(f.last().size.width === 103, 'Latest size was not scheduled');
});
check('deadline cancels live work until 150 ms after the last real size change', () => {
  const f = fixture(); initial(f); f.scheduler.update(size(101)); f.advance(16);
  const live = f.last(); f.advance(LIVE_BUDGET_MS);
  assert(f.mode() === 'deferred' && f.cancels.includes(live.id), 'Deadline did not defer');
  f.scheduler.update(size(110)); f.advance(100); f.scheduler.update(size(120));
  f.advance(RESIZE_SETTLE_MS - 1); assert(f.starts.length === 2, 'Deferred resize started work');
  f.advance(1); assert(f.last().kind === 'final' && f.last().size.width === 120, 'Final target incorrect');
  assert(!f.scheduler.accept(live.id), 'Canceled generation was accepted');
  f.advance(100); assert(f.scheduler.complete(f.last().id), 'Final calculation was limited');
});
check('clock checks reject late results even before the deadline timer runs', () => {
  const f = fixture(); initial(f); f.scheduler.update(size(101)); f.advance(16);
  f.jump(LIVE_BUDGET_MS + 1);
  assert(!f.scheduler.accept(f.last().id) && f.mode() === 'deferred', 'Late tile was accepted');
});
check('previous duration predicts expensive sizes; a later small gesture resumes live work', () => {
  const f = fixture(); initial(f, 100); f.scheduler.update(size(110)); f.advance(16);
  assert(f.mode() === 'deferred' && f.starts.length === 1, 'Expensive estimate started live work');
  f.advance(RESIZE_SETTLE_MS); const final = f.last(); f.advance(2); f.scheduler.complete(final.id);
  f.scheduler.update(size(100)); f.advance(16);
  assert(f.last().kind === 'live' && f.mode() === 'live', 'New fast gesture stayed deferred');
});
check('a resize invalidates an unfinished final frame', () => {
  const f = fixture(); f.scheduler.update(size(100)); const first = f.last();
  f.scheduler.update(size(110)); assert(f.cancels.includes(first.id), 'Old final kept running');
  assert(!f.scheduler.complete(first.id), 'Old final completed after cancellation');
});
check('the latest complete accurate live frame is reused after settling', () => {
  const f = fixture(); initial(f); f.scheduler.update(size(101)); f.advance(16);
  const live = f.last(); f.advance(2); f.scheduler.complete(live.id);
  f.advance(RESIZE_SETTLE_MS);
  assert(f.reused.includes(live.id) && f.starts.length === 2 && f.mode() === 'idle', 'Accurate frame was recomputed');
});
check('a historical image cannot substitute for the current renderer frame', () => {
  const f = fixture(); initial(f); f.scheduler.update(size(101)); f.advance(16);
  f.advance(2); f.scheduler.complete(f.last().id); f.disallowReuse();
  f.advance(RESIZE_SETTLE_MS); assert(f.last().kind === 'final' && f.starts.length === 3, 'Unavailable image was reused');
});
check('fullscreen invalidation forces one fresh final frame even at unchanged dimensions', () => {
  const f = fixture(); initial(f); const previous = f.last();
  f.scheduler.invalidate(); f.advance(5); f.scheduler.invalidate(); f.scheduler.update(size(100));
  f.advance(RESIZE_SETTLE_MS - 1);
  assert(f.starts.length === 1 && f.mode() === 'deferred', 'Transition started work before settling');
  f.advance(1);
  assert(f.starts.length === 2 && f.last().id !== previous.id && f.last().kind === 'final', 'Fullscreen reused its earlier frame');
  assert(!f.reused.length, 'Fullscreen reused a completed image');
  f.advance(100); assert(f.scheduler.complete(f.last().id), 'Fresh fullscreen frame had a live deadline');
});
check('fullscreen transition discards live work and uses the final measured viewport', () => {
  const f = fixture(); initial(f); f.scheduler.update(size(101)); f.advance(16);
  const live = f.last(); f.scheduler.invalidate();
  assert(f.cancels.includes(live.id) && !f.scheduler.accept(live.id), 'Transition retained a stale live job');
  f.advance(50); f.scheduler.update(size(200)); f.advance(100); f.scheduler.update(size(210));
  f.advance(RESIZE_SETTLE_MS - 1); assert(f.starts.length === 2, 'Transition started extra live work');
  f.advance(1);
  assert(f.last().kind === 'final' && f.last().size.width === 210, 'Fullscreen did not use the settled viewport');
});
check('duplicates do not postpone settling; empty and disposed viewports schedule nothing', () => {
  const f = fixture(); initial(f); f.scheduler.update(size(101)); f.advance(16);
  f.advance(2); f.scheduler.complete(f.last().id);
  f.advance(100); f.scheduler.update(size(101)); f.advance(32);
  assert(f.mode() === 'idle', 'Duplicate postponed settling');
  f.scheduler.update(size(0)); assert(f.tasks.size === 0, 'Empty viewport left work queued');
  f.scheduler.update(size(200)); assert(f.last().kind === 'final', 'Reappearing viewport missed initial frame');
  f.scheduler.update(size(201)); const count = f.starts.length;
  f.scheduler.dispose(); f.advance(1000); f.scheduler.update(size(202));
  assert(f.starts.length === count && f.tasks.size === 0, 'Disposed scheduler started work');
});
report(`${checks} resize scheduler checks passed.`);
var testDone = true;
