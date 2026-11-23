// Mouse Gestures: background service worker.
// Performs tab actions that the content script cannot do on its own.
// No network requests and no data storage here.
'use strict';

const MESSAGE_TYPE = 'mouse-gestures:action';

const TAB_ACTIONS = {
  back: (tab) => chrome.tabs.goBack(tab.id),
  forward: (tab) => chrome.tabs.goForward(tab.id),
  // Like Ctrl+T: a new tab at the end of the window where the gesture was made.
  newTab: (tab) => chrome.tabs.create({ windowId: tab.windowId }),
  closeTab: (tab) => chrome.tabs.remove(tab.id),
};

chrome.runtime.onMessage.addListener((message, sender) => {
  // Only the extension's own contexts can send to onMessage: web pages cannot.
  // The checks below are an extra safeguard.
  if (sender.id !== chrome.runtime.id || !sender.tab) return;
  if (message?.type !== MESSAGE_TYPE || !Object.hasOwn(TAB_ACTIONS, message.action)) return;

  TAB_ACTIONS[message.action](sender.tab).catch(() => {
    // For example, "back" on the first page of a tab: there is no history, do nothing.
  });
});
