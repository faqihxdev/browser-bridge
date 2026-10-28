# Verification

2026-10-28

Local checks on Windows with Node.js 24 and Edge 155:

- Type checking and production build pass.
- Unit checks cover ordered queues after failure, fragmented native messages, UTF-8 framing, message-size limits and legacy/modern CDP discovery formats.
- Isolated headless Edge integration covers real input and batches, multi-frame snapshots, masked password values, exclusive tab ownership, release and transfer, exact original favicon restoration, queued-action cancellation after human release, stale references after navigation, real PNG capture, page/browser CDP and disconnect without closing the browser.
- The native Windows helper lists actual desktop windows successfully.

Live-profile attachment, extension installation and full MCP transport verification are tracked in the following checkpoint. No visited page content or credentials belong in this repository.
