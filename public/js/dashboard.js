/**
 * public/js/dashboard.js — Dashboard overview page logic
 */

var STATUS_COLORS = { available: "#00c853", discovered: "#FF9800", reserved: "#4fc3f7", deprecated: "#757575" };

document.addEventListener("DOMContentLoaded", async function () {
  try {
    var data = await api.utilization.global();
    renderKPIs(data);
    renderDonut(data);
    renderBarChart(data);
    renderBlockUtil(data);
    renderRecent(data);
  } catch (err) {
    showToast("Failed to load dashboard: " + err.message, "error");
  }
});

function renderKPIs(data) {
  var grid = document.getElementById("kpi-grid");
  var items = [
    { label: "IP Blocks", value: data.totalBlocks },
    { label: "Total Networks", value: data.totalSubnets },
    { label: "Active Reservations", value: data.totalActiveReservations },
  ];
  grid.innerHTML = items.map(function (k) {
    return '<div class="kpi-card"><p class="kpi-label">' + escapeHtml(k.label) + '</p><p class="kpi-value">' + k.value + '</p></div>';
  }).join("");
}

function renderDonut(data) {
  var container = document.getElementById("donut-chart");
  var total = data.totalSubnets;
  var s = data.subnetsByStatus;
  var slices = [
    { label: "Available",  value: s.available,  color: STATUS_COLORS.available },
    { label: "Reserved",   value: s.reserved,   color: STATUS_COLORS.reserved },
    { label: "Deprecated", value: s.deprecated, color: STATUS_COLORS.deprecated },
  ];
  var usedPct = total === 0 ? 0 : Math.round(((s.reserved + s.deprecated) / total) * 100);

  var r = 52, cx = 70, cy = 70, circ = 2 * Math.PI * r;
  var offset = 0;
  var arcs = slices.map(function (d) {
    var pct = total === 0 ? 0 : d.value / total;
    var arc = { color: d.color, pct: pct, offset: offset, dash: pct * circ, gap: (1 - pct) * circ };
    offset += pct;
    return arc;
  });

  var svg = '<svg width="140" height="140" viewBox="0 0 140 140">';
  arcs.forEach(function (arc) {
    svg += '<circle cx="' + cx + '" cy="' + cy + '" r="' + r + '" fill="none" stroke="' + arc.color + '" stroke-width="14" stroke-dasharray="' + arc.dash + ' ' + arc.gap + '" stroke-dashoffset="' + -(arc.offset * circ - circ / 4) + '"/>';
  });
  svg += '<text x="' + cx + '" y="' + (cy - 6) + '" text-anchor="middle" font-size="22" font-weight="700" font-family="Roboto Mono,monospace" fill="#fff">' + usedPct + '%</text>';
  svg += '<text x="' + cx + '" y="' + (cy + 14) + '" text-anchor="middle" font-size="11" fill="#8888a0">in use</text>';
  svg += '</svg>';

  var legend = slices.map(function (d) {
    return '<div style="margin-bottom:6px"><div class="legend-item"><span class="legend-dot" style="background:' + d.color + '"></span>' + d.label + '</div><span style="font-size:1.2rem;font-weight:500">' + d.value + '</span></div>';
  }).join("");

  container.innerHTML = '<div style="display:flex;align-items:center;justify-content:center;gap:20px">' + svg + '<div>' + legend + '</div></div>';
}

function renderBarChart(data) {
  var legend = document.getElementById("bar-chart-legend");
  legend.innerHTML = Object.entries(STATUS_COLORS).map(function (e) {
    return '<span class="legend-item"><span class="legend-dot" style="background:' + e[1] + '"></span>' + e[0].charAt(0).toUpperCase() + e[0].slice(1) + '</span>';
  }).join("");

  var container = document.getElementById("bar-chart");
  if (!data.blockUtilization || data.blockUtilization.length === 0) {
    container.innerHTML = '<p class="empty-state">No blocks yet</p>';
    return;
  }

  container.innerHTML = data.blockUtilization.map(function (b) {
    var total = b.totalSubnets || 1;
    return '<div style="margin-bottom:10px">' +
      '<div style="display:flex;justify-content:space-between;margin-bottom:3px"><span style="font-size:0.82rem;font-weight:450">' + escapeHtml(b.name) + '</span><span style="font-size:0.75rem;color:var(--color-text-tertiary)">' + b.totalSubnets + ' networks</span></div>' +
      '<div class="stacked-bar">' +
        '<div class="stacked-bar-segment" style="flex:' + b.availableSubnets + ';background:' + STATUS_COLORS.available + '"></div>' +
        '<div class="stacked-bar-segment" style="flex:' + (b.discoveredSubnets || 0) + ';background:' + STATUS_COLORS.discovered + '"></div>' +
        '<div class="stacked-bar-segment" style="flex:' + b.reservedSubnets + ';background:' + STATUS_COLORS.reserved + '"></div>' +
        '<div class="stacked-bar-segment" style="flex:' + b.deprecatedSubnets + ';background:' + STATUS_COLORS.deprecated + '"></div>' +
      '</div></div>';
  }).join("");
}

function fmtAddrs(n) {
  if (n >= 1048576) return (n / 1048576).toFixed(1).replace(/\.0$/, "") + "M";
  if (n >= 1024)    return Math.round(n / 1024) + "K";
  return String(n);
}

function renderBlockUtil(data) {
  var container = document.getElementById("block-util");
  if (!data.blockUtilization || data.blockUtilization.length === 0) {
    container.innerHTML = '<p class="empty-state">No blocks yet</p>';
    return;
  }

  container.innerHTML = data.blockUtilization.map(function (b) {
    var pct = b.usedPercent != null ? b.usedPercent : 0;
    var color = pct > 75 ? "#ff1744" : pct > 50 ? "#ffd600" : "#4fc3f7";
    var addrLabel = (b.blockAddresses != null)
      ? fmtAddrs(b.allocatedAddresses) + ' / ' + fmtAddrs(b.blockAddresses) + ' IPs'
      : b.totalSubnets + ' subnets';
    return '<div class="block-util-item">' +
      '<div class="block-util-header"><div class="block-util-name"><span>' + escapeHtml(b.name) + '</span><code>' + escapeHtml(b.cidr) + '</code></div><span class="block-util-count">' + addrLabel + '</span></div>' +
      '<div class="util-row"><div class="util-bar-track"><div class="util-bar-fill" style="width:' + pct + '%;background:' + color + '"></div></div><span style="font-size:0.82rem;color:var(--color-text-secondary);min-width:32px;text-align:right">' + pct + '%</span></div></div>';
  }).join("");
}

function renderRecent(data) {
  var container = document.getElementById("recent-reservations");
  if (!data.recentReservations || data.recentReservations.length === 0) {
    container.innerHTML = '<p class="empty-state">No recent reservations</p>';
    return;
  }

  container.innerHTML = data.recentReservations.map(function (r) {
    var badges = '<code>' + escapeHtml(r.subnetCidr) + '</code>';
    if (r.vlan) badges += ' <span class="badge badge-vlan">VLAN ' + r.vlan + '</span>';
    if (r.ipAddress) badges += ' <span class="badge badge-active">' + escapeHtml(r.ipAddress) + '</span>';
    return '<div class="recent-item"><div>' +
      '<div class="recent-item-title"><span>' + escapeHtml(r.subnetName) + '</span>' + badges + '</div>' +
      (r.subnetPurpose ? '<p style="font-size:0.82rem;color:var(--color-text-tertiary);margin-bottom:4px">' + escapeHtml(r.subnetPurpose) + '</p>' : '') +
      '<div class="recent-item-meta"><span>' + escapeHtml(r.owner) + '</span><span style="color:var(--color-text-tertiary)">&middot;</span><span>' + escapeHtml(r.projectRef) + '</span></div>' +
      '</div><span class="recent-item-time">' + timeAgo(r.createdAt) + '</span></div>';
  }).join("");
}
