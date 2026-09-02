/**
 * public/js/api-docs.js — behavior for the /api documentation page.
 *
 * GENERIC ONLY, on purpose: this file is served ungated by express.static
 * like every other /js asset, while the docs CONTENT lives inline in
 * public/api.html, which is reachable only through the source-IP gate in
 * src/app.ts (paths /api, /api/, /api.html). Nothing in here may enumerate
 * endpoints or carry documentation text — it fills the base URL, wires
 * copy buttons onto code blocks, and runs the TOC scrollspy.
 *
 * No inline <script> is possible (CSP scriptSrc 'self'), which is why this
 * file exists at all — the legacy-ipam-redirect.js precedent.
 */
(function () {
  "use strict";

  // The origin the reader browsed IS their base URL — no API call needed,
  // which matters on a page that deliberately loads no api.js.
  var baseUrl = window.location.origin + "/api/v1";
  document.querySelectorAll(".js-base-url").forEach(function (el) {
    el.textContent = baseUrl;
  });

  // Copy buttons on every <pre> — the curl examples are the main payload.
  document.querySelectorAll(".docs-content pre").forEach(function (pre) {
    var btn = document.createElement("button");
    btn.type = "button";
    btn.className = "copy-btn";
    btn.textContent = "Copy";
    btn.addEventListener("click", function () {
      var text = (pre.querySelector("code") || pre).textContent || "";
      var done = function (ok) {
        btn.textContent = ok ? "Copied" : "Copy failed";
        setTimeout(function () { btn.textContent = "Copy"; }, 1500);
      };
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(function () { done(true); }, function () { done(false); });
      } else {
        done(false);
      }
    });
    pre.appendChild(btn);
  });

  // TOC scrollspy — highlight the section currently in view.
  var tocLinks = Array.prototype.slice.call(document.querySelectorAll("#docs-toc a"));
  var sections = tocLinks
    .map(function (a) { return document.getElementById((a.getAttribute("href") || "").slice(1)); })
    .filter(Boolean);
  if (sections.length && "IntersectionObserver" in window) {
    var activeId = null;
    var setActive = function (id) {
      if (id === activeId) return;
      activeId = id;
      tocLinks.forEach(function (a) {
        a.classList.toggle("active", a.getAttribute("href") === "#" + id);
      });
    };
    var observer = new IntersectionObserver(
      function (entries) {
        entries.forEach(function (entry) {
          if (entry.isIntersecting) setActive(entry.target.id);
        });
      },
      // Fire when a section's top crosses the upper third of the viewport.
      { rootMargin: "-15% 0px -65% 0px" },
    );
    sections.forEach(function (s) { observer.observe(s); });
    setActive(sections[0].id);
  }
})();
