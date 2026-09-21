# Basketly — Project Handoff

A shared grocery/shopping-list PWA for a 2-person household. Built frameworkless (Preact + htm from esm.sh, no build step), deployed on GitHub Pages, backed by Firebase, with a Cloudflare Worker proxying Claude Haiku for parsing and recipe ideas.

Use this doc as the seed context for a new chat or a Claude Project. Attach the code files (`app.js`, `styles.css`, `sw.js`, `worker.js`, `index.html`, `manifest.webmanifest`, `firestore.rules`, `storage.rules`, `config.example.js`) alongside it. Do NOT attach the real `config.js` (it holds private keys).

---

## The problem it solves
One person (often via voice) adds items but forgets which store each belongs to, so items land on the wrong store's list. Basketly remembers each item's store(s) so routing is automatic, and organizes shopping by store visit.

## Tech stack
- **Frontend:** frameworkless PWA — Preact + htm imported from esm.sh, single `app.js` (~1140 lines), no bundler/build step.
- **Hosting:** GitHub Pages (deploys from a feature branch; master kept stable). All static files.
- **Data/auth:** Firebase — Firestore (real-time + offline persistence), Auth (Google, locked to 2 allowed emails), Cloud Storage (return attachments).
- **AI:** Cloudflare Worker (`worker.js`) holding the ANTHROPIC_API_KEY, proxying Claude Haiku (`claude-haiku-4-5`). Two routes: bare URL = item→store/category parsing; `/recipes` = recipe ideas.
- **Service worker:** `sw.js`, network-first, cache name bumped every deploy (currently `basketly-v62`).

## Data model (Firestore, single shared household, collections prefixed `shoppinglist_`)
- `shoppinglist_config/app` → `{ stores:[{id,name,color}], categories:[...], kitchen:[...], nameCaseV1:bool }`
- `shoppinglist_dictionary/{slug}` → `{ name, stores:[ids], category }` — the learned item→store/category map (doc id = slug(name), lowercase)
- `shoppinglist_list/{autoId}` → `{ key, name, stores:[ids], category, checked, tags:[...], addedBy, ts }`
- `shoppinglist_purchased/{autoId}` → `{ name, store, date, status, returnByDate?, attachUrl?, attachType?, attachPath? }` (status: purchased/returning/returned/kept)
- `shoppinglist_staples/{slug}` → `{ name, stores:[ids], category }` — the "Regularly Bought" palette

Names are stored in **Title Case** everywhere; all lookup/dedup is **case-insensitive** (via slug or lowercased compare).

---

## Current features

### List tab
- Category panels (shaded header, clear caret, collapsible), Expand/Collapse-all toggle.
- Per-item editor (tap a row): set category (dropdown) + store mappings (chips) + free-text tags ("for whom"/size). Star to promote to Regularly Bought; × to remove.
- Small green **category chip** on each row → one-tap category picker (2-col grid) to reassign instantly.
- **Drag to recategorize** (pointer-events, touch+mouse): drag an item onto a category panel to move it; drag a category header's grip onto another to reorder categories (saved to config, "Unsorted" pinned). Grips hidden by default; a **Reorder/Done** toggle shows them, and a **long-press (~420ms)** on any item auto-enters reorder mode and starts the drag. Floating drag label + edge auto-scroll.
- Inline **"+ New category"** (in the category dropdown and one-tap picker) and **"+ New store"** (chip in store rows; opens a name + color-picker sheet) — create-while-selecting without leaving the task.
- Multi-select store/tag filters. List-tools row: **Reorder (left) · count (center) · Collapse-all (right)**.

### Shop tab
- Store picker = grid of pastel tiles, **sorted by outstanding item count descending**, stable tiebreak (saved order), empty stores dimmed and sunk to the bottom. "+" tile adds a store.
- Check into one store → single-store checklist with a sticky "At [store] · Check out" strip. **Check out** commits (archives checked items as purchased, clears them, returns to picker).
- **Add-in-shop:** an "Add to [store]…" input that maps a new item straight to the checked-in store (parser used for category only).

### History tab (Purchase History)
- Paginated **20/page** (Prev/Next + page count).
- Filters: **category** (via dictionary lookup), **time ranges** (7/30/90 days, 6 months, 1 year, all time), **date Newest/Oldest**, store filter, date/store sort.
- Returns flow: mark for return + manual return-by date + optional image/PDF attachment (Cloud Storage); global banner when a return is within 5 days / overdue; resolve as Returned or Keeping.

### Adding items
- **Suggestions while typing** (Add sheet): the item after the last comma/newline is matched against the dictionary (everything added before); up to 8 matches, word-start matches first, then by purchase count. Each shows category + store squares; items already on the list are greyed "on list". **Tap = added to the list immediately** with the remembered stores/category (no AI call); the typed fragment is removed from the box and the keyboard stays up. A suggestion with no remembered store opens the store-picker popup instead.
- Paste a voice/text blob → known items route instantly (toast); every new/unknown item → store-picker popup with **AI category pre-filled and no stores preselected** (you pick stores). Comma/newline lists show all new items in one scrollable popup.

### Recipe Ideas (hamburger → full-screen overlay)
- Intake: big ingredient textbox (comma/newline) + tap-to-add **recent-produce chips** (last 30 days of Produce purchases, append into the box); single-select **Cuisine**; meal type (snack/meal/soft-for-sore-gums); who-for (baby/kids/adults/family) with baby age band; flavors.
- **Kitchen Staples** (managed list in config `kitchen`, collapsed "Assumed on hand" summary) assumed silently by the generator.
- Returns ≤5 dishes in collapsible panels, each with a **have/need** line, ingredients used, steps, notes. Baby path adds age-appropriate safety guidance.
- Worker `/recipes` takes `{ingredients, staples, mealType, cuisine, forWhom, ageBand, flavors, allowOneExtra}` and returns dishes with a `need` array.

### Other
- Hamburger menu: Regularly Bought, Recipe Ideas, Kitchen Staples, Manage Stores, Manage Categories, Sign out. (Menu items + panel headers Title-Cased.)
- All management sheets: sticky header + scrollable body + top-right × close.
- **Swipeable tabs** (List ↔ Shop ↔ History) via horizontal touch swipe; skips horizontal chip rows, inputs, open sheets, and active drags.
- Store identity = single solid pastel color + full-spectrum color picker; rendered as lettered squares (auto dark/light text).
- One-time background **name-cleanup migration** (guarded by config flag `nameCaseV1`): title-cases and merges case-duplicate names across list, dictionary, purchased, and staples. Runs silently once on load; to re-run, delete the flag and reload.

---

## Deploy workflow & gotchas
- **Two deploys are independent:** the PWA (GitHub Pages: `app.js`, `styles.css`, `sw.js`, etc.) and the Worker (`wrangler deploy worker.js`).
- **Bump the SW cache name every PWA deploy.** On phones, delete + re-add the home-screen app or it serves stale.
- "Nothing changed after deploy" usually = files didn't land where Pages serves; verify by loading raw `app.js` and checking the line count.
- The Worker needs a valid `ANTHROPIC_API_KEY` secret (a `claude 401` from `/recipes` means it's missing/invalid).
- Keep unverified code off master; deploy from a feature branch. (GitHub Pages had a stuck-queue incident once — a plain retry / letting the queue drain / Cloudflare Pages as an alt all work.)

## Interaction style the owner prefers
Advisor tone: challenge assumptions first, lead with the uncomfortable truth, tag confidence (Certain/Likely/Guessing), disagree with structure, no warm-up, hold positions unless given new info.

---

## Likely next steps / open items
- On-device tuning of the drag feature (long-press timing ~420ms, auto-scroll speed, drop accuracy) — flagged as the most tuning-prone piece.
- Optional: apply the same Reorder/expand-collapse to the Shop tab; persist collapsed state across sessions.
- Optional: shop-picker sort could switch to "empties-only sink" (keep fixed order) if live reordering feels disorienting.
- Singular/plural duplicates (e.g. Diaper vs Diapers) can still be created via the paste path; name canonicalization was considered and declined — suggestions are the chosen mitigation.
- Watch the name-cleanup migration covers any new collections added later.

## Parked (separate build, separate chat)
**SyncedList** — a multi-household fork for friends: separate Firebase project, `householdId` on every doc, invite codes, per-household config. Every read/write must be household-scoped; config-doc writes (category order, kitchen staples) are per-household there. This session's features port as "same UX + household scoping"; the category-reorder and kitchen-staples writes are the head/config-sensitive ones, the rest (recategorize, category chip, swipe, picker sort, history filters, add-in-shop) are member-safe.
