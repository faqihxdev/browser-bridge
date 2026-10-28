# Browser Bridge

Let local MCP agents control your existing browser, with visible activity and shared tab ownership.

[Checks](https://github.com/faqihxdev/browser-bridge/actions/workflows/checks.yml)

## Architecture

Node.js 24, TypeScript and Playwright attach to your signed-in Chromium browser through CDP. A shared controller serves agents over an authenticated local named pipe. The MV3 extension supplies browser APIs and a status/stop popup through Native Messaging. A persistent Windows UI Automation helper handles native controls.

![Browser Bridge architecture](docs/images/architecture.svg)

## Engineering highlights

| Capability       | Implementation                                                                                                                                                           |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Shared control   | One on-demand controller, persistent browser connection, explicit tab IDs and independent queues per tab.                                                                |
| Fast actions     | Ordered batches reduce agent round trips. Targeted snapshots and bounded request history keep responses small. Indicators add no fixed input delay.                      |
| Tab ownership    | One agent per tab. Release and disconnect restore indicators. Human stop invalidates queued work and active batches.                                                     |
| Visible activity | Non-intercepting cursor overlay, click feedback and temporary favicons. Original icon attributes survive release and navigation. Screenshots hide the cursor by default. |
| Broad access     | Page actions, JavaScript, raw page/browser CDP, cookies, network details, screenshots, PDFs, uploads and extension browser APIs.                                         |
| Native Windows   | UI inspection, invocation, values, menus, keyboard/mouse input and window screenshots through a persistent helper.                                                       |
| Verification     | Real-browser tests cover input, ownership, cancellation, navigation, favicon restoration, multiple MCP clients and the actual extension/native-host connection.          |

## Setup

Use Node.js 24 and pnpm 11.1.1.

```powershell
pnpm install --frozen-lockfile
pnpm build
pnpm setup:local --codex
```

Enable remote debugging at `edge://inspect/#remote-debugging`. In `edge://extensions`, enable Developer mode and load the unpacked `dist/extension` folder. Setup registers its Native Messaging host for Edge, Chrome and Chromium.

`--codex` adds the MCP server to your user Codex configuration. Restart the agent connection to load it. For other MCP clients, copy the generated `mcpServers` entry from `%LOCALAPPDATA%\BrowserBridge\mcp.json`.

The controller starts with the first agent or extension connection and exits ten minutes after the last client disconnects. `pnpm status` reports its state; `pnpm doctor` checks browser attachment; `pnpm stop` disconnects it and restores indicators.

Settings and credentials live in `%LOCALAPPDATA%\BrowserBridge`. Each controller attaches to one configured browser. Set `browser` in `config.json` to `msedge`, `chrome`, `chromium` or a CDP URL. `BROWSER_BRIDGE_HOME` selects a separate runtime directory.

## Development

```powershell
pnpm check
pnpm test
pnpm test:integration
pnpm test:extension
```

The extension test needs setup registration and Playwright Chromium, installed with `pnpm exec playwright-core install chromium`. Tests use isolated browser profiles. CI runs types, build and browser tests on Windows and Linux.

Use Conventional Commits and `<name>/<type>-<description>` branches. Keep credentials, screenshots and browser content out of Git.

## Scope

Control runs locally; requested browser results still reach your chosen agent. Ownership coordinates clients but does not isolate shared cookies or storage. Raw CDP and extension APIs are privileged escape hatches.

Favicons remain subject to site and browser behavior. Native OS input uses the foreground desktop. Protected browser pages and OS security boundaries still apply.
