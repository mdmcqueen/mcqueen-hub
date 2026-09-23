# Reverting the McQueen Hub

Every deployed version of this app is a commit on `main`, and GitHub Pages
serves whatever `main` points at. So reverting is always the same shape:
put `main` back on a known-good commit and push. Nothing else — no
Cloudflare change, no Google Cloud change, no phone setup — is involved in
a revert.

## The known-good Google-OAuth build

**Tag: `google-oauth-last` → commit `f053ff0` (v78)**

This is the last version that reads your calendar through the Google
Calendar API with full OAuth. It is the *capable* build: it can add
calendar events from the capture sheet and it backs your settings up to
Google Drive app-data. It is also the build that makes you clear Google's
security screens on most launches. That trade is the whole reason a
calendar change was considered.

If a later build ever loses calendar features you need, this tag is where
to come back to.

## How to revert

From any machine that has the deploy PAT (`secrets/github-pat.txt` in the
Household OS folder):

```sh
git clone https://github.com/mdmcqueen/mcqueen-hub
cd mcqueen-hub

# Option A — the safe one. Adds a NEW commit that undoes everything since
# the tag, so the history of what was tried stays intact.
git revert --no-commit google-oauth-last..HEAD
git commit -m "revert to v78 (Google OAuth build)"

# Option B — the blunt one. Rewrites main to be exactly the tag. Use only
# if you are certain nothing after the tag is worth keeping.
#   git reset --hard google-oauth-last

PAT=$(tr -d ' \t\n\r' < "<path to>/secrets/github-pat.txt")
git push "https://x-access-token:${PAT}@github.com/mdmcqueen/mcqueen-hub" HEAD:main
# (Option B needs --force-with-lease before HEAD:main)
```

**Prefer Option A.** It is reversible; Option B throws work away.

## After any revert — two things that are easy to forget

1. **Bump the cache markers, or phones keep the old build.** `sw.js`'s
   `CACHE` constant and the `<span class="build-ver">` in `index.html` must
   change to a value that has never been used before (go *forward*, e.g.
   `v79`, never back to `v78` — a reused cache name means the service
   worker sees no change and keeps serving the stale shell).

2. **Verify from the live origin, not from a shell.** Neither the cloud
   container nor the Mac's sandbox can reach `mdmcqueen.github.io`. Open
   `https://mdmcqueen.github.io/mcqueen-hub/sw.js?cb=<new-sha>` in a
   browser and confirm the `CACHE` string matches what you just pushed.
   GitHub Pages takes roughly a minute.

## Finding any other version

```sh
git log --oneline            # every version, newest first
git tag -l                   # the named ones
git show <sha> --stat        # what a given version changed
```

Each commit message explains the reasoning behind that version, and
`knowledge-base/mcqueen-hub-pwa-state.md` in the Household OS folder is the
long-form changelog with the diagnosis behind each one.
