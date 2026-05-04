// public/js/mobile/details.js — Detail-route renderers (asset, subnet,
// block, site).
//
// Same shape as tab specs in tabs.js: each entry is `{ renderTopbar, render }`
// keyed by the leading hash segment (`#asset/<id>` → `asset`).
//
// Phase 2 ships placeholder bodies so search results can navigate somewhere
// useful before the real screens land. Each later phase replaces a
// placeholder with the real renderer:
//   Phase 3 → site
//   Phase 5 → asset
//   Phase 8 → subnet
// `block` has no mobile destination on the roadmap — it stays a "view on
// desktop" placeholder indefinitely.

(function () {
  function backTopbar(title) {
    return ''
      + '<div class="m3-topbar">'
      + '  <div class="leading">'
      + '    <button class="icon-btn" id="back-btn" aria-label="Back"><svg viewBox="0 0 24 24"><use href="#i-back"/></svg></button>'
      + '  </div>'
      + '  <div class="title">' + escapeHtml(title) + '</div>'
      + '  <div class="trailing"></div>'
      + '</div>';
  }

  function placeholderBody(headline, body, viewOnDesktopHash) {
    var dh = viewOnDesktopHash ? viewOnDesktopHash : "";
    var btn = dh
      ? '<a class="btn btn-tonal" href="' + dh + '" style="margin-top:24px;">Open in desktop app</a>'
      : '';
    return ''
      + '<div class="empty-state" style="padding-top:64px;">'
      + '  <div class="icon"><svg viewBox="0 0 24 24"><use href="#i-construction"/></svg></div>'
      + '  <div class="ttl">' + escapeHtml(headline) + '</div>'
      + '  <div class="desc">' + escapeHtml(body) + '</div>'
      + '  ' + btn
      + '</div>';
  }

  // Wire the back button on detail pages. Call from each render().
  function wireBack(fallbackTab) {
    var btn = document.getElementById("back-btn");
    if (!btn) return;
    btn.addEventListener("click", function () {
      // Prefer browser-native back so the user returns to the previous tab
      // (search results, assets list, etc.) with their scroll position
      // intact. Fall back to the named tab when there's nothing to pop —
      // happens when the URL was opened directly.
      if (window.history.length > 1) window.history.back();
      else PolarisRouter.go(fallbackTab || "search", { replace: true });
    });
  }

  function escapeHtml(s) {
    if (s == null) return "";
    return String(s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }

  // ─── Asset detail (placeholder until Phase 5) ──────────────────────────
  var Asset = {
    renderTopbar: function (ctx) {
      return backTopbar("Asset");
    },
    render: function (body, ctx) {
      var id = ctx.route.parts[0] || "";
      body.innerHTML = placeholderBody(
        "Asset detail coming soon",
        "Phase 5 wires this screen up to the System tab — charts, interfaces, IP history. Asset id: " + id,
        "/assets.html#view=asset:" + id
      );
      wireBack("search");
    },
  };

  // ─── Subnet detail (placeholder until Phase 8) ─────────────────────────
  var Subnet = {
    renderTopbar: function () {
      return backTopbar("Subnet");
    },
    render: function (body, ctx) {
      var id = ctx.route.parts[0] || "";
      body.innerHTML = placeholderBody(
        "Subnet detail coming soon",
        "Phase 8 ships the IP list with reserve / release actions. Subnet id: " + id,
        "/subnets.html"
      );
      wireBack("search");
    },
  };

  // ─── Block detail (desktop-only) ───────────────────────────────────────
  var Block = {
    renderTopbar: function () {
      return backTopbar("Block");
    },
    render: function (body, ctx) {
      var id = ctx.route.parts[0] || "";
      body.innerHTML = placeholderBody(
        "Blocks live on desktop",
        "IP block management is a low-frequency operation — open the desktop app to view block details and utilization.",
        "/blocks.html"
      );
      wireBack("search");
    },
  };

  // ─── Map site (placeholder until Phase 3) ──────────────────────────────
  var Site = {
    renderTopbar: function () {
      return backTopbar("Site");
    },
    render: function (body, ctx) {
      var id = ctx.route.parts[0] || "";
      body.innerHTML = placeholderBody(
        "Device Map coming soon",
        "Phase 3 wires the Leaflet map up. Tapping a site from search will pan to that pin and open its topology. Site id: " + id,
        "/map.html#site=" + id
      );
      wireBack("map");
    },
  };

  window.PolarisDetails = {
    asset: Asset,
    subnet: Subnet,
    block: Block,
    site: Site,
  };
})();
