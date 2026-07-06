/**
 * tests/unit/nginxConfigParser.test.ts
 *
 * Covers the bootstrap-only parser that reads /etc/nginx/conf.d/polaris.conf
 * and extracts the 6 user-settable directives. Round-trips through the
 * renderer to assert parse-render-parse stability.
 */

import { describe, expect, it } from "vitest";
import { parseNginxConfigText } from "../../src/services/nginxConfigParser.js";
import { renderNginxConfig } from "../../src/services/nginxRenderer.js";
import { defaultProxyConfig, type ProxyConfig } from "../../src/types/proxyConfig.js";

const ENV = { serverName: "polaris.example.com", polarisPort: 3000, dashPort: 3001 };

function cfg(overrides: Partial<ProxyConfig> = {}): ProxyConfig {
  return { ...defaultProxyConfig(), ...overrides };
}

describe("parseNginxConfigText — round-trip from renderer", () => {
  it("parses defaults out of a freshly-rendered config", () => {
    const { contents } = renderNginxConfig({ config: cfg(), ...ENV });
    const { config: parsed, drift } = parseNginxConfigText(contents);

    expect(drift).toEqual([]);
    expect(parsed.httpsPort).toBe(443);
    expect(parsed.http3Enabled).toBe(true);
    expect(parsed.tlsProtocols).toEqual(["TLSv1.2", "TLSv1.3"]);
    expect(parsed.hsts).toEqual({
      enabled: true,
      maxAgeSeconds: 31536000,
      includeSubDomains: true,
      preload: true,
    });
    expect(parsed.prometheusAllowIps).toEqual([]);
  });

  it("recovers a port change", () => {
    const { contents } = renderNginxConfig({ config: cfg({ httpsPort: 8443 }), ...ENV });
    const { config: parsed } = parseNginxConfigText(contents);
    expect(parsed.httpsPort).toBe(8443);
  });

  it("recovers http3=false", () => {
    const { contents } = renderNginxConfig({ config: cfg({ http3Enabled: false }), ...ENV });
    const { config: parsed } = parseNginxConfigText(contents);
    expect(parsed.http3Enabled).toBe(false);
  });

  it("recovers hsts=off", () => {
    const { contents } = renderNginxConfig({
      config: cfg({ hsts: { ...cfg().hsts, enabled: false } }),
      ...ENV,
    });
    const { config: parsed } = parseNginxConfigText(contents);
    expect(parsed.hsts.enabled).toBe(false);
  });

  it("recovers custom HSTS max-age + missing preload", () => {
    const { contents } = renderNginxConfig({
      config: cfg({
        hsts: { enabled: true, maxAgeSeconds: 7200, includeSubDomains: true, preload: false },
      }),
      ...ENV,
    });
    const { config: parsed } = parseNginxConfigText(contents);
    expect(parsed.hsts).toEqual({
      enabled: true,
      maxAgeSeconds: 7200,
      includeSubDomains: true,
      preload: false,
    });
  });

  it("recovers TLSv1.3-only", () => {
    const { contents } = renderNginxConfig({ config: cfg({ tlsProtocols: ["TLSv1.3"] }), ...ENV });
    const { config: parsed } = parseNginxConfigText(contents);
    expect(parsed.tlsProtocols).toEqual(["TLSv1.3"]);
  });

  it("recovers a multi-IP Prometheus allow-list", () => {
    const { contents } = renderNginxConfig({
      config: cfg({ prometheusAllowIps: ["10.0.0.42", "10.0.0.43"] }),
      ...ENV,
    });
    const { config: parsed } = parseNginxConfigText(contents);
    // Order may not match — the parser dedupes via Set.
    expect(parsed.prometheusAllowIps.sort()).toEqual(["10.0.0.42", "10.0.0.43"]);
  });
});

describe("parseNginxConfigText — drift detection", () => {
  it("flags an unknown proxy_pass target", () => {
    const { contents } = renderNginxConfig({ config: cfg(), ...ENV });
    const tampered = contents.replace(
      "proxy_pass http://127.0.0.1:9110/metrics;",
      "proxy_pass http://192.168.1.1:9999/api;"
    );
    const { drift } = parseNginxConfigText(tampered);
    expect(drift.some((d) => d.includes("unknown proxy_pass"))).toBe(true);
  });

  it("flags an unknown add_header line", () => {
    const { contents } = renderNginxConfig({ config: cfg(), ...ENV });
    const tampered = contents.replace(
      "server_name polaris.example.com;",
      "server_name polaris.example.com;\n  add_header X-Custom-Banner 'rogers' always;"
    );
    const { drift } = parseNginxConfigText(tampered);
    expect(drift.some((d) => d.includes("unknown add_header: X-Custom-Banner"))).toBe(true);
  });

  it("flags a location-block count mismatch", () => {
    const { contents } = renderNginxConfig({ config: cfg(), ...ENV });
    const tampered = contents.replace(
      "}\n",
      "}\n  location = /custom { proxy_pass http://127.0.0.1:3000; }\n",
    );
    const { drift } = parseNginxConfigText(tampered);
    expect(drift.some((d) => d.includes("location block count"))).toBe(true);
  });

  it("returns empty drift on an exact-shape rendered config", () => {
    const { contents } = renderNginxConfig({
      config: cfg({ prometheusAllowIps: ["10.0.0.42"] }),
      ...ENV,
    });
    const { drift } = parseNginxConfigText(contents);
    expect(drift).toEqual([]);
  });
});

describe("parseNginxConfigText — missing pieces", () => {
  it("flags a missing `listen <port> ssl` directive but still returns defaults", () => {
    const { config, drift } = parseNginxConfigText("server { listen 80; }");
    expect(config.httpsPort).toBe(443); // default
    expect(drift.some((d) => d.includes("listen <port> ssl"))).toBe(true);
  });

  it("treats absent http3/quic as http3=false", () => {
    const minimal = `server {
  listen 443 ssl;
  ssl_protocols TLSv1.2 TLSv1.3;
  location / { proxy_pass http://127.0.0.1:3000; }
  location = /dash { proxy_pass http://127.0.0.1:3001; }
  location /dash/ { proxy_pass http://127.0.0.1:3001; }
  location = /metrics { proxy_pass http://127.0.0.1:3000/metrics; }
  location = /metrics-monitor-1 { proxy_pass http://127.0.0.1:9101/metrics; }
  location = /metrics-monitor-2 { proxy_pass http://127.0.0.1:9102/metrics; }
  location = /metrics-discovery { proxy_pass http://127.0.0.1:9110/metrics; }
}`;
    const { config } = parseNginxConfigText(minimal);
    expect(config.http3Enabled).toBe(false);
  });

  it("reports drift on a pre-dash 5-location config (forces re-adoption after upgrade)", () => {
    const preDash = `server {
  listen 443 ssl;
  ssl_protocols TLSv1.2 TLSv1.3;
  location / { proxy_pass http://127.0.0.1:3000; }
  location = /metrics { proxy_pass http://127.0.0.1:3000/metrics; }
  location = /metrics-monitor-1 { proxy_pass http://127.0.0.1:9101/metrics; }
  location = /metrics-monitor-2 { proxy_pass http://127.0.0.1:9102/metrics; }
  location = /metrics-discovery { proxy_pass http://127.0.0.1:9110/metrics; }
}`;
    const { drift } = parseNginxConfigText(preDash);
    expect(drift.some((d) => d.includes("location block count is 5 (expected 7)"))).toBe(true);
  });

  it("defaults managedMode=false (bootstrap caller decides when to flip it)", () => {
    const { contents } = renderNginxConfig({ config: cfg(), ...ENV });
    const { config } = parseNginxConfigText(contents);
    expect(config.managedMode).toBe(false);
  });
});
