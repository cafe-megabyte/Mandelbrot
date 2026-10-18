const library = new Function(
  ['web/view.js', 'web/resize-scheduler.js', 'web/navigation.js']
    .map(path => readText(path).replace(/^export /gm, '')).join('\n') +
  '\nreturn {createView,createResizeScheduler,createNavigation};')();
const assert = (condition, message) => { if (!condition) throw new Error(message); };
let checks = 0;
function fixture() {
  let time = 0, sequence = 0;
  const tasks = new Map(), changes = [], starts = [], captures = new Set();
  const timer = (fn, ms = 0) => { const id = ++sequence; tasks.set(id, {fn, at: time + ms}); return id; };
  const cancel = id => tasks.delete(id);
  class Target {
    constructor(parent) { this.parent = parent; this.listeners = []; this.style = {}; }
    get isConnected() { return this === window || !!this.parent?.isConnected; }
    addEventListener(type, callback, options) {
      this.listeners.push({type, callback, capture: options === true || !!options?.capture});
    }
    removeEventListener(type, callback, options) {
      const capture = options === true || !!options?.capture;
      this.listeners = this.listeners.filter(item => item.type !== type || item.callback !== callback || item.capture !== capture);
    }
    getBoundingClientRect() { return {left: 10, top: 20, width: 640, height: 360}; }
    setPointerCapture(id) { captures.add(id); }
    hasPointerCapture(id) { return captures.has(id); }
    releasePointerCapture(id) { captures.delete(id); }
    dispatch(type, properties = {}) {
      const event = {type, target: this, clientX: 330, clientY: 200, button: 0, deltaMode: 0, ctrlKey: false,
        defaultPrevented: false, preventDefault() { this.defaultPrevented = true; }, ...properties};
      const path = []; for (let target = this; target; target = target.parent) path.push(target);
      for (const capture of [true, false]) for (const target of capture ? [...path].reverse() : path)
        for (const listener of [...target.listeners]) if (listener.type === type && listener.capture === capture)
          listener.callback(event);
      return event;
    }
  }
  const window = new Target(), outside = new Target(window), root = new Target(window), child = new Target(root);
  const scheduler = library.createResizeScheduler({
    start: (size, job) => starts.push(job), cancel() {}, reuse: () => false, state() {},
    now: () => time, setTimer: timer, clearTimer: cancel,
    requestFrame: fn => timer(fn, 16), cancelFrame: cancel
  });
  const view = library.createView(); view.set({zoom: 3});
  const size = () => ({width: 640, height: 360, cssWidth: 640, cssHeight: 360, view: view.snapshot(640, 360)});
  scheduler.update(size()); scheduler.complete(starts[0].id);
  const create = new Function('window', 'performance', 'setTimeout', 'clearTimeout',
    readText('web/navigation.js').replace(/^export /gm, '') + '\nreturn createNavigation;')(
    window, {now: () => time}, timer, cancel);
  const navigation = create(root, view, active => {
    changes.push(active); scheduler.hold(active); scheduler.update(size());
  });
  function advance(ms) {
    const end = time + ms;
    for (;;) {
      let next;
      for (const item of tasks) if (item[1].at <= end && (!next || item[1].at < next[1].at)) next = item;
      if (!next) break;
      time = next[1].at; tasks.delete(next[0]); next[1].fn();
    }
    time = end;
  }
  return {root, child, outside, window, navigation, changes, starts, tasks, advance,
    zoom: () => view.snapshot(640, 360).zoom,
    dispose() { navigation.dispose(); scheduler.dispose(); }};
}
function check(name, fn) { fn(); ++checks; report(`PASS: ${name}`); }

check('Safari pinch cancels accompanying wheel events without zooming twice', () => {
  const f = fixture();
  assert(f.child.dispatch('gesturestart', {scale: 1}).defaultPrevented, 'Native gesture start was not canceled');
  f.child.dispatch('gesturechange', {scale: 2});
  assert(f.child.dispatch('wheel', {deltaY: -80, ctrlKey: true}).defaultPrevented,
    'Safari could magnify the page while the app was already handling the pinch');
  assert(f.zoom() === 4, 'Wheel and gesture both applied the same pinch');
  f.child.dispatch('gestureend', {scale: 2}); f.advance(0);
  assert(f.starts.length === 2 && f.starts[1].kind === 'final', 'Safari pinch did not produce an accurate final frame');
  f.dispose();
});
check('Safari pinch settles even when gestureend never arrives', () => {
  const f = fixture(); f.child.dispatch('gesturestart', {scale: 1});
  f.child.dispatch('gesturechange', {scale: 2}); f.advance(149);
  assert(f.starts.length === 1, 'Active Safari pinch started final work');
  f.advance(1);
  assert(f.changes.at(-1) === false && f.starts.length === 2 && f.starts[1].kind === 'final',
    'Missing gestureend left the renderer held on a blurry preview');
  f.root.dispatch('wheel', {deltaY: -80}); f.advance(150);
  assert(f.zoom() > 4 && f.starts.length === 3, 'An interrupted Safari gesture blocked later wheel zoom');
  f.dispose();
});
check('a Safari gesture can continue after an idle pause without repeating its cumulative scale', () => {
  const f = fixture(); f.child.dispatch('gesturestart', {scale: 1});
  f.child.dispatch('gesturechange', {scale: 2}); f.advance(150);
  f.child.dispatch('gesturechange', {scale: 4});
  assert(f.zoom() === 5, 'Resuming a paused pinch applied its previous scale twice');
  f.advance(100); f.child.dispatch('gesturechange', {scale: 8}); f.advance(149);
  assert(f.zoom() === 6 && f.changes.at(-1) === true, 'Ongoing gesture did not renew its idle deadline');
  f.advance(1); const count = f.changes.length;
  f.child.dispatch('gestureend', {scale: 8}); f.advance(0);
  assert(f.changes.length === count, 'Late gestureend restarted the already settled final frame');
  f.dispose();
});
check('Safari completion outside the rendering surface releases final rendering', () => {
  const f = fixture(); f.child.dispatch('gesturestart', {scale: 1});
  f.outside.dispatch('gesturechange', {scale: 2});
  const ended = f.outside.dispatch('gestureend', {scale: 2}); f.advance(0);
  assert(ended.defaultPrevented && f.zoom() === 4 && f.starts.length === 2,
    'Moving outside the root stranded a Safari gesture');
  f.dispose();
});
check('Safari keeps receiving a pinch on a canvas replaced by a preview', () => {
  const f = fixture(); f.child.dispatch('gesturestart', {scale: 1}); f.child.parent = null;
  assert(f.child.dispatch('gesturechange', {scale: 2}).defaultPrevented,
    'A replaced gesture target could fall back to native page magnification');
  f.advance(150); f.child.dispatch('gesturechange', {scale: 4});
  assert(f.zoom() === 5, 'Replacing the gesture target interrupted pinch scaling');
  assert(f.child.dispatch('gestureend', {scale: 4}).defaultPrevented, 'Detached target completion was missed');
  f.advance(0);
  assert(f.starts.length === 3 && !f.child.listeners.length, 'Detached gesture did not settle or release its target');
  f.dispose();
});
check('a Safari gesture cancels the preceding wheel idle callback', () => {
  const f = fixture(); f.root.dispatch('wheel', {deltaY: -20}); f.advance(100);
  f.child.dispatch('gesturestart', {scale: 1}); f.advance(40);
  f.child.dispatch('gesturechange', {scale: 2}); f.advance(20);
  assert(f.changes.every(Boolean) && f.starts.length === 1, 'An old wheel timer released an active Safari pinch');
  f.child.dispatch('gestureend', {scale: 2}); f.advance(0); f.dispose();
});
check('invalid Safari scales do not corrupt the view or keep it held', () => {
  const f = fixture(); f.child.dispatch('gesturestart', {scale: 1});
  for (const scale of [0, -1, NaN, Infinity, undefined]) f.child.dispatch('gesturechange', {scale});
  assert(f.zoom() === 3, 'Invalid gesture scale poisoned the view');
  f.child.dispatch('gesturechange', {scale: 2}); f.advance(150);
  assert(f.zoom() === 4 && f.changes.at(-1) === false, 'A valid change after an invalid scale could not recover');
  f.dispose();
});
check('leaving the window settles Safari navigation immediately', () => {
  for (const type of ['blur', 'pagehide']) {
    const f = fixture(); f.child.dispatch('gesturestart', {scale: 1});
    f.child.dispatch('gesturechange', {scale: 2}); f.window.dispatch(type); f.advance(0);
    assert(f.changes.at(-1) === false && f.starts.length === 2, `${type} left Safari navigation held`);
    f.advance(500);
    assert(f.starts.length === 2, `${type} left an idle callback that restarted final work`);
    f.dispose();
  }
});
check('unrelated Safari gestures outside the app keep their browser behavior', () => {
  const f = fixture();
  for (const type of ['gesturestart', 'gesturechange', 'gestureend'])
    assert(!f.outside.dispatch(type, {scale: 2}).defaultPrevented, 'Navigation captured an unrelated gesture');
  assert(f.zoom() === 3 && !f.changes.length, 'An unrelated gesture changed the view');
  f.dispose();
});
check('touch pointers remain the sole source of iPhone pinch scaling', () => {
  const f = fixture();
  f.root.dispatch('pointerdown', {pointerId: 1, clientX: 200, pointerType: 'touch'});
  f.child.dispatch('gesturestart', {scale: 1});
  f.root.dispatch('pointerdown', {pointerId: 2, clientX: 300, pointerType: 'touch'});
  f.root.dispatch('pointermove', {pointerId: 2, clientX: 400, pointerType: 'touch'});
  f.child.dispatch('gesturechange', {scale: 2}); f.advance(500);
  assert(f.zoom() === 4 && f.starts.length === 1, 'Safari events duplicated or prematurely settled the touch pinch');
  f.child.dispatch('gestureend', {scale: 2});
  f.root.dispatch('pointerup', {pointerId: 1}); f.root.dispatch('pointerup', {pointerId: 2}); f.advance(0);
  assert(f.starts.length === 2 && f.changes.at(-1) === false, 'Touch release did not start final rendering');
  f.dispose();
});
check('wheel-only pinch still settles and disposal removes all gesture callbacks', () => {
  const f = fixture(); f.root.dispatch('wheel', {deltaY: -80, ctrlKey: true}); f.advance(150);
  assert(f.zoom() > 3 && f.starts.length === 2, 'Firefox-style pinch stopped settling');
  f.child.dispatch('gesturestart', {scale: 1}); f.child.dispatch('gesturechange', {scale: 2});
  f.dispose(); const count = f.changes.length;
  assert(!f.tasks.size && !f.root.listeners.length && !f.window.listeners.length && !f.child.listeners.length,
    'Navigation leaked timers or event listeners');
  f.advance(1000); f.outside.dispatch('gestureend', {scale: 2});
  assert(f.changes.length === count, 'Disposed Safari navigation triggered another render');
});
report(`${checks} navigation checks passed.`);
var testDone = true;
