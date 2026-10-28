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

- The cursor follows agent actions only. Use a white arrow with a black outline and a translucent cursor favicon only while the tab is owned.
