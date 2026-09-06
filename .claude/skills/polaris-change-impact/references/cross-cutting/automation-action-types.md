## cross-cutting/automation-action-types

**What it is:** The `actions` union on a NotificationRule — `notify` | `api_call` | `script` | `event`. Adding a member touches more than the schema, because several readers branch on "not notify and not api_call, therefore script".

**Everything that must learn about a new member:**
- `src/services/notificationTypes.ts` — the action schema, `actionSchema`, `escalatableActionSchema` (only if it can carry a chain), the `actionTypes` entry in `buildSchemaCatalog` (the builder is catalog-driven, so the dropdown updates itself), and `actionEscalation()` if the member has no `escalation` key.
- `src/services/automationActionService.ts` — the execute switch. Its final `else` is the SCRIPT branch; a new member must get its own `else if` or it will be executed as a script.
- `src/services/notificationRuleService.ts` — `assertActionRefs` (same final-`else`-is-script shape).
- `src/services/notificationEngine.ts` — `templatesOf` in the ruleWantsContext scan.
- `src/services/notificationEscalationService.ts` — the chain walk, if the member can't carry one.
- `public/js/automations-wizard.js` — `renderActionFields` / `collectActionCore` / `actionSummary`, and `addActionRow` if the escalation footer doesn't apply.
- `public/js/automations-wizard.js` — `ruleRecipientGroups` (`window.PolarisAutomationRecipients`), the walk behind the Automations list's **Addresses** column and the browser mirror of `allRuleActionRefs`. It is the one consumer that must learn about a new action LOCATION rather than a new action TYPE: a location it doesn't walk renders in the list as "nobody is notified", which is exactly the answer that column exists to give. Its two client-side companions are `testDeliveryTargets` (same walk, for the Test buttons) and `_awDraftFromRule`, which shares its `normalizeEscalationV2` because `withV2` fills reset/actions but never the escalation chain.

**Invariants:**
- **A member that changes behaviour by its ABSENCE needs a migration.** `event` gates the `notification.triggered` audit Event, so every pre-existing rule had to gain it (`20260810120000_event_action`) or it would have silently stopped auditing — and those Events feed the Events tab, the baseline event-trigger automations and the syslog/SFTP archivers. Both normalizers (`normalizeRuleInputCore` via `withEventAction`, and `normalizeRuleToV2`) inject it when folding a legacy shape forward, so an un-migrated row or a restored pre-upgrade backup behaves identically. An EXPLICIT `actions: []` is the opt-out and is never second-guessed.
- **event/change-triggered rules are carved out** of that injection everywhere (migration, both normalizers): the engine's event tail writes no Events by design — one that did would feed its own trigger.
- **The in-app Alert is not an action and can't become one.** `NotificationDelivery`, the escalation sweep, acknowledge/clear and `NotificationRuleState` all key on `Notification.id`.
- `addActionRow` sets `select.value` in JS rather than relying on the `selected` attribute written via innerHTML — the collector reads `.value`, and attribute reflection for a non-first option is environment-dependent.

**When changing this:** add the member to the catalog first (the builder picks it up for free), then let `npm run typecheck` enumerate the branch sites — every final-`else` narrowing failure is a place that would otherwise mis-handle it.

---
