# Browser Bridge

Control your existing browser from any MCP agent. One local controller shares a browser connection, coordinates tab ownership, and shows agent activity with a cursor and temporary favicon.

Node.js 24, TypeScript and Playwright. Browser control runs locally on the signed-in user's computer. Agents receive the results they request through their normal model connection.

## Development

```powershell
pnpm install --frozen-lockfile
pnpm build
pnpm test
```

See [architecture](docs/ARCHITECTURE.md), [setup](docs/SETUP.md) and [verification](docs/VERIFICATION.md).

## Contributing

- Branch: `<name>/<type>-<short-description>`.
- Commit and PR subject: `<type>: <short description>`.
- Types: `feat`, `fix`, `refactor`, `docs`, `test`, `chore`.

Use `git config commit.template .gitmessage` for the local commit prompt. Keep checkpoints focused on working behavior and its verification.
