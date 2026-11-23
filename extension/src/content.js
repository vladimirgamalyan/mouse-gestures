// Mouse Gestures: content script.
// Recognizes gestures drawn while the right mouse button is held and performs actions.
// Does not read page content, stores nothing and sends nothing over the network.
(() => {
  'use strict';

  // Distance in pixels after which a movement counts as a gesture step.
  const STEP = 20;

  // A gesture is a string of directions: L — left, R — right, U — up, D — down.
  const GESTURES = {
    L: { action: 'back', label: 'Back' },
    R: { action: 'forward', label: 'Forward' },
    LR: { action: 'newTab', label: 'New tab' },
    DR: { action: 'closeTab', label: 'Close tab' },
    U: { action: 'scrollTop', label: 'Scroll to top' },
    D: { action: 'scrollBottom', label: 'Scroll to bottom' },
  };

  const ARROWS = { L: '←', R: '→', U: '↑', D: '↓' };

  // These actions are performed by the background script, which can control tabs.
  const MESSAGE_TYPE = 'mouse-gestures:action';
  const TAB_ACTIONS = new Set(['back', 'forward', 'newTab', 'closeTab']);

  // The current gesture, or null while the right button is not held.
  let gesture = null;
  // No context menu after a gesture: it arrives right after mouseup.
  let suppressMenu = false;
  let suppressTimer = 0;

  const listeners = [
    ['mousedown', onMouseDown],
    ['mousemove', onMouseMove],
    ['mouseup', onMouseUp],
    ['contextmenu', onContextMenu],
    ['keydown', onKeyDown],
    ['blur', onBlur],
  ];
  // Capture phase on window: we run before the page's own handlers.
  for (const [type, fn] of listeners) window.addEventListener(type, fn, true);

  // After the extension is updated or removed, the script in already open pages
  // loses its connection to the extension. It then removes its handlers.
  function extensionAlive() {
    return Boolean(globalThis.chrome?.runtime?.id);
  }

  function teardown() {
    for (const [type, fn] of listeners) window.removeEventListener(type, fn, true);
    abort();
  }

  // --- Mouse and keyboard events ---------------------------------------------

  function onMouseDown(e) {
    // Ignore synthetic events created by page scripts: otherwise a page
    // could, for example, close the tab with a fake "gesture".
    if (!e.isTrusted) return;
    if (e.button !== 2) {
      // Pressing another button during a gesture cancels it.
      if (gesture) cancel(gesture);
      return;
    }
    if (!extensionAlive()) {
      teardown();
      return;
    }
    abort();
    gesture = {
      dirs: '',
      points: [[e.clientX, e.clientY]],
      anchorX: e.clientX,
      anchorY: e.clientY,
      target: e.composedPath()[0],
      cancelled: false,
      overlay: null,
      frame: 0,
    };
  }

  function onMouseMove(e) {
    if (!gesture || !e.isTrusted) return;
    if (!(e.buttons & 2)) {
      // We missed the button release (for example, outside the window): drop the gesture.
      abort();
      return;
    }
    const g = gesture;
    const x = e.clientX;
    const y = e.clientY;
    g.points.push([x, y]);

    const dx = x - g.anchorX;
    const dy = y - g.anchorY;
    if (Math.abs(dx) >= STEP || Math.abs(dy) >= STEP) {
      const dir = Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? 'R' : 'L') : dy > 0 ? 'D' : 'U';
      if (!g.dirs.endsWith(dir)) g.dirs += dir;
      g.anchorX = x;
      g.anchorY = y;
    }
    if (g.dirs && !g.cancelled) scheduleDraw(g);
  }

  function onMouseUp(e) {
    if (!gesture || !e.isTrusted || e.button !== 2) return;
    const g = gesture;
    gesture = null;
    removeOverlay(g);
    // The mouse barely moved: this is a normal click, let the menu open.
    if (!g.dirs) return;
    blockNextContextMenu();
    if (!g.cancelled) perform(g);
  }

  function onContextMenu(e) {
    if (!suppressMenu) return;
    suppressMenu = false;
    clearTimeout(suppressTimer);
    e.preventDefault();
    e.stopImmediatePropagation();
  }

  function onKeyDown(e) {
    // Esc during a gesture cancels it.
    if (!gesture?.dirs || gesture.cancelled || !e.isTrusted || e.key !== 'Escape') return;
    cancel(gesture);
    e.preventDefault();
    e.stopImmediatePropagation();
  }

  function onBlur(e) {
    // In the capture phase this also receives blur of page elements; we only need the window's.
    if (e.target === window) abort();
  }

  function blockNextContextMenu() {
    suppressMenu = true;
    clearTimeout(suppressTimer);
    suppressTimer = setTimeout(() => {
      suppressMenu = false;
    }, 500);
  }

  // Cancel: stop drawing the gesture and skip the action,
  // but still suppress the menu when the button is released.
  function cancel(g) {
    g.cancelled = true;
    removeOverlay(g);
  }

  // Full reset without suppressing the menu.
  function abort() {
    if (gesture) removeOverlay(gesture);
    gesture = null;
  }

  // --- Actions ----------------------------------------------------------------

  function perform(g) {
    const def = GESTURES[g.dirs];
    if (!def) return;
    if (TAB_ACTIONS.has(def.action)) {
      sendToBackground(def.action);
    } else if (def.action === 'scrollTop') {
      scrollToEdge(g.target, 'top');
    } else if (def.action === 'scrollBottom') {
      scrollToEdge(g.target, 'bottom');
    }
  }

  function sendToBackground(action) {
    if (!extensionAlive()) {
      teardown();
      return;
    }
    try {
      chrome.runtime.sendMessage({ type: MESSAGE_TYPE, action }).catch(() => {});
    } catch {
      teardown();
    }
  }

  // Scrolls the nearest block under the cursor that can still move in the
  // requested direction, the way the mouse wheel does. If there is none, the page.
  function scrollToEdge(target, edge) {
    const el = findScroller(target, edge);
    if (!el) return;
    el.scrollTo({ top: edge === 'top' ? 0 : el.scrollHeight, behavior: 'instant' });
  }

  function findScroller(node, edge) {
    let el = node instanceof Element ? node : node?.parentElement;
    while (el && el !== document.body && el !== document.documentElement) {
      if (isScrollContainer(el) && canScroll(el, edge)) return el;
      el = el.parentElement ?? el.getRootNode().host ?? null;
    }
    const pageScrollers = [document.scrollingElement, document.body].filter(Boolean);
    return pageScrollers.find((s) => canScroll(s, edge)) ?? pageScrollers[0] ?? null;
  }

  function isScrollContainer(el) {
    const { overflowY } = getComputedStyle(el);
    return overflowY === 'auto' || overflowY === 'scroll' || overflowY === 'overlay';
  }

  function canScroll(el, edge) {
    if (edge === 'top') return el.scrollTop > 0;
    return el.scrollTop + el.clientHeight < el.scrollHeight - 1;
  }

  // --- On-screen hint: mouse trail and gesture name ---------------------------

  const HOST_STYLE = {
    all: 'initial',
    display: 'block',
    position: 'fixed',
    inset: '0',
    'z-index': '2147483647',
    'pointer-events': 'none',
  };

  function scheduleDraw(g) {
    if (g.frame) return;
    g.frame = requestAnimationFrame(() => {
      g.frame = 0;
      if (gesture === g && !g.cancelled) draw(g);
    });
  }

  function draw(g) {
    const ov = g.overlay ?? (g.overlay = createOverlay());
    if (!ov) return;

    const dpr = window.devicePixelRatio || 1;
    const width = ov.host.clientWidth;
    const height = ov.host.clientHeight;
    if (ov.canvas.width !== Math.round(width * dpr) || ov.canvas.height !== Math.round(height * dpr)) {
      ov.canvas.width = Math.round(width * dpr);
      ov.canvas.height = Math.round(height * dpr);
    }

    const ctx = ov.ctx;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);
    ctx.beginPath();
    const [first, ...rest] = g.points;
    ctx.moveTo(first[0], first[1]);
    for (const [x, y] of rest) ctx.lineTo(x, y);
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    // A light underlay keeps the line visible on dark pages too.
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.8)';
    ctx.lineWidth = 6;
    ctx.stroke();
    ctx.strokeStyle = '#1a73e8';
    ctx.lineWidth = 3;
    ctx.stroke();

    const def = GESTURES[g.dirs];
    ov.arrows.textContent = [...g.dirs].map((d) => ARROWS[d]).join(' ');
    ov.name.textContent = def ? def.label : 'Unknown gesture';
    ov.name.style.opacity = def ? '1' : '0.6';
  }

  function createOverlay() {
    const parent = document.documentElement;
    if (!parent) return null;

    // Our own element with a closed Shadow DOM: page styles do not affect the hint,
    // and page scripts cannot see its contents.
    const host = document.createElement('mouse-gestures-overlay');
    for (const [prop, value] of Object.entries(HOST_STYLE)) {
      host.style.setProperty(prop, value, 'important');
    }
    const root = host.attachShadow({ mode: 'closed' });

    const canvas = document.createElement('canvas');
    Object.assign(canvas.style, {
      position: 'absolute',
      left: '0',
      top: '0',
      width: '100%',
      height: '100%',
    });

    const label = document.createElement('div');
    Object.assign(label.style, {
      position: 'absolute',
      left: '50%',
      top: '50%',
      transform: 'translate(-50%, -50%)',
      padding: '12px 22px',
      borderRadius: '12px',
      background: 'rgba(32, 33, 36, 0.88)',
      boxShadow: '0 4px 16px rgba(0, 0, 0, 0.3)',
      color: '#fff',
      fontFamily: 'system-ui, "Segoe UI", sans-serif',
      textAlign: 'center',
      whiteSpace: 'nowrap',
      lineHeight: '1.3',
    });
    const arrows = document.createElement('div');
    Object.assign(arrows.style, { fontSize: '30px', fontWeight: '600' });
    const name = document.createElement('div');
    Object.assign(name.style, { fontSize: '15px', marginTop: '2px' });
    label.append(arrows, name);

    root.append(canvas, label);
    parent.append(host);
    return { host, canvas, ctx: canvas.getContext('2d'), arrows, name };
  }

  function removeOverlay(g) {
    if (g.frame) cancelAnimationFrame(g.frame);
    g.frame = 0;
    g.overlay?.host.remove();
    g.overlay = null;
  }
})();
