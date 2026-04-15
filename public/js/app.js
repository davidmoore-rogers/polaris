/**
 * public/js/app.js — Shared UI utilities: nav, toasts, modals, helpers
 */

// ─── Sidebar Navigation ──────────────────────────────────────────────────────

const NAV_ITEMS = [
  { href: "/",                label: "Dashboard",    icon: "grid" },
  { href: "/blocks.html",     label: "IP Blocks",    icon: "box" },
  { href: "/subnets.html",    label: "Subnets",      icon: "layers" },
  { href: "/reservations.html", label: "Reservations", icon: "bookmark" },
  { href: "/users.html",        label: "Users",        icon: "users" },
];

const ICONS = {
  grid: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/></svg>',
  box: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 16V8a2 2 0 00-1-1.73l-7-4a2 2 0 00-2 0l-7 4A2 2 0 003 8v8a2 2 0 001 1.73l7 4a2 2 0 002 0l7-4A2 2 0 0021 16z"/><polyline points="3.27 6.96 12 12.01 20.73 6.96"/><line x1="12" y1="22.08" x2="12" y2="12"/></svg>',
  layers: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="12 2 2 7 12 12 22 7 12 2"/><polyline points="2 17 12 22 22 17"/><polyline points="2 12 12 17 22 12"/></svg>',
  bookmark: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M19 21l-7-5-7 5V5a2 2 0 012-2h10a2 2 0 012 2z"/></svg>',
  users: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 00-3-3.87"/><path d="M16 3.13a4 4 0 010 7.75"/></svg>',
  logout: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 21H5a2 2 0 01-2-2V5a2 2 0 012-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/></svg>',
};

function renderNav() {
  const current = window.location.pathname;
  const sidebar = document.getElementById("sidebar");
  if (!sidebar) return;

  sidebar.innerHTML = `
    <div class="sidebar-brand">
      <img src="/logo.png" alt="Rogers Group" class="sidebar-logo">
      <p>IP Address Management</p>
    </div>
    <ul class="sidebar-nav">
      ${NAV_ITEMS.map(item => {
        const isActive = current === item.href || (item.href === "/" && (current === "/index.html" || current === "/"));
        return `<li><a href="${item.href}" class="${isActive ? "active" : ""}">${ICONS[item.icon]}<span>${item.label}</span></a></li>`;
      }).join("")}
    </ul>
    <div style="margin-top:auto;padding:0.75rem 0.5rem;border-top:1px solid var(--color-border-light)">
      <a href="#" id="btn-logout" style="display:flex;align-items:center;gap:10px;padding:0.5rem 0.75rem;border-radius:var(--radius-md);color:var(--color-text-secondary);font-size:0.9rem;font-weight:450;text-decoration:none;transition:background 0.15s,color 0.15s">${ICONS.logout}<span>Logout</span></a>
    </div>
  `;

  document.getElementById("btn-logout").addEventListener("click", async function (e) {
    e.preventDefault();
    try { await fetch("/api/v1/auth/logout", { method: "POST" }); } catch (_) {}
    window.location.href = "/login.html";
  });
}

// ─── Toasts ───────────────────────────────────────────────────────────────────

function getToastContainer() {
  let c = document.getElementById("toast-container");
  if (!c) {
    c = document.createElement("div");
    c.id = "toast-container";
    c.className = "toast-container";
    document.body.appendChild(c);
  }
  return c;
}

function showToast(message, type) {
  type = type || "success";
  const container = getToastContainer();
  const el = document.createElement("div");
  el.className = "toast toast-" + type;
  el.textContent = message;
  container.appendChild(el);
  setTimeout(function () {
    el.style.opacity = "0";
    el.style.transition = "opacity 0.3s";
    setTimeout(function () { el.remove(); }, 300);
  }, 3500);
}

// ─── Modal ────────────────────────────────────────────────────────────────────

function openModal(title, bodyHTML, footerHTML) {
  let overlay = document.getElementById("modal-overlay");
  if (!overlay) {
    overlay = document.createElement("div");
    overlay.id = "modal-overlay";
    overlay.className = "modal-overlay";
    overlay.innerHTML = '<div class="modal"><div class="modal-header"><h3></h3><button class="btn-icon modal-close">&times;</button></div><div class="modal-body"></div><div class="modal-footer"></div></div>';
    document.body.appendChild(overlay);
    overlay.addEventListener("click", function (e) {
      if (e.target === overlay) closeModal();
    });
    overlay.querySelector(".modal-close").addEventListener("click", closeModal);
  }
  overlay.querySelector(".modal-header h3").textContent = title;
  overlay.querySelector(".modal-body").innerHTML = bodyHTML;
  overlay.querySelector(".modal-footer").innerHTML = footerHTML || "";
  requestAnimationFrame(function () { overlay.classList.add("open"); });
}

function closeModal() {
  var overlay = document.getElementById("modal-overlay");
  if (overlay) overlay.classList.remove("open");
}

// ─── Confirm Dialog ───────────────────────────────────────────────────────────

function showConfirm(message) {
  return new Promise(function (resolve) {
    var body = '<p style="font-size:0.9rem;color:var(--color-text-secondary)">' + escapeHtml(message) + '</p>';
    var footer = '<button class="btn btn-secondary" id="confirm-cancel">Cancel</button><button class="btn btn-danger" id="confirm-ok">Confirm</button>';
    openModal("Confirm", body, footer);
    document.getElementById("confirm-cancel").onclick = function () { closeModal(); resolve(false); };
    document.getElementById("confirm-ok").onclick = function () { closeModal(); resolve(true); };
  });
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function escapeHtml(str) {
  if (!str) return "";
  return String(str).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function timeAgo(dateStr) {
  var diff = Math.floor((Date.now() - new Date(dateStr).getTime()) / 1000);
  if (diff < 0) return "just now";
  if (diff < 60) return diff + "s ago";
  if (diff < 3600) return Math.floor(diff / 60) + "m ago";
  if (diff < 86400) return Math.floor(diff / 3600) + "h ago";
  return Math.floor(diff / 86400) + "d ago";
}

function formatDate(dateStr) {
  if (!dateStr) return "-";
  return new Date(dateStr).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

function statusBadge(status) {
  return '<span class="badge badge-' + escapeHtml(status) + '">' + escapeHtml(status) + '</span>';
}

function tagsToArray(str) {
  return str.split(",").map(function (s) { return s.trim(); }).filter(Boolean);
}

function tagsToString(arr) {
  return (arr || []).join(", ");
}

// ─── Init ─────────────────────────────────────────────────────────────────────

document.addEventListener("DOMContentLoaded", function () {
  renderNav();
});
