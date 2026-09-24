# Cloudflare Worker — `white-thunder-5727.mdmcqueen.workers.dev`

The source of truth for this Worker is **Cloudflare**, not this repo — this
directory is a *backup copy*, kept in sync by hand. Until 2026-09-24 the code
existed nowhere but inside the Cloudflare dashboard, which meant losing that
account would have taken every Todoist feature in the app with it and left
nothing to rebuild from.

**If you edit the Worker in the Cloudflare dashboard, paste the new source
here and commit it.** Otherwise this copy silently rots and the backup is
worthless exactly when it is needed.

## What it does

1. **Todoist proxy.** iOS blocks the app's direct calls to `api.todoist.com`
   (no CORS), so every Todoist request goes through here and is forwarded to
   `https://api.todoist.com/api/v1` with the caller's `Authorization` header
   passed straight through. The Worker holds no credentials of its own — the
   Todoist token lives on each phone and rides in on the request.
2. Locked to `https://mdmcqueen.github.io`: any request whose `Origin` header
   is anything else gets a 403. Note this also means **opening a Worker URL
   directly in a browser tab returns 403**, because a top-level navigation
   sends no `Origin` header at all. Test with `fetch()` from the app's page,
   not by visiting the URL.

## Deploying a change

dash.cloudflare.com → Compute (Workers & Pages) → `white-thunder-5727` →
Edit code → replace → Deploy. Cloudflare keeps version history, so a bad
deploy can be rolled back from the dashboard without touching this repo.
