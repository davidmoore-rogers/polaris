import { useState, useEffect } from "react";
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, Cell } from "recharts";

const MOCK_UTILIZATION = {
  totalBlocks: 4,
  totalSubnets: 18,
  totalActiveReservations: 11,
  subnetsByStatus: { available: 7, reserved: 9, deprecated: 2 },
  blockUtilization: [
    { id: "1", name: "Corporate DC", cidr: "10.0.0.0/8", totalSubnets: 6, availableSubnets: 1, reservedSubnets: 4, deprecatedSubnets: 1, usedPercent: 83 },
    { id: "2", name: "Production Cloud", cidr: "172.16.0.0/12", totalSubnets: 5, availableSubnets: 2, reservedSubnets: 3, deprecatedSubnets: 0, usedPercent: 60 },
    { id: "3", name: "Dev & Staging", cidr: "192.168.0.0/16", totalSubnets: 5, availableSubnets: 3, reservedSubnets: 2, deprecatedSubnets: 0, usedPercent: 40 },
    { id: "4", name: "Management", cidr: "10.255.0.0/16", totalSubnets: 2, availableSubnets: 1, reservedSubnets: 0, deprecatedSubnets: 1, usedPercent: 50 },
  ],
  recentReservations: [
    { id: "r1", subnetCidr: "10.0.4.0/24", subnetName: "K8s Node Pool", subnetPurpose: "Production Kubernetes worker nodes", vlan: 410, ipAddress: null, owner: "platform-eng", projectRef: "INFRA-221", createdAt: new Date(Date.now() - 1000 * 60 * 22) },
    { id: "r2", subnetCidr: "172.16.8.0/24", subnetName: "API Gateway", subnetPurpose: "Public-facing API gateway cluster", vlan: 820, ipAddress: "172.16.8.14", owner: "api-team", projectRef: "PROJ-884", createdAt: new Date(Date.now() - 1000 * 60 * 67) },
    { id: "r3", subnetCidr: "192.168.10.0/24", subnetName: "Staging DB", subnetPurpose: "Staging PostgreSQL replicas", vlan: 110, ipAddress: null, owner: "data-team", projectRef: "DB-056", createdAt: new Date(Date.now() - 1000 * 60 * 180) },
    { id: "r4", subnetCidr: "10.0.6.0/24", subnetName: "CI Runners", subnetPurpose: "GitHub Actions self-hosted runners", vlan: 412, ipAddress: null, owner: "devops", projectRef: "CI-019", createdAt: new Date(Date.now() - 1000 * 60 * 340) },
    { id: "r5", subnetCidr: "172.16.20.0/22", subnetName: "ML Training", subnetPurpose: "GPU cluster for model training jobs", vlan: 830, ipAddress: null, owner: "ml-platform", projectRef: "ML-103", createdAt: new Date(Date.now() - 1000 * 60 * 700) },
  ],
};

function timeAgo(date) {
  const diff = Math.floor((Date.now() - date) / 1000);
  if (diff < 60) return `${diff}s ago`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

function UtilBar({ used, total, color }) {
  const pct = total === 0 ? 0 : Math.round((used / total) * 100);
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
      <div style={{ flex: 1, height: 6, background: "var(--color-border-tertiary)", borderRadius: 99, overflow: "hidden" }}>
        <div style={{ width: `${pct}%`, height: "100%", background: color, borderRadius: 99, transition: "width .4s ease" }} />
      </div>
      <span style={{ fontSize: 12, color: "var(--color-text-secondary)", minWidth: 32, textAlign: "right" }}>{pct}%</span>
    </div>
  );
}

const STATUS_COLORS = { available: "#1D9E75", reserved: "#378ADD", deprecated: "#888780" };

const CustomTooltip = ({ active, payload, label }) => {
  if (!active || !payload?.length) return null;
  return (
    <div style={{ background: "var(--color-background-primary)", border: "0.5px solid var(--color-border-secondary)", borderRadius: 8, padding: "8px 12px", fontSize: 13 }}>
      <p style={{ margin: "0 0 4px", fontWeight: 500 }}>{label}</p>
      {payload.map(p => (
        <p key={p.name} style={{ margin: "2px 0", color: p.fill }}>{p.name}: {p.value}</p>
      ))}
    </div>
  );
};

export default function IPAMDashboard() {
  const [data] = useState(MOCK_UTILIZATION);
  const [selectedBlock, setSelectedBlock] = useState(null);

  const { totalBlocks, totalSubnets, totalActiveReservations, subnetsByStatus, blockUtilization, recentReservations } = data;
  const totalUsed = subnetsByStatus.reserved + subnetsByStatus.deprecated;
  const globalPct = totalSubnets === 0 ? 0 : Math.round((totalUsed / totalSubnets) * 100);

  const chartData = blockUtilization.map(b => ({
    name: b.name.length > 14 ? b.name.slice(0, 13) + "…" : b.name,
    fullName: b.name,
    cidr: b.cidr,
    Available: b.availableSubnets,
    Reserved: b.reservedSubnets,
    Deprecated: b.deprecatedSubnets,
  }));

  const pieData = [
    { label: "Available", value: subnetsByStatus.available, color: STATUS_COLORS.available },
    { label: "Reserved", value: subnetsByStatus.reserved, color: STATUS_COLORS.reserved },
    { label: "Deprecated", value: subnetsByStatus.deprecated, color: STATUS_COLORS.deprecated },
  ];

  const r = 52, cx = 70, cy = 70, circ = 2 * Math.PI * r;
  let offset = 0;
  const arcs = pieData.map(d => {
    const pct = totalSubnets === 0 ? 0 : d.value / totalSubnets;
    const arc = { ...d, pct, offset, dash: pct * circ, gap: (1 - pct) * circ };
    offset += pct;
    return arc;
  });

  return (
    <div style={{ fontFamily: "var(--font-sans)", padding: "1.5rem 0" }}>
      <h2 style={{ fontSize: 11, fontWeight: 500, letterSpacing: "0.1em", textTransform: "uppercase", color: "var(--color-text-tertiary)", margin: "0 0 1.25rem" }}>IP Address Management</h2>

      {/* KPI Row */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 10, marginBottom: "1.5rem" }}>
        {[
          { label: "IP Blocks", value: totalBlocks },
          { label: "Total Subnets", value: totalSubnets },
          { label: "Active Reservations", value: totalActiveReservations },
        ].map(k => (
          <div key={k.label} style={{ background: "var(--color-background-secondary)", borderRadius: 8, padding: "12px 14px" }}>
            <p style={{ margin: "0 0 4px", fontSize: 11, color: "var(--color-text-tertiary)", letterSpacing: "0.06em", textTransform: "uppercase" }}>{k.label}</p>
            <p style={{ margin: 0, fontSize: 26, fontWeight: 500, lineHeight: 1 }}>{k.value}</p>
          </div>
        ))}
      </div>

      {/* Usage Overview row */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1.8fr", gap: 12, marginBottom: "1.5rem" }}>

        {/* Donut */}
        <div style={{ background: "var(--color-background-primary)", border: "0.5px solid var(--color-border-tertiary)", borderRadius: 12, padding: "1rem 1.25rem" }}>
          <p style={{ margin: "0 0 12px", fontSize: 12, fontWeight: 500, color: "var(--color-text-secondary)" }}>Subnet status</p>
          <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
            <svg width="140" height="140" viewBox="0 0 140 140" aria-label={`Donut chart: ${subnetsByStatus.available} available, ${subnetsByStatus.reserved} reserved, ${subnetsByStatus.deprecated} deprecated`} role="img">
              {arcs.map((arc, i) => (
                <circle key={i} cx={cx} cy={cy} r={r}
                  fill="none"
                  stroke={arc.color}
                  strokeWidth={14}
                  strokeDasharray={`${arc.dash} ${arc.gap}`}
                  strokeDashoffset={-(arc.offset * circ - circ / 4)}
                  style={{ transition: "stroke-dasharray .4s ease" }}
                />
              ))}
              <text x={cx} y={cy - 6} textAnchor="middle" fontSize="22" fontWeight="500" fill="var(--color-text-primary)">{globalPct}%</text>
              <text x={cx} y={cy + 14} textAnchor="middle" fontSize="11" fill="var(--color-text-tertiary)">in use</text>
            </svg>
            <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
              {pieData.map(d => (
                <div key={d.label}>
                  <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 2 }}>
                    <div style={{ width: 8, height: 8, borderRadius: 2, background: d.color, flexShrink: 0 }} />
                    <span style={{ fontSize: 12, color: "var(--color-text-secondary)" }}>{d.label}</span>
                  </div>
                  <span style={{ fontSize: 18, fontWeight: 500, lineHeight: 1 }}>{d.value}</span>
                </div>
              ))}
            </div>
          </div>
        </div>

        {/* Stacked bar chart */}
        <div style={{ background: "var(--color-background-primary)", border: "0.5px solid var(--color-border-tertiary)", borderRadius: 12, padding: "1rem 1.25rem" }}>
          <p style={{ margin: "0 0 4px", fontSize: 12, fontWeight: 500, color: "var(--color-text-secondary)" }}>Subnets per block</p>
          <div style={{ display: "flex", gap: 12, marginBottom: 10 }}>
            {Object.entries(STATUS_COLORS).map(([k, c]) => (
              <span key={k} style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 11, color: "var(--color-text-tertiary)" }}>
                <span style={{ width: 8, height: 8, borderRadius: 2, background: c, display: "inline-block" }} />
                {k.charAt(0).toUpperCase() + k.slice(1)}
              </span>
            ))}
          </div>
          <div style={{ height: 140 }}>
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={chartData} margin={{ top: 0, right: 0, left: -24, bottom: 0 }} barSize={18}>
                <XAxis dataKey="name" tick={{ fontSize: 11, fill: "var(--color-text-tertiary)" }} axisLine={false} tickLine={false} />
                <YAxis tick={{ fontSize: 11, fill: "var(--color-text-tertiary)" }} axisLine={false} tickLine={false} allowDecimals={false} />
                <Tooltip content={<CustomTooltip />} cursor={{ fill: "var(--color-background-secondary)" }} />
                <Bar dataKey="Available" stackId="a" fill={STATUS_COLORS.available} radius={[0, 0, 0, 0]} />
                <Bar dataKey="Reserved" stackId="a" fill={STATUS_COLORS.reserved} />
                <Bar dataKey="Deprecated" stackId="a" fill={STATUS_COLORS.deprecated} radius={[3, 3, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>
      </div>

      {/* Block utilization list */}
      <div style={{ background: "var(--color-background-primary)", border: "0.5px solid var(--color-border-tertiary)", borderRadius: 12, padding: "1rem 1.25rem", marginBottom: "1.5rem" }}>
        <p style={{ margin: "0 0 14px", fontSize: 12, fontWeight: 500, color: "var(--color-text-secondary)" }}>Block utilization</p>
        <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          {blockUtilization.map(b => (
            <div key={b.id}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 6 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <span style={{ fontSize: 13, fontWeight: 500 }}>{b.name}</span>
                  <code style={{ fontSize: 11, color: "var(--color-text-tertiary)", background: "var(--color-background-secondary)", padding: "1px 6px", borderRadius: 4 }}>{b.cidr}</code>
                </div>
                <span style={{ fontSize: 12, color: "var(--color-text-tertiary)" }}>{b.reservedSubnets + b.deprecatedSubnets}/{b.totalSubnets} subnets</span>
              </div>
              <UtilBar
                used={b.reservedSubnets + b.deprecatedSubnets}
                total={b.totalSubnets}
                color={b.usedPercent > 75 ? "#E24B4A" : b.usedPercent > 50 ? "#EF9F27" : "#378ADD"}
              />
            </div>
          ))}
        </div>
      </div>

      {/* Recent reservations */}
      <div style={{ background: "var(--color-background-primary)", border: "0.5px solid var(--color-border-tertiary)", borderRadius: 12, padding: "1rem 1.25rem" }}>
        <p style={{ margin: "0 0 14px", fontSize: 12, fontWeight: 500, color: "var(--color-text-secondary)" }}>Recently reserved</p>
        <div style={{ display: "flex", flexDirection: "column" }}>
          {recentReservations.map((r, i) => (
            <div key={r.id} style={{
              display: "grid",
              gridTemplateColumns: "1fr auto",
              alignItems: "start",
              gap: 12,
              padding: "10px 0",
              borderTop: i === 0 ? "none" : "0.5px solid var(--color-border-tertiary)",
            }}>
              <div>
                <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 3 }}>
                  <span style={{ fontSize: 13, fontWeight: 500 }}>{r.subnetName}</span>
                  <code style={{ fontSize: 11, color: "var(--color-text-tertiary)", background: "var(--color-background-secondary)", padding: "1px 6px", borderRadius: 4 }}>{r.subnetCidr}</code>
                  {r.vlan && (
                    <span style={{ fontSize: 11, color: "#185FA5", background: "#E6F1FB", padding: "1px 6px", borderRadius: 4 }}>VLAN {r.vlan}</span>
                  )}
                  {r.ipAddress && (
                    <span style={{ fontSize: 11, color: "#3B6D11", background: "#EAF3DE", padding: "1px 6px", borderRadius: 4 }}>{r.ipAddress}</span>
                  )}
                </div>
                {r.subnetPurpose && (
                  <p style={{ margin: "0 0 4px", fontSize: 12, color: "var(--color-text-tertiary)" }}>{r.subnetPurpose}</p>
                )}
                <div style={{ display: "flex", gap: 12, fontSize: 12, color: "var(--color-text-secondary)" }}>
                  <span>{r.owner}</span>
                  <span style={{ color: "var(--color-text-tertiary)" }}>·</span>
                  <span>{r.projectRef}</span>
                </div>
              </div>
              <span style={{ fontSize: 11, color: "var(--color-text-tertiary)", whiteSpace: "nowrap", paddingTop: 2 }}>{timeAgo(r.createdAt)}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
