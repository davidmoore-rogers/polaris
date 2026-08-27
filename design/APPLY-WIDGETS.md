# Widget pass 2 — acknowledgements, and two carried-over decisions

You are updating the **Polaris** repo. Scope: `public/js/widgets/activeAlerts.js`,
`public/css/styles.css`, and `design/css/polaris-ui.css`. Nothing else.

This supersedes the earlier widget uniformity prompt. **Items 1, 2, 3, 4 and 6
of that prompt are applied** — `PolarisWidgets.REFRESH` tiers are in
`widgets/index.js` and every `setInterval` reads one, the six frozen widgets
have `slow` timers, the three missing `requiredPermission` keys are declared,
the picker chrome follows `--color-accent`, and `--color-hover-tint` is a real
token that the whole stylesheet routes through. Nothing below re-does any of
that.

`polaris-kit/POLARIS-UI-GUIDE.md` section 14 documents the intended end state
and is the tie-breaker for anything ambiguous here.

## Ground rules

1. **Do not touch domain logic.** No changes to what the feed queries or to any
   `/noc-summary` server code.
2. **Keep every existing comment**, and port the reasoning comments below.
3. Item **3** is a decision that is not yours to make — surface it, don't guess.
4. If applying an item would break something the audit couldn't see, **stop and
   report it** rather than forcing it.

---

## 1. An acknowledged alert must say who acknowledged it, and why

Today an acknowledged row renders a bare `ack` pill whose owner is hidden in a
`title` tooltip, and the acknowledgement note is not rendered at all. Dashboards
run on wallboards, which never hover.

Two changes in `rowHTML()` in `public/js/widgets/activeAlerts.js`.

**a. Name the owner in the pill.** Replace the pill text `ack` with
`ack <acknowledgedBy>`, keeping the existing `title` as-is for the full phrasing
and falling back to a bare `ack` when the feed gives no name:

```js
var ackWho = r.acknowledgedBy ? "ack " + r.acknowledgedBy : "ack";
```

**b. Render the note on its own line, under the message.** The note is
`r.acknowledgementNote` (confirm the field name against the Notification model
before wiring it — see "Report back"). Emit it as a sibling after the
`.recent-item-meta` div, only when present:

```js
// The note is the one part of a HANDLED alert someone still needs to read —
// "generator running, crew at first light" is the difference between a
// dispatch and a wasted callout. Own line rather than a tail on the message:
// notes are sentences, and an inline tail truncates unpredictably.
var note = r.acknowledgementNote
  ? '<div class="dash-alert-ack-note">' + escapeHtml(r.acknowledgementNote) + '</div>'
  : "";
```

**c. The dim must stop applying to the acknowledgement.** This is the part that
matters, and it is a change to *how* the row dims, not just an addition.

Today the whole row carries `opacity:.6` when acknowledged. Composited, the note
would land at 2.43:1 against the card — below the 4.5:1 AA floor and below even
the 3:1 large-text floor, at 12.8px — on exactly the rows that have a note. The
pill fares barely better at ~3:1.

Move the dim off the row and onto the alert's own parts. Drop
`(r.acknowledged ? ";opacity:.6" : "")` from the row's inline style, and instead
apply the fade to the severity pill, the automation name, the hostname, the
dimension and the message — leaving the ack pill and the note undimmed:

```js
// The dim marks the ALERT as handled; it must not reach the acknowledgement.
// Fading the owner and the note along with the row compounded .6 onto an
// already-tertiary grey and put the note under AA contrast — on precisely the
// rows that carry one. Dim the alert, never the annotation on it.
var fade = r.acknowledged ? ';opacity:.6' : '';
```

Add the note's class to `public/css/styles.css`, beside the existing
`.dash-alert-dim` and `.widget-overflow-note` rules:

```css
/* An acknowledgement note under a handled alert. Full strength inside a dimmed
   row on purpose (see UI-GUIDE §14): the row fades to show the alert is owned,
   and the note is the part that still has to be read. */
.dash-alert-ack-note {
  margin-top: 4px;
  padding-left: 8px;
  border-left: 2px solid var(--color-border);
  font-size: 0.8rem;
  font-style: italic;
  line-height: 1.45;
  color: var(--color-text-secondary);
}
```

Update `renderPreview` so the library card shows the case: give one mock row an
`acknowledgedBy` and a real sentence of `acknowledgementNote`.

**Row-height note:** a long note makes an acked row two or three lines tall on a
height-1 card. Leave it wrapping for now and report how it looks on a real
dashboard — clamping to one line with the rest on hover is the fallback, but it
reintroduces the hover dependency this item is removing, so don't do it
pre-emptively.

## 2. Backport the widget/alert CSS the design folder never received

`design/css/polaris-ui.css` is the kit new apps are built from, and it has
drifted behind `public/css/styles.css`. It is missing, at least:

- `--color-hover-tint` and `--color-fill-subtle` (both theme families) — so the
  kit still hardcodes `rgba(255,255,255,0.06)` on six widget-chrome hovers and
  ships the daylight-invisible hover bug Polaris already fixed.
- `.recent-item-title .dash-alert-dim`
- `.widget-overflow-note`
- the `.widget-export-menu` block
- `.dash-alert-ack-note` from item 1

`polaris-kit/css/polaris-ui.css` already has the two tokens, the routed hovers
and the first two rules applied — copy those hunks from there rather than
re-deriving them. Sweep the design sheet for `rgba(255,255,255,0.0` afterwards
and report the before/after count; the only acceptable survivor is the
`var(--color-border, …)` fallback.

Then check the reverse direction too: report anything in `design/` that is
*ahead* of `public/`, since the drift has evidently run both ways.

## 3. DECISION REQUIRED — `.widget-pill-*` is still half tokenized

Unchanged from the last pass, still not mine or yours to decide.

`-orange` and `-neutral` use `var(--color-sev-serious)` /
`var(--color-sev-notice)`. `-ok` (`#81c784`), `-watch` (`#4fc3f7`), `-amber`
(`#ffd54f`) and `-red` (`#ef5350`) are literal hex, including the retired cyan
accent. The same four literals are duplicated in `activeAlerts.js`'s `SEV_BAR`
map for the row's left border.

**Do not swap them for `--color-success` / `--color-accent` / `--color-warning`
/ `--color-danger`.** They are deliberately softer tints, and swapping changes
pill rendering on every dashboard in every theme. Report it with a before/after
screenshot as its own decision.

---

## Verify

Run in all three themes (morning, noon, nightfall):

1. No console errors on `dash.html`.
2. An acknowledged alert shows `ack <name>`, and its note renders under the
   message at full strength while the alert text above it is visibly dimmed.
3. An acknowledged alert with **no** note shows the pill alone — no empty line.
4. An unacknowledged row is unchanged from today, pixel for pixel.
5. The note wraps rather than clipping, and the row grows to fit.
6. Add Widgets → the Active Alerts preview card shows the acked-with-note case.
7. CSV export is unaffected (the note is not a column unless you were asked for
   one — you weren't).

## Report back

- The real field name for the note on the Notification model, and whether
  `/noc-summary activeAlerts[]` already serves it. **If it does not, stop after
  the pill change and report** — the note rendering needs a feed change, which
  is outside this scope.
- Item 2's before/after literal count, and anything `design/` holds that
  `public/` lacks.
- Item 3, unapplied, with the comparison.
- How a two- or three-line note behaves on a height-1 card.
