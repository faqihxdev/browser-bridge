# Browser Bridge

2026-10-28

- Use Node.js 24, TypeScript and pnpm. Commit dependency changes with the lockfile.
- Use Conventional Commits. Branch names use `<name>/<type>-<description>`.
- Keep protocol output on stdout and diagnostics on stderr.
- Keep runtime credentials, browser content, screenshots and local configuration out of Git.
- Browser actions use explicit tab IDs. Preserve the user's foreground tab unless focus is requested.
- Test ownership, disconnect cleanup, navigation, indicator restoration and actual browser behavior when changing their implementations.
- Run relevant checks at each checkpoint. Keep human setup and practical limits in the README.
- Keep UI compact and near-black. Use grayscale except for warnings and errors. Show only useful text.

2026-10-29

- Keep the rounded, stemless cursor visible throughout ownership, following agent actions only. Use a white fill and black outline. Overlay it at full opacity on the faded site favicon; release restores the site icon.

2026-11-03

- Watched cursor travel varies between nearly straight, C and S paths with distance-scaled timing, and long reaches sometimes overshoot. The tip leads, turning around the click point in proportion to speed. At rest the cursor drifts a few pixels so users can spot it. Reduced motion disables both.

2026-11-04

- Keep the cursor in the top layer above modal dialogs, popovers and fullscreen content. Keep cursor animations compositor-friendly, with replace compositing on transforms.
