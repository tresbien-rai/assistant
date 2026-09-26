# Tessera

A personal, server-backed AI chat app. Sign in with Google, bring your own
Anthropic or Gemini API key, and talk through customisable personas that have
avatars and expressions. Conversations can live in workspaces and projects with
knowledge files on your Google Drive. The model can create and edit files, and a
shared scratchpad holds work in progress.

## Run it locally

```bash
cd server
cp .env.example .env    # fill in the values; see the comments in the file
npm install
npm run dev             # http://localhost:3000
```

To test the UI without Google sign-in, set `ALLOW_DEV_LOGIN=true` in
`server/.env` and use the "Dev login (local)" button.

## Documentation

- **[docs/PROJECT.md](docs/PROJECT.md)** — the master document: architecture,
  design principles, feature status, what's owed, gotchas. Start here.
- [CLAUDE.md](CLAUDE.md) — how work on this repo is done (workflow, conventions, file map).
- [docs/DEPLOY_RAILWAY.md](docs/DEPLOY_RAILWAY.md) — deploying to Railway.
- `docs/design/` — one decision record per feature.

## License

MIT
