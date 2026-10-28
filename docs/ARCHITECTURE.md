# Architecture

2026-10-28

Each agent runs a small MCP stdio adapter. Adapters connect to one on-demand controller through a local named pipe on Windows or Unix socket elsewhere. A random credential authenticates every connection. Runtime state lives outside the checkout, under the user's application-data directory.

The controller owns a persistent Playwright connection to the existing Chromium browser through CDP. It resolves tabs by stable target IDs, serializes actions within a tab, and allows independent tabs to run concurrently. A tab has one agent owner until explicitly released or its agent disconnects. Browser-wide operations use a separate queue.

Page actions, compact snapshots with document-bound element references, screenshots, page JavaScript, raw page/browser CDP, and action batches share this connection. Navigation invalidates old references. Arbitrary script and protocol commands are privileged escape hatches, not a sandbox.

A page helper draws the agent cursor in an inaccessible-to-input overlay and temporarily changes document icon links. It preserves original attributes and restores only its own changes. Navigation reinstalls the helper. Visuals add no fixed delay to input. Screenshots suppress the overlay unless explicitly requested.

The optional MV3 extension uses Native Messaging to reach the controller. It exposes browser APIs and a local status/stop popup. It does not attach a competing debugger while the controller uses direct CDP. A persistent Windows UI Automation helper provides native UI inspection and input for browser menus and system dialogs.

The first MCP adapter or extension connection starts the controller. It stays warm while clients are connected, then exits after the configured idle interval. Closing a controller connection never closes the attached browser.

## Sources

- [Playwright CDP attachment](https://playwright.dev/docs/api/class-browsertype#browser-type-connect-over-cdp)
- [Playwright browser connection modes](https://playwright.dev/mcp/configuration/browser-extension)
- [Native Messaging](https://developer.chrome.com/docs/extensions/develop/concepts/native-messaging)
- [Chrome tab APIs](https://developer.chrome.com/docs/extensions/reference/api/tabs)
- [Windows UI Automation](https://learn.microsoft.com/en-us/windows/win32/winauto/entry-uiauto-win32)

Favicon changes are document modifications and remain subject to browser and site behavior. Native OS input uses the foreground desktop. Tab ownership coordinates cooperating clients but does not isolate shared cookies or storage. Protected browser pages and OS security boundaries remain outside normal page automation.
