## cross-cutting/csp-inline-script-policy

**What it is:** Helmet's Content-Security-Policy in `src/app.ts` sets `scriptSrc: ["'self'"]` — every `<script>...</script>` block with inline content is BLOCKED by the browser. Only external `<script src="...">` tags and inline `on*=` handler attributes (allowed via `scriptSrcAttr: ["'unsafe-inline'"]`) are permitted. This is the most dangerous XSS vector closed by the strict CSP, and it must stay closed.

**Writers** (anywhere a Polaris route or stub HTML emits inline scripts — must be EMPTY of inline scripts):
- `src/app.ts` — `legacyIpamRedirect()` stub HTML. Loads `/js/legacy-ipam-redirect.js` (external file at `public/js/legacy-ipam-redirect.js`) which reads `location.pathname` to decide the target tab and `location.hash` to preserve the legacy fragment, then `location.replace()`s to `/ipam.html#tab=<tab>&<legacyHash>`. Was a `blank page` regression for two weeks (2026-04 to 2026-05) when this used an inline `<script>` block — CSP silently blocked the redirect, leaving a blank body. Symptom for the operator: clicking "View Lease → Open in Networks" on the assets page navigated to `/subnets.html#ip=<sid>@<ip>` and stayed blank.
- Any future server-rendered stub or framework view should use an external file (or pass data via `data-*` attributes that the external script reads via `document.currentScript.dataset`).

**Readers** (the CSP itself):
- `src/app.ts` — Helmet `contentSecurityPolicy.directives.scriptSrc: ["'self'"]` blocks inline; `scriptSrcAttr: ["'unsafe-inline'"]` keeps `onclick="..."` working because most pages still build HTML via `innerHTML`.
- `connectSrc` is `'self'` plus specific whitelisted hosts, each with a documented consumer: `https://fonts.googleapis.com` + `https://fonts.gstatic.com` — fetch()ed by the asset-details Screenshot buttons (desktop `_screenshotAssetDetails` in `public/js/assets.js` and mobile `screenshotSheet` in `public/js/mobile/asset-detail.js`; the vendored html-to-image inlines the page's webfonts into its DOM snapshot so the captured PNG renders in Inter/Roboto Mono; degrades to fallback system fonts when unreachable). `https://api.rainviewer.com` + `https://api.open-meteo.com` — fetch()ed by the Status Map dashboard widget (`public/js/widgets/siteMap.js`, type `siteMap`) for the radar frame index + current-temperature labels; sends only approximate site lat/long, degrades silently offline. `imgSrc` likewise adds `https://*.rainviewer.com` for the radar tiles (loaded as `<img>`, alongside the existing OSM basemap tile host). Don't widen connectSrc/imgSrc beyond specific origins with a documented consumer.

**Invariants:**
- Never emit `<script>...code...</script>` from any HTTP route handler or static file. Always use `<script src="/js/something.js"></script>`. If the inline script needs runtime values from the server, render those as `data-*` attributes on a placeholder element and read them in the external script.
- Adding a CSP hash or nonce for ONE inline script is a slippery slope — it normalizes the pattern. Prefer an external file unless there's a hard reason (e.g. shipping a critical-rendering-path bootstrap that must run before the first paint AND can't be moved to `<head>` async).
- `scriptSrcAttr: 'unsafe-inline'` is the only inline allowance; it's there because `innerHTML`-built `onclick="foo(...)"` is everywhere in the frontend. Don't widen the main `scriptSrc`.
- Browsers fail SILENTLY on CSP block — DevTools console shows the violation but the page renders blank with no JS-thrown error. Always test stub HTML by visiting it in a browser with DevTools open, not just by curling the response and inspecting the body.

**When changing this:**
- Adding a server-rendered HTML stub? Move ALL JS into an external file under `public/js/`. The route handler returns markup with `<script src="..."></script>` only — no inline blocks.
- Need server-side state in client-side code? Render the state into the HTML as `data-*` attributes (`<div id="boot" data-foo="bar">`), then read it from the external script via `document.getElementById("boot").dataset.foo`. Never interpolate JSON into an inline `<script>` block.
- Loosening the CSP for a third-party widget (analytics, support chat, embedded video)? Add the specific origin to `scriptSrc`, not `'unsafe-inline'`. Document the exception in the directive's comment.
- Testing a stub-HTML change? Visit the URL in a browser with DevTools console open — a blocked inline script logs `Refused to execute inline script because it violates the following Content Security Policy directive: "script-src 'self'"`. A blank body with no JS-thrown error in the source IS the CSP-blocked symptom.
- Adding inline `<style>` tags? Those are allowed via the existing `styleSrc: ["'self'", "'unsafe-inline'"]`. Only scripts have the strict rule.

---
