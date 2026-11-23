// Mouse Gestures: background service worker.
// Performs tab actions that the content script cannot do on its own, and passes
// mouse input from embedded frames to the top frame, which owns the gesture.
// No network requests and no data storage here.
'use strict';

// Message types shared with content.js.
const MSG = {
  action: 'mouse-gestures:action',
  relay: 'mouse-gestures:relay',
  input: 'mouse-gestures:input',
  scroll: 'mouse-gestures:scroll',
};

const TAB_ACTIONS = {
  back: (tab) => chrome.tabs.goBack(tab.id),
  forward: (tab) => chrome.tabs.goForward(tab.id),
  // Like Ctrl+T: a new tab at the end of the window where the gesture was made.
  newTab: (tab) => chrome.tabs.create({ windowId: tab.windowId }),
  closeTab: (tab) => chrome.tabs.remove(tab.id),
};

const SCROLL_EDGES = { scrollTop: 'top', scrollBottom: 'bottom' };

chrome.runtime.onMessage.addListener((message, sender) => {
  // Only the extension's own contexts can send to onMessage: web pages cannot.
  // The checks below are an extra safeguard.
  if (sender.id !== chrome.runtime.id || !sender.tab) return;
  const tab = sender.tab;

  if (message?.type === MSG.relay && sender.frameId !== 0) {
    // Mouse input from an embedded frame goes to the top frame of the same tab.
    const { kind, x, y, key, visit } = message;
    sendToFrame(tab.id, 0, { type: MSG.input, frameId: sender.frameId, kind, x, y, key, visit });
    return;
  }

  // Only the top frame decides which action a gesture means.
  if (message?.type !== MSG.action || sender.frameId !== 0) return;
  if (Object.hasOwn(TAB_ACTIONS, message.action)) {
    TAB_ACTIONS[message.action](tab).catch(() => {
      // For example, "back" on the first page of a tab: there is no history, do nothing.
    });
  } else if (Object.hasOwn(SCROLL_EDGES, message.action) && Number.isInteger(message.frameId)) {
    // A scroll gesture that started in an embedded frame scrolls that frame.
    sendToFrame(tab.id, message.frameId, { type: MSG.scroll, edge: SCROLL_EDGES[message.action] });
  }
});

function sendToFrame(tabId, frameId, message) {
  chrome.tabs.sendMessage(tabId, message, { frameId }).catch(() => {
    // The frame has no content script (for example, a browser page) or is gone.
  });
}
