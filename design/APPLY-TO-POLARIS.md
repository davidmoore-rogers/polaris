# Apply the UI kit back to Polaris

You are updating the **Polaris** repo so its UI matches the reference kit in
`polaris-kit/` (attached). The kit was lifted out of Polaris, then corrected and
extended. Every item below is a real divergence: either a bug found in Polaris,
or a standardization the kit now defines.

## Ground rules

1. **The kit is the reference, not a drop-in.** Polaris keeps its own file
   layout (`public/css/styles.css`, `public/js/app.js`, `public/js/table-sf.js`,
   `public/js/theme-init.js`). Port the *changes* into those files. Do not
   replace `styles.css` with `polaris-ui.css` — the kit's copy has Polaris's
   domain sections stripped in places and reordered in others.
2. **Do not touch domain logic.** Discovery, IPAM, topology, monitoring,
   automations behavior, API calls: out of scope. This is presentation and the
   shared UI helpers only.
3. **Every change below has a reason stated.** If applying one would break
   something in Polaris that the kit doesn't know about, stop and report it
   instead of forcing it.
4. **Read `polaris-kit/POLARIS-UI-GUIDE.md` first.** It documents the intended
   end state for each pattern and is the tie-breaker for anything ambiguous here.
5. Preserve existing comments. Where the kit added an explanatory comment, port
   the comment too — several of these fixes are non-obvious and will be
   "cleaned up" by the next person otherwise.
6. **The mobile app and the alert email are out of scope.** The kit's
   `css/polaris-mobile.css`, `mobile-template.html` and `email/*` were lifted
   from Polaris unchanged, as the reference for *other* apps. Nothing in this
   document asks you to touch `public/css/mobile.css`, `public/js/mobile/*`,
   `public/mobile.html`, or `src/utils/alertEmailTemplate.ts`. The one thing to
   check: if section 1's theme work changes the theme id set, mobile's
   `:is([data-theme="morning"],[data-theme="noon"])` family selector and
   `MOBILE_THEME_IDS` in `js/mobile/app.js` must still resolve.

---

## 1. Themes: replace dark/light with morning, noon, nightfall

Polaris has two themes (`dark`, `light`). The kit has three: `morning`, `noon`
(daylight family) and `nightfall` (dark family). `dark` and `light` are retired.

**`public/css/styles.css`**

- The `:root` block stays as the **dark base**, refined by `nightfall`.
- The `[data-theme="light"]` token block becomes the **daylight base**, selector
  `:is([data-theme="morning"],[data-theme="noon"])`. Keep its neutral values.
- Rewrite **every** `[data-theme="light"] …` override to
  `:is([data-theme="morning"],[data-theme="noon"]) …`. There are ~96 of them.
  Use `:is()` — a comma-split rewrite silently breaks descendant selectors
  (`[data-theme="light"] .badge-x` must not become
  `[data-theme="light"], [data-theme="morning"] .badge-x`).
- Add the three token blocks from the kit CSS verbatim: `[data-theme="morning"]`,
  `[data-theme="noon"]`, `[data-theme="nightfall"]`. Nightfall's ground is
  `#141427`, accent `#4bbcee`, danger `#f71341`.
- Add `--color-primary` as an alias of `--color-accent` **in every theme block**.
  Polaris references `var(--color-primary)` (spinners, sidebar update badge,
  search-select focus ring) but never defines it, so those paint from an
  unresolved variable today.

**`public/js/app.js`**

- Add the `THEMES` array (in this order: morning, noon, nightfall), plus
  `DEFAULT_THEME = "nightfall"`. Display order and the default are deliberately
  separate — reordering the picker must not change what a new install gets.
- `getTheme(id)` falls back to `DEFAULT_THEME`, not `THEMES[0]`.
- `setTheme(id)` writes `data-theme`, persists to
  `localStorage["polaris-theme"]`, updates the footer button's icon + label, and
  **dispatches a `themechange` CustomEvent on `document`** with
  `{theme, family}`. Anything that cached colors (canvases, Leaflet layers,
  charts) should listen for it instead of hooking the toggle.
- Add `isLightTheme(id?)` returning true for the daylight family. **Replace every
  `theme === "light"` / `getAttribute("data-theme") === "light"` check in the
  codebase with it** — those checks now miss morning and noon. Known sites
  include `public/js/brand-logo.js` (`currentTheme()`), and any chart/map palette
  switch. Grep for `"light"` and audit each hit.
- Replace the two-way `toggleTheme` with `openThemeMenu(anchorEl)`, which opens
  the existing row-menu (`showRowMenu`) listing all themes with a ✓ on the
  current one. The sidebar footer button is labelled with the **current theme
  name** (not "Light Mode"/"Dark Mode") and opens that menu. Keep `toggleTheme()`
  as a next-theme stepper for any caller that still uses it.
- Icons: `sunriseIcon()` for morning, `sunIcon()` for noon, and a crescent
  `starIcon()` for nightfall. The kit's crescent is built as a **masked disc**
  (one circle kept, an offset circle punched out) — hand-fitted arcs collapse to
  a hairline or a ring at 15px. Copy it verbatim. `sunFaceIcon()` also exists in
  the kit (engraved sun face) but is not currently assigned to a theme.

**`public/js/theme-init.js`**

- `KNOWN = ["morning", "noon", "nightfall"]`. An unrecognized saved value (which
  now includes every existing user's stored `dark` or `light`) must fall through
  to the OS-preference path, not be trusted. This is what stops the whole install
  landing on an unstyled page after deploy.
- With no saved preference: `morning` for a light OS preference, `nightfall`
  otherwise. Still do not write localStorage here.

**Migration note to include in the release notes:** existing users' saved
`dark`/`light` values are invalid after this change and they will be moved to
their OS-appropriate default. That is intended; do not write a silent
`dark → nightfall` mapping unless the team asks for one.

---

## 2. Theme-aware brand logos

`public/js/brand-logo.js` already picks art per theme, but by id
(`=== "light"`). Change it to pick by **family** via `isLightTheme()`, so morning
and noon both take the `-light` art with no new assets. The asset paths
(`/img/brand/polaris-{horiz,vert,symbol}-{dark,light}.png`) are unchanged.

Also port from the kit:

- Resolve the asset base from the **script's own URL** rather than a mutable
  global, so a re-evaluated script can't reset it and the assets work from a
  subdirectory.
- Keep the `.brand-mark` / `.brand-mark-<surface>` marker classes on shipped art
  only, never on an operator upload — the shipped art is a fixed-aspect wordmark
  (120px in the sidebar, no radius), an upload is any shape.

---

## 3. Undefined and hardcoded colors (bugs)

All in `public/css/styles.css`:

| Rule | Problem | Fix |
|---|---|---|
| `.kpi-value` | `color: #fff` | `var(--color-text-primary)` — invisible on every light theme, including today's `light` |
| `.dep-tree-self` | `var(--color-text)`, defined nowhere, no fallback | `var(--color-text-primary)` |
| `var(--color-info, #4fc3f7)` (3 sites) | fallback hardcodes the retired cyan | `var(--color-accent)` |

Then sweep for the same class of bug: for every `#fff` / `#000` / literal hex in
a rule that paints **on a surface** (not on a colored fill like a badge or an
avatar), replace it with a token. Headings already have daylight overrides;
`.kpi-value` was the one that was missed, so assume there are others.

---

## 4. Table: checkbox column and the starved auto-fill column

**`public/js/table-sf.js`** — this is where column widths are actually decided.
A CSS width on `.cb-col` is inert, because under `table-layout: fixed` the
`<col>` wins, and the pin loop overwrites `widths[]` anyway.

- `FIXED_COL_W`: **20 → 34**. A ~16px checkbox in a 20px track has 2px either
  side, and the gap on its right also carries the next cell's padding, so it read
  as left-hugging. Also make the pin loop honour an inline `style="width:…"` on
  the `th` so a page can opt out per table:
  `widths[id] = declared > 0 ? declared : FIXED_COL_W`.
- Add `AUTOFILL_MIN_W = 36` and floor the auto-fill (last resizable) column at
  `max(AUTOFILL_MIN_W, width declared on its th)`. Starved below its label's
  min-content, that column wraps **one letter per line** and stretches the whole
  `thead` to ~124px, leaving a dead band above the first row. Overflow should go
  to the wrapper's horizontal scroll instead — that's recoverable, a broken
  header isn't.
- The narrow-column padding-strip test: `if (!w || w >= NARROW_COL_W) return;`
  → `w > NARROW_COL_W`. A column landing **exactly** on the threshold was the
  worst case: too narrow to hold its label, but not stripped of the padding
  squeezing it. (`NARROW_COL_W` and `AUTOFILL_MIN_W` are both 36; that overlap is
  why this matters.)

**`public/css/styles.css`**

```css
th.cb-col, td.cb-col { padding: 0 !important; text-align: center; }
th.cb-col input, td.cb-col input { margin: 0; vertical-align: middle; }
/* header checkbox on the label line, not centred in the tall two-row cell */
thead th.cb-col { vertical-align: top; padding: 0.65rem 0 0 0 !important; }
/* the cell after it gives up half its padding so the gaps read as equal */
td.cb-col + td { padding-left: 0.5rem; }
```

Do **not** set a width here, and do **not** apply the half-padding rule to `th`
— changing header padding breaks the filter row's alignment. Do not add
`white-space: nowrap` to `thead th` either; the auto-fill floor is the real fix
and nowrap fights `overflow-wrap: anywhere`.

Audit every list page for a trailing column with no declared width (Polaris's
ACTIONS columns). Give each an explicit `style="width:90px"` (or whatever its
content needs) on the `th`.

---

## 5. Page header overflow

`public/css/styles.css`:

- `.page-header-actions`: add `flex-wrap: wrap; justify-content: flex-end;
  min-width: 0`. With four or more header actions plus the user badge, the row
  overhangs its parent and the badge — which is last — gets sliced.
- `.page-header h2`: add `flex-shrink: 0; white-space: nowrap`. Since the actions
  row is now the thing that wraps, the title must be the thing that can't;
  otherwise it absorbs the loss and a two-word page name breaks onto two lines.
- `.user-badge-name`: add `min-width: 0; flex-shrink: 1`. The username is the one
  part of the badge that can lose characters and still identify the account.

---

## 6. Pagination row

`public/js/app.js`, `renderPageControls`:

- Grid columns `1fr auto 1fr` → `minmax(0,1fr) auto minmax(0,1fr)`. A `1fr`
  track refuses to shrink below its content and pushes the side columns into the
  centred nav.
- `white-space: nowrap` on the "N items" count, so it can't break between the
  number and the word.
- `.pg-right` gets `flex-wrap: wrap; justify-content: flex-end`.
- Margins: `0 0 10px` for the top instance, `10px 0 0` for the bottom one.
  Flush against the table border, these read as table chrome rather than as
  controls for the table.

---

## 7. Bulk bar and selected rows

`public/css/styles.css`:

- `.bulk-bar.bulk-bar-idle`: `background: var(--color-bg-primary)` (the
  `.table-wrapper` fill the unselected rows sit on — **not** `bg-secondary`,
  which is the body), `border-color: var(--color-border)`, `box-shadow: none`,
  and a `background/border-color/box-shadow 0.15s` transition. Idle, the bar
  should read as the table's top edge; it lights up (surface + accent ring +
  depth shadow) only when there's a selection to act on.
- Add selected-row styling, so the count in the bar can be paired with the rows:

```css
tbody tr.selected > td { background: color-mix(in srgb, var(--color-accent) 10%, var(--color-surface)); }
tbody tr.selected:hover > td { background: color-mix(in srgb, var(--color-accent) 16%, var(--color-surface)); }
tbody tr.selected > td:first-child { box-shadow: inset 3px 0 0 var(--color-accent); }
```

Then make every list page add/remove `.selected` on the `<tr>` alongside its
checkbox state (including on tbody re-render and select-all).

---

## 8. Badges

`public/css/styles.css`:

- `.badge-conflict`: `#ef5350` → `var(--color-danger)` with
  `rgba(255,23,68,0.12)` fill, matching `.badge-admin` and `.btn-danger`. A
  conflict is a problem to act on; the softer red read as informational. Update
  the daylight override to `rgba(198,40,40,…)` + `var(--color-danger)` to match.
- **`.badge-maintenance` is defined twice** — amber in the status block (~line
  2803) and purple in the monitor-state block (~line 2830). Purple wins on source
  order, so the amber rule is dead code that misleads anyone reading it. Delete
  the amber rule and leave a comment pointing at the survivor. Same for the two
  competing `[data-theme="light"] .badge-maintenance` rules. **Confirm with the
  team** which color is intended before changing behavior — this change keeps
  today's rendering (purple).
- Add `.badge-passive` (new state, blue-grey `#90a4ae` on
  `rgba(96,125,139,0.16)`; daylight `#455a64`). Blue-grey is the only unclaimed
  slot: green = ok, amber = attention, red = problem, blue = reserved, purple =
  maintenance, grey = retired. Passive should read as deliberate, not failed.

---

## 9. Overlays: reveal, lock, and the off-click hint

**`public/js/app.js`**

- `openModal`, `showConfirm`, `openSlideover` all reveal via
  `requestAnimationFrame` alone. rAF **does not fire in a hidden tab**, so a
  dialog opened in the background is built and never shown. Add an idempotent
  `reveal()` called from both rAF and a `setTimeout(…, 50)`.
- **Panel lock state must live on `window`**, not in file scope:
  `window.__polarisPanelLock = window.__polarisPanelLock || {state, user, wired}`.
  Polaris can evaluate `app.js` more than once; a fresh file-scope object silently
  resets the lock while the already-injected buttons keep claiming the old state.
- `initPanelLock({user})` (renamed from `_initPanelLock` + `_loadPanelLock`)
  must be **idempotent and late-safe**: listeners wired once, buttons re-synced
  on every call. Call it from the same ready path as the rest of the shell — if
  it runs before the scripts resolve, the observer never attaches and the
  preference keys to `anon` instead of the username.

---

## 10. Standardize the integration modals

Polaris has seven of these built by hand (FortiManager, FortiGate, Active
Directory, Entra ID, Windows Server, vCenter, Azure Arc) and they have drifted:
**two tab implementations** (`_intRenderTabbedBody`/`_intWireModalTabs` in
`integrations.js` duplicating the `assets.js` pattern), footers in different
orders, and per-type required-field checks copy-pasted with different rules.

Adopt the kit's `openIntegrationModal({product, action, tabs, requires, onTest,
onSave})` for all seven, and delete the duplicate tab helpers in favour of the
shared `tabbedBodyHTML` / `wireModalTabs`:

- **Title**: `"<Action> <Product> Integration"` — `Add FortiManager Integration`,
  never a bare `Add Integration`. The operator already picked a product to get
  here. (`_titleForType` already does this for the create flow; the **edit flow
  hardcodes `"Edit Integration"`** — fix that.)
- **Tabs**: General first (identity + connection), Monitoring second where it
  exists, then feature tabs. A concern with three fields is a section inside
  General, not a tab.
- **Field ids unique across tabs** (`f-host`, `f-apiToken`) so one pass collects
  the whole form. A per-tab read drops whatever the operator never opened.
- **Footer order**: `Test Connection` · `Cancel` · `Create`/`Save Changes`. Test
  is a secondary on the left — it's the rehearsal, not the commitment. Replace
  the `onclick="closeModal()"` inline handlers with wired listeners.
- **Test gating** moves into the `requires` list and the toast **names** the
  missing fields. Keep the existing per-type field lists as the `requires` data;
  the current inline `if (!val(…))` chains become configuration, not code.
- **Saving is never blocked on a passing test.** Preserve that; an operator
  configuring ahead of a firewall change has a legitimate reason to save
  something that can't connect yet. `onSave` receives `{tested}` if you want to
  warn.
- Both buttons disable and relabel while in flight (`Testing…`, `Creating…`).
- One more consistency bug to fix while in here: the create and edit flows build
  **two separate tab arrays**, and a tab added to one silently misses the other
  (the code already carries a comment warning about this). Build the tab list
  once per type and have both flows use it.

Also port the kit's shared form-part helpers so these modals stop hand-rolling
the same markup: `sectionHeading`, `formDivider`, `infoBox`, `checkboxRow`,
`calloutHTML`.

---

## 11. Smaller items

- `.slideover-header-top .btn-icon:not(.panel-lock-btn)`: `font-size: 1.25rem`
  so the slide-over close matches `.modal-close`. Same glyph, same job.
- Sidebar footer order is fixed: status panels → divider → bottom links (Server
  Settings, theme picker, Logout last and the only red item) → version →
  update line. Verify Polaris still matches after the theme-picker change.
- `renderStatusPanel` markup (`.query-spinner`, `.query-status-label`, per-item
  `.query-abort-btn`) — the kit matches Polaris here; no change expected, but
  diff it.

---

## Verification checklist

Run through this after applying, in each of the three themes:

1. No console errors on every page.
2. **Zero unresolved custom properties**: collect every `--*` defined across the
   loaded stylesheets and every `var(--*)` referenced; the referenced set must be
   a subset of the defined set (allowing explicit fallbacks).
3. A fresh browser with no `polaris-theme` saved lands on morning or nightfall
   per OS preference; a browser holding a stale `dark` or `light` lands on a
   valid theme, not an unstyled page.
4. Brand art swaps with the theme on the login card and the sidebar, and an
   operator upload still overrides both.
5. Every list page: `thead` is ~56px (not ~124px), no trailing column starved,
   ACTIONS labels on one line, checkbox column 34px with even space either side.
6. A page header with four actions plus the user badge: the actions row wraps,
   the title stays on one line, nothing overhangs the header's right edge.
7. Bulk bar is invisible against the table when nothing is selected, and lights
   up with the selected rows highlighted when something is.
8. Open a modal, switch tabs, click the backdrop: it stays open when locked (X
   flashes with the escalating bloom) and closes when unlocked. The lock
   preference is keyed to the username and survives a reload.
9. All seven integration modals: correct title, footer order, tab order; Test
   with an empty form names the missing fields; Save works without a prior test.
10. `grep` for `theme === "light"`, `data-theme="light"`, `--color-info`,
    `--color-text)`, `FIXED_COL_W = 20` — all should return nothing.
