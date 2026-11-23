// Mouse Gestures: content script.
// Recognizes gestures drawn while the right mouse button is held and performs actions.
// Does not read page content, stores nothing and sends nothing over the network.
//
// A gesture can cross frame borders: for the right button the browser delivers mouse
// events to whichever frame is under the cursor. So the top frame owns the gesture:
// it recognizes it and draws the trail over the whole tab. Embedded frames (iframes)
// pass their mouse input to it through the extension's background script, which web
// pages can neither reach nor forge.
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
  const SCROLL_EDGES = { scrollTop: 'top', scrollBottom: 'bottom' };

  // Message types shared with background.js.
  const MSG = {
    action: 'mouse-gestures:action', // top frame → background: perform an action
    relay: 'mouse-gestures:relay', // embedded frame → background: mouse input for the top frame
    input: 'mouse-gestures:input', // background → top frame: relayed mouse input
    scroll: 'mouse-gestures:scroll', // background → embedded frame: scroll
  };
  // window.postMessage type an embedded frame uses to find out where it is in the tab.
  const WHERE = 'mouse-gestures:where';

  const INPUT_KINDS = new Set(['down', 'move', 'up', 'lost', 'cancel']);
  const IS_TOP = window === window.top;
  const TOP = { id: 'top', frameId: 0, key: null };
  // Random id of this document: links its position on the screen to its relayed input.
  const FRAME_KEY = randomKey();

  // What this frame itself saw of the current right-button drag, or null.
  let local = null;
  // The element where the drag started in this frame: a scroll gesture scrolls it.
  let scrollTarget = null;
  // Counts how many times the cursor entered this frame: input of one visit is
  // one piece of the gesture, even if it reaches the top frame late.
  let visit = 0;
  // Top frame only: the gesture across all frames, when the last one ended,
  // and where embedded frames are, keyed by their FRAME_KEY.
  let gesture = null;
  let lastEnd = 0;
  const frameOffsets = new Map();
  // No context menu after a gesture: it arrives right after mouseup.
  let suppressMenu = false;
  let suppressTimer = 0;

  const listeners = [
    ['mousedown', onMouseDown],
    ['mousemove', onMouseMove],
    ['mouseup', onMouseUp],
    ['contextmenu', onContextMenu],
    ['mouseover', onMouseOver],
    ['keydown', onKeyDown],
    ['message', onWindowMessage],
  ];
  // Capture phase on window: we run before the page's own handlers.
  for (const [type, fn] of listeners) window.addEventListener(type, fn, true);
  chrome.runtime.onMessage.addListener(onExtensionMessage);

  // After the extension is updated or removed, the script in already open pages
  // loses its connection to the extension. It then removes its handlers.
  function extensionAlive() {
    return Boolean(globalThis.chrome?.runtime?.id);
  }

  function teardown() {
    for (const [type, fn] of listeners) window.removeEventListener(type, fn, true);
    try {
      chrome.runtime.onMessage.removeListener(onExtensionMessage);
    } catch {
      // The extension context is already gone.
    }
    abort();
  }

  // --- Mouse and keyboard events (every frame) --------------------------------

  function onMouseDown(e) {
    // Ignore synthetic events created by page scripts: otherwise a page
    // could, for example, close the tab with a fake "gesture".
    if (!e.isTrusted) return;
    if (!extensionAlive()) {
      teardown();
      return;
    }
    if (e.button !== 2) {
      // Pressing another button during a gesture cancels it.
      if (local || gesture) {
        if (local) local.cancelled = true;
        emit('cancel');
      }
      return;
    }
    local = { x: e.clientX, y: e.clientY, moved: false, cancelled: false };
    scrollTarget = e.composedPath()[0];
    announceFrame();
    emit('down', e.clientX, e.clientY);
  }

  function onMouseMove(e) {
    if (!e.isTrusted) return;
    if (!(e.buttons & 2)) {
      // The button was released where this frame could not see it.
      if (local || gesture) {
        local = null;
        emit('lost');
      }
      return;
    }
    if (!local) {
      // A drag that started outside this frame: it is a gesture, not a click.
      local = { x: e.clientX, y: e.clientY, moved: true, cancelled: false };
      scrollTarget = e.composedPath()[0];
      announceFrame();
    } else if (!local.moved && Math.max(Math.abs(e.clientX - local.x), Math.abs(e.clientY - local.y)) >= STEP) {
      local.moved = true;
    }
    emit('move', e.clientX, e.clientY);
  }

  function onMouseUp(e) {
    if (!e.isTrusted || e.button !== 2) return;
    const moved = local?.moved ?? false;
    local = null;
    const g = emit('up', e.clientX, e.clientY);
    // The mouse barely moved: this is a normal click, let the menu open.
    if (moved || g?.dirs) blockNextContextMenu();
  }

  function onContextMenu(e) {
    if (suppressMenu) {
      suppressMenu = false;
      clearTimeout(suppressTimer);
    } else if (gesture?.dirs) {
      // Top frame: the gesture is still finishing in an embedded frame,
      // whose mouseup reaches us later than this event.
      gesture.menuHandled = true;
    } else {
      return;
    }
    e.preventDefault();
    e.stopImmediatePropagation();
  }

  function onMouseOver(e) {
    // No related target: the cursor came from outside this document.
    if (e.isTrusted && !e.relatedTarget) visit++;
  }

  function onKeyDown(e) {
    // Esc during a gesture cancels it.
    if (!e.isTrusted || e.key !== 'Escape') return;
    const drawing =
      (local?.moved && !local.cancelled) || (gesture?.dirs && !gesture.cancelled && !gesture.ended);
    if (!drawing) return;
    if (local) local.cancelled = true;
    emit('cancel');
    e.preventDefault();
    e.stopImmediatePropagation();
  }

  function blockNextContextMenu() {
    suppressMenu = true;
    clearTimeout(suppressTimer);
    suppressTimer = setTimeout(() => {
      suppressMenu = false;
    }, 500);
  }

  // Feeds mouse input into the gesture: directly in the top frame,
  // through the background script in embedded frames.
  function emit(kind, x = 0, y = 0) {
    if (IS_TOP) return handleInput(kind, x, y, TOP, 'top');
    sendToBackground({ type: MSG.relay, kind, x, y, key: FRAME_KEY, visit });
    return null;
  }

  function onExtensionMessage(msg, sender) {
    if (sender.id !== chrome.runtime.id) return;
    if (msg?.type === MSG.input && IS_TOP) {
      const { kind, x, y, key, frameId, visit: v } = msg;
      if (!INPUT_KINDS.has(kind) || !Number.isFinite(x) || !Number.isFinite(y)) return;
      if (typeof key !== 'string' || !Number.isInteger(frameId) || !Number.isInteger(v)) return;
      const src = { id: `frame-${frameId}`, frameId, key };
      const g = handleInput(kind, x, y, src, `${src.id}:${v}`);
      // The context menu may also pop up in this frame (see onContextMenu).
      if (g?.dirs && !g.menuHandled) blockNextContextMenu();
    } else if (msg?.type === MSG.scroll) {
      scrollToEdge(scrollTarget, msg.edge === 'top' ? 'top' : 'bottom');
    }
  }

  function sendToBackground(message) {
    if (!extensionAlive()) {
      teardown();
      return;
    }
    try {
      chrome.runtime.sendMessage(message).catch(() => {});
    } catch {
      teardown();
    }
  }

  // --- The gesture (top frame) ------------------------------------------------

  // Input of embedded frames comes through the background script and can arrive
  // later than the top frame's own input that happened after it. So the gesture is
  // kept as an ordered list of points, where each visit of the cursor to a frame is
  // one piece (seg): a late point goes to the end of its own piece, not of the list.
  //
  // src tells which frame the input came from: TOP or an embedded frame.
  // Returns the gesture for 'up', otherwise null.
  function handleInput(kind, x, y, src, seg) {
    const g = gesture;
    switch (kind) {
      case 'down':
        if (g && !g.pressed) {
          // The press of a drag we already follow: its message came late.
          g.pressed = true;
          g.start = src;
          addPoint(g, x, y, src, seg, 0);
          if (g.ended) settle(g, 50);
          break;
        }
        // A new press: the previous gesture is over.
        if (g?.ended) finalize(g);
        else abort();
        gesture = newGesture(src);
        addPoint(gesture, x, y, src, seg);
        break;
      case 'move':
        if (!g) {
          // Right after a gesture ends, this is its late input: skip it.
          if (performance.now() - lastEnd < 300) break;
          // A drag whose press we did not see (yet).
          gesture = newGesture(null);
        }
        addPoint(gesture, x, y, src, seg);
        break;
      case 'up':
        if (!g) return null;
        g.ended = true;
        removeOverlay(g);
        settle(g, settleTime(g, src));
        return g;
      case 'lost':
        expectUp();
        break;
      case 'cancel':
        if (g && !g.ended) cancel(g);
        break;
    }
    return null;
  }

  function newGesture(start) {
    return {
      dirs: '',
      points: [],
      start, // where the button was pressed, if known
      pressed: Boolean(start),
      ended: false,
      cancelled: false,
      menuHandled: false,
      settleTimer: 0,
      upTimer: 0,
      overlay: null,
      frame: 0,
    };
  }

  function addPoint(g, x, y, src, seg, index) {
    const p = { x, y, key: src.key, seg, src };
    const pts = g.points;
    let i = index ?? pts.length;
    if (index === undefined && src !== TOP) {
      const last = pts.findLastIndex((q) => q.seg === seg);
      if (last >= 0) i = last + 1;
    }
    pts.splice(i, 0, p);
    g.dirs = recognize(pts);
    if (g.dirs && !g.cancelled && !g.ended) scheduleDraw(g);
  }

  function recognize(points) {
    let dirs = '';
    let anchor = null;
    for (const p of points) {
      if (anchor?.seg !== p.seg) {
        // Coordinates of different frames are not comparable: start a new segment.
        anchor = { x: p.x, y: p.y, seg: p.seg };
        continue;
      }
      const dx = p.x - anchor.x;
      const dy = p.y - anchor.y;
      if (Math.abs(dx) >= STEP || Math.abs(dy) >= STEP) {
        const dir = Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? 'R' : 'L') : dy > 0 ? 'D' : 'U';
        if (!dirs.endsWith(dir)) dirs += dir;
        anchor.x = p.x;
        anchor.y = p.y;
      }
    }
    return dirs;
  }

  // How long to wait after the button is released before acting, in milliseconds.
  // A gesture that stayed in one frame is complete. Otherwise late input of other
  // frames may still be on its way; if even the press has not arrived, wait longer.
  function settleTime(g, upSrc) {
    if (g.start?.id === upSrc.id && g.points.every((p) => p.src.id === upSrc.id)) return 0;
    return g.pressed ? 50 : 300;
  }

  function settle(g, ms) {
    clearTimeout(g.settleTimer);
    if (ms) g.settleTimer = setTimeout(() => finalize(g), ms);
    else finalize(g);
  }

  function finalize(g) {
    if (gesture !== g) return;
    gesture = null;
    lastEnd = performance.now();
    clearTimeout(g.settleTimer);
    clearTimeout(g.upTimer);
    removeOverlay(g);
    if (g.dirs && !g.cancelled) perform(g);
  }

  // The button is up, but its mouseup has not arrived: it may still be on its way
  // from an embedded frame. If it never comes, drop the gesture.
  function expectUp() {
    const g = gesture;
    if (!g || g.ended || g.upTimer) return;
    g.upTimer = setTimeout(() => {
      if (gesture === g && !g.ended) abort();
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
    if (gesture) {
      clearTimeout(gesture.settleTimer);
      clearTimeout(gesture.upTimer);
      removeOverlay(gesture);
    }
    gesture = null;
  }

  // --- Actions ----------------------------------------------------------------

  function perform(g) {
    const def = GESTURES[g.dirs];
    if (!def) return;
    const edge = SCROLL_EDGES[def.action];
    // Where the button was pressed, or else where we first saw the drag.
    const start = g.start ?? g.points[0].src;
    if (!edge) {
      sendToBackground({ type: MSG.action, action: def.action });
    } else if (start === TOP) {
      scrollToEdge(scrollTarget, edge);
    } else {
      // The gesture started in an embedded frame: scroll there.
      sendToBackground({ type: MSG.action, action: def.action, frameId: start.frameId });
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

  // --- Where embedded frames are ----------------------------------------------
  // An embedded frame does not know its position in the tab, so it asks its parent.
  // Each parent adds the position of the child's <iframe> and passes the message up
  // until it reaches the top frame. This only affects where the trail is drawn,
  // so a message forged by a page script can do no harm.

  function announceFrame() {
    if (!IS_TOP) postToParent(FRAME_KEY, 0, 0);
  }

  function postToParent(key, x, y) {
    try {
      window.parent.postMessage({ type: WHERE, key, x, y }, '*');
    } catch {
      // The parent is gone.
    }
  }

  function onWindowMessage(e) {
    const d = e.data;
    if (d?.type !== WHERE || typeof d.key !== 'string' || !Number.isFinite(d.x) || !Number.isFinite(d.y)) return;
    // Page scripts do not need to see our messages.
    e.stopImmediatePropagation();
    const frame = findFrameElement(e.source);
    if (!frame) return;
    const rect = frame.getBoundingClientRect();
    const style = getComputedStyle(frame);
    const x = d.x + rect.left + frame.clientLeft + parseFloat(style.paddingLeft);
    const y = d.y + rect.top + frame.clientTop + parseFloat(style.paddingTop);
    if (!IS_TOP) {
      postToParent(d.key, x, y);
      return;
    }
    if (frameOffsets.size > 100) frameOffsets.clear();
    frameOffsets.set(d.key, { x, y });
    if (gesture?.dirs && !gesture.cancelled && !gesture.ended) scheduleDraw(gesture);
  }

  function findFrameElement(source) {
    if (!source) return null;
    for (const f of document.querySelectorAll('iframe, frame')) {
      if (f.contentWindow === source) return f;
    }
    return findFrameInShadowRoots(document, source);
  }

  // Frames can also live inside Shadow DOM, including closed shadow roots.
  function findFrameInShadowRoots(root, source) {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
    for (let el = walker.nextNode(); el; el = walker.nextNode()) {
      const shadow = chrome.dom?.openOrClosedShadowRoot?.(el) ?? el.shadowRoot;
      if (!shadow) continue;
      for (const f of shadow.querySelectorAll('iframe, frame')) {
        if (f.contentWindow === source) return f;
      }
      const nested = findFrameInShadowRoots(shadow, source);
      if (nested) return nested;
    }
    return null;
  }

  function randomKey() {
    const bytes = crypto.getRandomValues(new Uint8Array(16));
    return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  }

  // --- On-screen hint: mouse trail and gesture name (top frame) ----------------

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
      if (gesture === g && !g.cancelled && !g.ended) draw(g);
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
    let started = false;
    for (const p of g.points) {
      // Points of embedded frames are shifted by the frame's position;
      // until it is known, they are not drawn.
      const offset = p.key ? frameOffsets.get(p.key) : { x: 0, y: 0 };
      if (!offset) continue;
      const x = p.x + offset.x;
      const y = p.y + offset.y;
      if (started) {
        ctx.lineTo(x, y);
      } else {
        ctx.moveTo(x, y);
        started = true;
      }
    }
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
    // The browser's top layer puts the hint above everything, including modal
    // dialogs and fullscreen video. Without it, the fixed position still works.
    try {
      host.popover = 'manual';
      host.showPopover();
    } catch {
      // Not supported or not allowed here.
    }
    return { host, canvas, ctx: canvas.getContext('2d'), arrows, name };
  }

  function removeOverlay(g) {
    if (g.frame) cancelAnimationFrame(g.frame);
    g.frame = 0;
    g.overlay?.host.remove();
    g.overlay = null;
  }
})();
