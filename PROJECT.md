# Basketly

Single-household shopping-list PWA. Built for two people (me + wife) who shop
together. Solves one specific problem: items get voice-captured in bulk and then
land on the wrong store's list.

> This file was re-verified line-by-line against the source on 2026-09-20.
> Everything below reflects the code as it actually is, including the parts that
> are broken. Defects are listed in **Known defects** rather than quietly fixed
> in prose — if you fix one, delete its row.

---

## Core model

- **Items map to stores 1-to-many.** Cilantro can come from HEB, Walmart, or the
  Indian store. A multi-store item appears on every eligible store's list.
- **One list row carries all its stores.** There is no row-per-store. That single
  row is what makes buy-anywhere/clear-everywhere fall out for free: deleting the
  row on checkout clears it from every store at once.
- **A learned dictionary does the routing.** `shoppinglist_dictionary` remembers
  item → stores + category. The dictionary — not the list row — is the source of
  truth for store mapping; `storesOf()` reads the dictionary and falls back to the
  row's own `stores` array only as a warm offline cache.
- **Checkout is the commit.** You check into one store, tick items, then check out
  — that archives the ticked items to `shoppinglist_purchased` and deletes their
  list rows. Unticked items stay on the list.
- **Ticking is a live Firestore write**, not local state. Tick an item on one phone
  and it ticks on the other. (Offline persistence queues the write; it is still a
  write.) What is *not* synced is which store you checked into.

## Stack

No build step, no bundler, no package.json. Everything is loaded as ES modules
from CDNs at runtime.

| Layer | Choice |
|---|---|
| UI | **Preact 10.19.3 + htm 3.1.1**, both from `esm.sh`. Hooks, tagged-template markup — no JSX, no compile step |
| Structure | One `App()` function component. ~90 `useState` hooks, no context, no reducer, no child components beyond 5 small helpers (`Spin`, `Panel`, `Loader`, `SlideConfirm`, `dishCard`) |
| Hosting | GitHub Pages |
| Data | Firebase 10.12.2 (gstatic ESM), Firestore with `persistentLocalCache` + `persistentMultipleTabManager` |
| Auth | Firebase Auth, Google popup, client-side check against `ALLOWED_EMAILS` plus server-side email allowlist in the rules |
| Files | Firebase Cloud Storage (return attachments) |
| AI | `claude-haiku-4-5-20251001`, behind a Cloudflare Worker that holds the API key |

**Shares a Firebase project with the finance tracker** (project `expenses-b87fc`).
Shared auth, separate collections via the `shoppinglist_` prefix. One consequence
that bites: **Firestore and Storage rules must be MERGED into the finance app's
live rules, never replaced.** Publishing this repo's rules wholesale will break
the other app.

The Cloudflare Worker is separate from the finance app's Worker. Same Anthropic
key, set per-worker.

---

## Files

Actual directory contents:

```
app.js                  the entire application (1291 lines)
styles.css              all styling (393 lines); palette in :root tokens
index.html              shell (20 lines) — loads fonts, styles.css, app.js
config.js               Firebase config + ALLOWED_EMAILS + WORKER_URL (committed)
config.example.js       template for the above
sw.js                   service worker — holds the CACHE version const
manifest.webmanifest    PWA manifest
worker.js               Cloudflare Worker (deployed separately, NOT by Pages)
firestore.rules         MERGE into the shared project's rules
storage.rules           MERGE into the shared project's rules
README.md               older deploy guide — see the warning below
PROJECT.md              this file
icon-192.png  icon-512.png  icon-maskable.png
apple-touch-icon.png  favicon.ico  favicon-32.png
```

There is no `icon.svg` and no `favicon-16.png` — earlier versions of this doc
claimed both. There is no icon source file in the repo.

> **`README.md` is stale.** It says the three config blocks live "in `app.js`,
> top of file" — they live in `config.js` and have since config was extracted.
> It also still calls the project Cartpath (`wrangler init cartpath-parse`), as
> does the comment at the top of `sw.js`. Trust this file over the README.

`app.js` holds everything — all three tabs, every sheet and modal, state, and all
Firestore wiring. There is no module structure, and function definitions are
interleaved with the `useState` declarations they close over (e.g. `getRecipes`
at line 178 reads state declared at line 283 — legal, because it only runs after
render, but it means there is no safe place to "add code at the top"). Treat it
as the single point of failure: one bad edit is a white screen with no bisect
surface.

### Config (`config.js`)

Three exports, all read by `app.js`:

- `shoppingListConfig` — Firebase web config. The `apiKey` is public by design;
  the actual security perimeter is `firestore.rules` + the email allowlist.
- `ALLOWED_EMAILS` — the two Google accounts, lowercase. **Must match the emails
  in `firestore.rules` and `storage.rules`.** A mismatch means sign-in succeeds
  and then every read fails with `permission-denied`.
- `WORKER_URL` — currently `https://shoppinglist.shubhamsaxena1492.workers.dev`.

### Firestore collections

| Collection | Doc id | Holds |
|---|---|---|
| `shoppinglist_config` | `app` | `stores[]`, `categories[]`, `kitchen[]` (staples the recipe generator assumes), `nameCaseV1` (migration flag) |
| `shoppinglist_dictionary` | `slug(name)` | `{ name, stores:[ids], category }` — the learned item→store map |
| `shoppinglist_list` | auto | `{ key, name, stores:[ids], category, tags:[], checked, addedBy, ts }` |
| `shoppinglist_purchased` | auto | `{ name, store, date, status, ts }` + on return: `returnByDate`, `attachUrl`, `attachType`, `attachPath`. `status`: purchased / returning / returned / kept |
| `shoppinglist_staples` | `slug(name)` | `{ name }` — the "Regularly Bought" curated set |
| `shoppinglist_recipes` | `slug(name)` | `{ name, minutes, need[], ingredientsUsed[], steps[], notes, oneExtra, ts }` — saved recipes |

All six are opened as live `onSnapshot` listeners on sign-in. **`shoppinglist_recipes`
is missing from `firestore.rules`** — see Known defects.

First sign-in on an empty project seeds `shoppinglist_config/app` with
`DEFAULT_STORES` (HEB / Walmart / Indian Store) and `CATS`, plus a 16-entry
`SEED_DICT`.

Return attachments: Cloud Storage under `basketly/returns/{purchaseId}/`,
max 15 MB, images and PDFs only.

### Worker routes (`worker.js`)

Both routes are POST-only, CORS `*`, and hit Claude Haiku with a
strict JSON-array contract, stripping markdown fences from the reply.

| Route | Does |
|---|---|
| *(anything not ending in `/recipes`)* | `{items, stores}` → `[{name, stores[], category}]`. Returned store ids are filtered against the ids you sent; unknown categories collapse to Unsorted |
| `/recipes` | `{ingredients, staples, mealType, cuisine, forWhom, ageBand, flavors[], allowOneExtra}` → up to 5 dishes with a have/need split, steps, notes, and an optional "one more item" suggestion. Baby mode injects explicit infant-feeding safety constraints into the system prompt |

The worker's category list is **hardcoded** to the eight defaults. Categories you
add in the app are invisible to it.

---

## What's built

**Tabs** — List / Shop / History, switchable by tap or by horizontal swipe
(>70px, <600ms, ignoring chip rows, sheets, and inputs).

- **List** — collapsible category panels, no checkboxes. Multi-select tag and
  store filters with search, all-on by default, implemented as "excluded" sets so
  new tags/stores are automatically on. Collapse/expand all. A "Reorder" toggle
  reveals grip handles; a 420ms long-press on a row also enters it. Drag an item
  onto a category to recategorize; drag category headers to reorder. Per-row:
  star (promote to Regularly Bought), tap-to-open the item editor, category chip
  for a quick category picker, `×` to delete.
- **Shop** — store picker (stores with items first, sorted by count) → check in
  to one store → checklist → check out. Checked items sink to the bottom of each
  category. Two ways to check out: the ghost button in the check-in header, and
  a **slide-to-confirm** bar pinned to the bottom (a tap does nothing; you must
  drag ~90% across). Can add new items from here; they map straight to the
  checked-in store.
- **Purchase History** — paginated 20/page, "Pending returns" toggle, filters for
  store, category, and time range (7/30/90d, 6mo, 1yr, all), sort by date or
  store, asc/desc. Star from here to add to Regularly Bought.

**Item editor** (tap a list row) — category (with inline "+ New category"), store
chips (with inline "+ New store"), free-text tags, save, remove.

**Returns** — mark a purchased item with a manual return-by date; a global banner
appears on all devices when any return is within 5 days (red/"overdue" once past).
Resolve as Returned or Keeping. Optional image/PDF attachment so you don't
app-hop at the UPS counter.

**Regularly Bought** — curated re-addable set, opened as a multi-select palette.
Items already on the list grey out. Promote via the star toggle on List or History.

**Tags ("for whom")** — free-text, multiple per item, **not** persisted to the
dictionary. Shown on List and Shop rows — you need to see the shirt size while
you're standing in the aisle.

**Recipe Ideas** — full-screen overlay behind the hamburger, two tabs:
- *Get ideas* — intake is tap-buttons (cuisine, meal type, who it's for, baby age
  band, flavors) plus an ingredients textbox with tap-to-append chips from the
  last 30 days of produce purchases. Baby results carry a safety caveat block.
- *Saved* — recipes starred from either tab, stored in `shoppinglist_recipes`.

Each dish card can **add its ingredients to the list**: it offers the `need` list
(or all ingredients used), strips quantities and measure words locally
("2 cloves garlic" → "Garlic"), filters out anything matching a Kitchen Staple
whole-word, and lets you tick and rename each line before adding.

**Kitchen Staples** — a `kitchen[]` array on the config doc. Things you always
have; the recipe prompt tells Claude to assume them and exclude them from `need`.

**Store & category management** — under the hamburger. Rename/recolor/delete
stores (deleting a store that would orphan items prompts you to reassign them),
add/delete categories, reorder categories by drag.

**Name-case migration** — one-shot, auto-runs silently when `config/app` lacks
`nameCaseV1`. Title-cases every list/dictionary/purchased/staple name, merges
case-duplicate list rows, batches at 400 ops, then sets the flag.

**Version check** — `BUILD` in `app.js` is compared against the live service
worker cache name; a mismatch shows "cache vN — reload" in the menu and marks
the corner version stamp stale.

Stores render as lettered squares (first letter, text color auto-picked from the
store color's brightness). Multi-store items show the other stores' squares
alongside.

## What's deliberately not built

| Not built | Why |
|---|---|
| Store gradients / second color | Built, then reverted. Stores are single solid colors. |
| Aisle-layout ordering | Rejected. Simple category clustering only — grouping veggies together is the actual need. |
| Synced check-in across phones | They occasionally split to different stores, but the shared-state cost wasn't worth it. Check-in is `useState` only — it does not survive a page reload either. |
| Prices / budgets | Never wanted. Purchase history records what and where, not how much. |
| Push notifications | Return reminders are an in-app banner only. |

---

## Conventions

- **Names are Title-Cased at write time.** The DB is the source of truth, not the
  view. Dedup on add compares lowercased names; document ids are `slug(name)`
  (lowercase, non-alphanumerics → `_`, capped at 120 chars). Store names keep
  whatever casing was typed.
- **`lookup(dict, name)` is not a slug lookup.** It is a linear scan: exact
  case-insensitive match first, then a substring match in either direction for
  names longer than 3 chars. See Known defects.
- **Palette lives in `:root` tokens** — `--brand`, `--ink`, `--muted`, `--paper`.
  A rebrand is a token swap, not a find-and-replace.
- **Every async mutation goes through `run(key, fn)`**, which sets a busy flag,
  catches, and flashes the error. `isBusy(key)` drives every spinner. Keep new
  writes on this path rather than calling Firestore directly.
- Management sheets: sticky header, scrollable body, `×` top-right.
- Store, category, staples, kitchen, and recipes all live under the hamburger menu.

## Gotchas

- **Storage uploads don't queue offline** the way Firestore writes do. Attaching
  a return receipt in a store dead zone fails and needs a retry. Firestore writes
  in the same dead zone are fine.
- **The parse call has a 20s timeout**; the recipe call has 30s. Items the parser
  can't route open the assign modal rather than landing silently in Unsorted.
- **Items added via Add-items go to the assign modal** with the AI category
  pre-filled and zero stores preselected. Only items already in the dictionary
  *with at least one store* route instantly. This is deliberate — auto-selecting
  all stores was the old bug. Note that the recipe and staples paths bypass this
  (see Known defects).
- **The worker's store suggestions are deliberately discarded** on the Add-items
  path. Only its category guess is used. The `merged` variable in `addItems` is
  the leftover of the old behavior and is dead — don't "fix" it by wiring it back
  in, that reintroduces the auto-select bug.
- **Drag-to-recategorize is pointer-events based** (touch + mouse) and is the
  feature most likely to need on-device tuning after a change.
- **Splitting is aggressive.** A pasted blob splits on newline, comma, semicolon,
  bullet, *and the word "and"* — so "salt and pepper" becomes two items.

---

## Known defects

Verified against the source, unfixed as of 2026-09-20.

| # | Defect | Impact |
|---|---|---|
| 1 | `shoppinglist_recipes` is absent from `firestore.rules`, which ends in a catch-all deny | Saving a recipe and the saved-recipes listener both fail with `permission-denied` under the rules in this repo. If it works in production, the live rules have drifted from the repo — fix the repo copy either way |
| 2 | `firestore.rules` and `storage.rules` still allowlist `you@gmail.com` / `wife@gmail.com` | Publishing the repo copies verbatim locks both accounts out. Edit the emails every time before publishing |
| 3 | `worker.js` sets `ALLOW_ORIGIN = "*"` and has no auth | Anyone who finds the worker URL can spend the Anthropic key. Lock it to the Pages origin |
| 4 | `addInShop` shadows `stores` with an array of ids, then passes it to `routeUnknowns`, which expects store objects | The worker prompt reads `Stores: undefined (undefined)` and all returned store ids get filtered out. Only the category survives, so it degrades silently |
| 5 | `lookup()` substring-matches in both directions | "Corn" matches a dictionary entry "Popcorn"; "Milk" matches "Milk Chocolate". Items route to the wrong store with no signal. It is also O(dictionary) and called from `storesOf()` for every item on every render |
| 6 | The worker's category list is hardcoded to the eight defaults | Categories added in-app can never be returned by the AI; those items always land in Unsorted |
| 7 | `addRecipeNeeds` and `addStaplesToList` insert items with empty `stores` and no assign modal | Recipe- and staple-sourced items can land unsorted with no store, contradicting the assign-modal rule |
| 8 | `addItems` writes 2 ops per item with no batch chunking | A paste over ~250 items exceeds Firestore's 500-op batch limit and throws. `cleanupNames` chunks at 400; this path doesn't |
| 9 | `shoppinglist_purchased` docs store no category | The History category filter resolves through the dictionary at render time, so recategorizing an item retroactively reclassifies its purchase history |
| 10 | `commitDelete` writes the whole `storeDraft` back to config | Deleting a store silently commits any unsaved name/color edits sitting in the Stores sheet |
| 11 | `config.example.js` uses a `.appspot.com` storage bucket | The real project uses `.firebasestorage.app`. Cosmetic, but it's the file someone copies from |

---

## Deploy runbook

Run these in order. Step 1 is the one that gets forgotten.

1. **Bump the version in two places, in lockstep:**
   - `sw.js` → `const CACHE = "basketly-vN"`
   - `app.js` line 18 → `const BUILD = "vN"`

   Both are currently **v62**. They must match — the menu's stale-cache warning
   compares them. Do this on *every* change. Skipping the `sw.js` bump means
   installed devices keep serving the stale shell.
2. **Push the PWA** to GitHub Pages (`index.html` at repo root).
3. **If `worker.js` changed**: deploy it separately with `wrangler deploy` from
   wherever the worker project lives. GitHub Pages does not deploy it. The
   deployed name is `shoppinglist` (worker URL:
   `https://shoppinglist.shubhamsaxena1492.workers.dev`).
4. **If rules changed**: republish — **merged** into the shared Firebase project's
   existing rules, not replacing them, and with the real emails substituted in.

Worker secrets: `ANTHROPIC_API_KEY` is an encrypted Worker secret
(`wrangler secret put ANTHROPIC_API_KEY`). It is not in this repo and must not be.

The service worker is **network-first** with cache fallback, same-origin GETs
only — new deploys land on the next open, and Firebase/CDN traffic bypasses it.

---

## Related

**SyncedList** — the multi-household fork of this app, for friends. Separate
repo, separate Firebase project, separate chat. Same core model, but data lives
under `households/{hid}/…` subcollections with `members/{uid}` role resolution
(admin / head / member) and single-use invite codes.

Basketly is the proving ground: features land here first, get used for a while,
then port over. When porting, the thing that breaks is permissions — anything
writing `config/app` (categories, kitchen staples, store adds, category reorder)
is head-only over there and must be role-gated, or members hit
`permission-denied`. Item recategorize is member-safe; it only touches list and
dictionary.

Basketly data was **not** migrated into SyncedList. Households start fresh.
