# Basketly — deploy guide

A frameworkless PWA (Preact + htm from CDN, no build step) on GitHub Pages, talking to
Firebase for shared real-time data and a Cloudflare Worker for Claude-powered item routing.
Same shape as your finance tracker.

## Files
- `index.html`, `app.js`, `styles.css` — the app
- `manifest.webmanifest`, `sw.js`, `icon-*.png` — PWA install + offline shell
- `worker.js` — Cloudflare Worker (parse proxy, holds the Claude key)
- `firestore.rules` — access control (two-email allowlist)

## The three config blocks you MUST fill (all in `app.js`, top of file)
1. `firebaseConfig` — from Firebase console → Project settings → Your apps (Web app)
2. `ALLOWED` — the two Google accounts. **Must match `firestore.rules` exactly** (lowercase)
3. `WORKER_URL` — your deployed Worker URL (step 3 below)

## 1. Firebase
1. Create a project (or reuse the finance-tracker one — different collections, no conflict).
2. Enable **Authentication → Google** sign-in.
3. Create **Firestore** (production mode).
4. Paste `firestore.rules` into Firestore → Rules, edit the two emails, Publish.
5. Copy the web config into `firebaseConfig` in `app.js`.
6. Firestore → collections used: `shoppinglist_config`, `shoppinglist_dictionary`, `shoppinglist_list` (auto-seeded on first sign-in).

## 2. Cloudflare Worker (the parser)
```bash
npm i -g wrangler
wrangler init cartpath-parse    # or drop worker.js into an existing project
# replace the generated src with worker.js
wrangler secret put ANTHROPIC_API_KEY   # paste your Anthropic key
wrangler deploy
```
Copy the deployed URL into `WORKER_URL` in `app.js`.
In `worker.js`, set `ALLOW_ORIGIN` to your Pages origin (e.g. `https://you.github.io`) once it works.

## 3. GitHub Pages
1. Push this folder to a repo.
2. Settings → Pages → deploy from branch (root).
3. Open the Pages URL on your phone → Share → **Add to Home Screen** (both phones).

## Offline / iOS note
Firestore's `persistentLocalCache` (already wired) handles offline reads/writes and syncs
on reconnect — this is what makes in-store dead zones safe. On iPhone, open the installed
(home-screen) app, not a Safari tab, so storage isn't evicted.

## Data model
- `shoppinglist_config/app` → `{ stores:[{id,name,color}], categories:[...] }` (edit stores here, no redeploy)
- `shoppinglist_dictionary/{slug}` → `{ name, stores:[ids], category }` (the learned item→store map)
- `shoppinglist_list/{autoId}` → `{ key, name, stores:[ids], category, checked, addedBy, ts }`

One list row carries all its stores, so "Mark bought" deletes the row and it clears from every
store at once — that's the buy-anywhere/clear-everywhere behavior.

## What's intentionally not built yet
Per-store submit timing, receipt/history log, push notifications, editable store UI (edit the
`shoppinglist_config/app` doc directly for now). Add after real use tells you they're worth it.
