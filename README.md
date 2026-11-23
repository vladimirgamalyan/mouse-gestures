# Mouse Gestures

A Chrome extension for controlling the browser with mouse gestures.

## Why

I used to rely on the CRX Mouse extension for gestures, but I suspect it ships with
a spyware module. So this is my own extension: small, transparent and safe.

## How gestures work

- Hold the **right mouse button**, move the mouse in the desired direction, release.
  The behavior is close to CRX Mouse.
- While you draw, the page shows the mouse trail and a hint with arrows and the action name.
- If the mouse barely moved (less than 20 pixels), it is a normal click and the context
  menu opens.
- No context menu appears after a gesture, even if the gesture was not recognized.
- **Esc** or pressing another mouse button during a gesture cancels it.
- Gestures work across embedded frames (iframes): you can start over an embedded video
  or an ad and finish outside it, or the other way round. The trail is drawn over the
  whole tab, above modal dialogs and fullscreen video too.

## Gestures

| Gesture | Action                                        |
|---------|-----------------------------------------------|
| ←       | Back                                          |
| →       | Forward                                       |
| ← →     | New tab (at the end of the window, like Ctrl+T) |
| ↓ →     | Close tab                                     |
| ↑       | Scroll to top                                 |
| ↓       | Scroll to bottom                              |

Scrolling works like the mouse wheel: it scrolls the nearest block under the cursor that
can still move in that direction, or the whole page if there is none.

## Installation

1. Open `chrome://extensions`.
2. Turn on "Developer mode" (the toggle in the top right corner).
3. Click "Load unpacked" and select the `extension` folder of this project.
4. Reload the tabs that are already open: the extension starts working in them only after a reload.

After changing the code, click the reload button of the extension on `chrome://extensions`
and reload the tabs again.

## Security principles

- No network requests: the extension sends nothing anywhere. The CSP in `manifest.json`
  forbids the extension from loading anything (`default-src 'none'`).
- No analytics, telemetry or collection of visited pages. The extension stores nothing.
- No `permissions` in the manifest. The only access is the gesture script on all pages.
  Because of it, Chrome warns at install time that the extension can "read and change all
  your data on all websites": gestures cannot work on pages without that. The script only
  listens to the mouse and does not read page content.
- Synthetic events from page scripts are ignored: a site cannot "make a gesture" on your
  behalf, for example to close the tab.
- No third-party libraries and no code loaded from outside: all of the extension's code is
  in the `extension` folder (under 700 lines) and can be read in full.
- Embedded frames pass mouse input to the top frame only through the extension's
  background script, which web pages can neither reach nor forge. A frame uses
  `window.postMessage` only to find out where it is on the screen: a forged message
  can at most draw the trail in the wrong place.
- Manifest V3.

## Limitations

- Chrome does not let extensions run on its own pages: `chrome://…`, the new tab page,
  the Chrome Web Store, the built-in PDF viewer. Gestures do not work there.
- On local files (`file://…`) gestures work only after enabling "Allow access to file URLs"
  in the extension's settings.
- Designed for Windows: there the context menu opens when the button is released, so it can
  be cancelled after a gesture. On macOS and Linux the menu opens when the button is pressed,
  so gestures are not supported there yet.
- The part of a gesture drawn over a frame where Chrome does not let extensions run
  (for example, an embedded PDF) is not seen.

## Structure

```
extension/
  manifest.json      — extension manifest
  src/content.js     — gesture recognition across frames, on-screen hint, scrolling
  src/background.js  — tab actions (back, forward, new, close), input relay from iframes
tests/
  e2e.test.mjs       — end-to-end tests in a real Chromium
```

Gestures are defined in the `GESTURES` table in `extension/src/content.js`: a string of
directions (`L`, `R`, `U`, `D`) and an action.

## Tests

The tests launch Chromium with the extension loaded and perform gestures with the mouse
through Playwright. Playwright is needed only for the tests and is not part of the extension.

```
npm install
npx playwright install chromium
npm test
```

`HEADED=1 npm test` shows the browser window while the tests run.

## License

[MIT](LICENSE)
