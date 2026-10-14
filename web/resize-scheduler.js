export const LIVE_BUDGET_MS = 32;
export const RESIZE_SETTLE_MS = 150;

// One live frame at a time: size events replace the target, never a running
// live job. A deadline stops dispatch at tile boundaries without killing workers.
export function createResizeScheduler({start, cancel, reuse, state,
  now = () => performance.now(), setTimer = setTimeout, clearTimer = clearTimeout,
  requestFrame = requestAnimationFrame, cancelFrame = cancelAnimationFrame}) {
  let latest, active, completeFrame, costPerPixel, sequence = 0;
  let resizing = false, deferred = false, disposed = false, held = false;
  let settleTimer = 0, deadlineTimer = 0, frameRequest = 0, mode;
  const same = (a, b) => a && b && a.width === b.width && a.height === b.height &&
    a.cssWidth === b.cssWidth && a.cssHeight === b.cssHeight && a.view?.revision === b.view?.revision;

  function notify(next, reason) {
    if (mode === next) return;
    mode = next;
    state({mode, reason, budgetMilliseconds: LIVE_BUDGET_MS});
  }
  function stop() {
    clearTimer(deadlineTimer); deadlineTimer = 0;
    if (active) { const id = active.id; active = null; cancel(id); }
  }
  function defer(reason) {
    deferred = true;
    cancelFrame(frameRequest); frameRequest = 0;
    stop(); notify('deferred', reason);
  }
  function begin(kind) {
    stop();
    const started = now();
    const job = {id: ++sequence, kind, size: latest, started,
      deadline: kind === 'live' ? started + LIVE_BUDGET_MS : Infinity};
    active = job;
    if (kind === 'live') deadlineTimer = setTimer(() => defer('deadline'), LIVE_BUDGET_MS);
    start(latest, job);
  }
  function queueLive() {
    if (disposed || !resizing || deferred || active || frameRequest ||
      same(completeFrame?.size, latest)) return;
    frameRequest = requestFrame(() => {
      frameRequest = 0;
      if (disposed || !resizing || deferred || active) return;
      if (costPerPixel * latest.width * latest.height > LIVE_BUDGET_MS) defer('estimate');
      else begin('live');
    });
  }
  function settle() {
    settleTimer = 0; resizing = false;
    cancelFrame(frameRequest); frameRequest = 0;
    stop(); notify('idle', 'settled');
    // Live and final use the same accurate module. Reuse only if the renderer
    // still owns that complete displayed image, never a historical frame.
    if (same(completeFrame?.size, latest) && reuse(completeFrame)) return;
    begin('final');
  }
  function update(size) {
    if (disposed || same(size, latest)) return;
    latest = size;
    if (!size.width || !size.height) {
      clearTimer(settleTimer); settleTimer = 0;
      cancelFrame(frameRequest); frameRequest = 0;
      stop(); latest = null; completeFrame = null; resizing = false; notify('idle', 'empty'); return;
    }
    if (!active && !completeFrame && !resizing) { notify('idle', 'initial'); begin('final'); return; }
    if (!resizing) { resizing = true; deferred = false; notify('live', 'resize'); }
    if (active?.kind === 'final') stop();
    clearTimer(settleTimer); settleTimer = held ? 0 : setTimer(settle, RESIZE_SETTLE_MS);
    if (held) { defer('navigation'); return; }
    queueLive();
  }
  function accept(id) {
    if (disposed || active?.id !== id) return false;
    // Timers can run late. Check the clock before accepting any tile or frame.
    if (active.kind === 'live' && now() >= active.deadline) { defer('deadline'); return false; }
    return true;
  }
  function complete(id) {
    if (!accept(id)) return false;
    clearTimer(deadlineTimer); deadlineTimer = 0;
    const milliseconds = now() - active.started;
    completeFrame = {...active, milliseconds}; active = null;
    costPerPixel = milliseconds / (completeFrame.size.width * completeFrame.size.height);
    queueLive();
    return true;
  }
  function invalidate() {
    if (disposed || !latest) return;
    // A completed fullscreen transition requires a fresh final calculation,
    // even if an earlier frame happened to use the same pixel dimensions.
    completeFrame = null; resizing = true;
    defer('refresh');
    clearTimer(settleTimer); settleTimer = setTimer(settle, RESIZE_SETTLE_MS);
  }
  function dispose() {
    if (disposed) return;
    disposed = true;
    clearTimer(settleTimer); cancelFrame(frameRequest); stop();
  }
  function hold(value) {
    if (disposed || held === value) return;
    held = value;
    if (held) { clearTimer(settleTimer); settleTimer = 0; resizing = true; defer('navigation'); }
    else if (latest) { clearTimer(settleTimer); settleTimer = setTimer(settle, 0); }
  }
  return {update, accept, complete, invalidate, hold, dispose};
}
