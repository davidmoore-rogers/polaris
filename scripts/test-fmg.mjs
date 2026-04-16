#!/usr/bin/env node
/**
 * scripts/test-fmg.mjs — Test FortiManager JSON RPC API connection from terminal
 *
 * Usage:
 *   node scripts/test-fmg.mjs --host <host> --user <api-user> --token <api-token> [options]
 *
 * Options:
 *   --host      FortiManager hostname or IP (required)
 *   --user      API user name (required)
 *   --token     Bearer API token (required)
 *   --port      Port (default: 443)
 *   --adom      ADOM name (default: root)
 *   --no-verify Skip SSL certificate verification
 */

import { request as httpsRequest } from "node:https";

// ─── Parse args ─────────────────────────────────────────────────────────────

const args = process.argv.slice(2);

function getArg(name) {
  const i = args.indexOf("--" + name);
  return i !== -1 && i + 1 < args.length ? args[i + 1] : undefined;
}

const host = getArg("host");
const user = getArg("user");
const token = getArg("token");
const port = parseInt(getArg("port") || "443", 10);
const adom = getArg("adom") || "root";
const verifySsl = !args.includes("--no-verify");

if (!host || !user || !token) {
  console.error("");
  console.error("  Usage: node scripts/test-fmg.mjs --host <host> --user <api-user> --token <api-token> [options]");
  console.error("");
  console.error("  Options:");
  console.error("    --host        FortiManager hostname or IP (required)");
  console.error("    --user        API user name (required)");
  console.error("    --token       Bearer API token (required)");
  console.error("    --port        Port (default: 443)");
  console.error("    --adom        ADOM name (default: root)");
  console.error("    --no-verify   Skip SSL certificate verification");
  console.error("");
  process.exit(1);
}

// ─── RPC helper ─────────────────────────────────────────────────────────────

function rpc(method, params) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify({ id: 1, method, params });

    const opts = {
      hostname: host,
      port,
      path: "/jsonrpc",
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(payload),
        "Authorization": `Bearer ${token}`,
        "access_user": user,
      },
      rejectUnauthorized: verifySsl,
      timeout: 10000,
    };

    const req = httpsRequest(opts, (res) => {
      let body = "";
      res.on("data", (chunk) => (body += chunk));
      res.on("end", () => {
        if (res.statusCode === 401 || res.statusCode === 403) {
          return reject(new Error("Authentication failed — check your API token"));
        }
        if (res.statusCode < 200 || res.statusCode >= 300) {
          return reject(new Error(`HTTP ${res.statusCode}: ${body.slice(0, 200)}`));
        }
        try {
          resolve(JSON.parse(body));
        } catch {
          reject(new Error("Invalid JSON response"));
        }
      });
    });

    req.on("timeout", () => { req.destroy(); reject(new Error("Connection timed out")); });
    req.on("error", (err) => reject(err));
    req.write(payload);
    req.end();
  });
}

// ─── Run tests ──────────────────────────────────────────────────────────────

console.log("");
console.log(`  FortiManager: ${host}:${port}`);
console.log(`  API User:     ${user}`);
console.log(`  ADOM:         ${adom}`);
console.log(`  SSL Verify:   ${verifySsl}`);
console.log("");

try {
  // 1. System status
  process.stdout.write("  [1/3] Getting system status...  ");
  const statusRes = await rpc("get", [{ url: "/sys/status" }]);
  const statusCode = statusRes.result?.[0]?.status?.code;
  if (statusCode !== 0) {
    const msg = statusRes.result?.[0]?.status?.message || "Unknown error";
    console.log("\x1b[31mFAIL\x1b[0m");
    console.error(`        ${msg}`);
    process.exit(1);
  }
  const sysData = statusRes.result[0].data || {};
  console.log("\x1b[32mOK\x1b[0m");
  console.log(`        Version:   ${sysData.Version || "unknown"}`);
  console.log(`        Hostname:  ${sysData["Hostname"] || sysData["Admin Domain Configuration"]?.hostname || "unknown"}`);
  console.log(`        Serial:    ${sysData["Serial Number"] || "unknown"}`);

  // 2. List ADOM
  process.stdout.write(`  [2/3] Checking ADOM "${adom}"...  `);
  const adomRes = await rpc("get", [{ url: `/dvmdb/adom/${adom}` }]);
  const adomCode = adomRes.result?.[0]?.status?.code;
  if (adomCode !== 0) {
    console.log("\x1b[33mWARN\x1b[0m");
    console.log(`        ADOM "${adom}" not found or not accessible`);
  } else {
    console.log("\x1b[32mOK\x1b[0m");
  }

  // 3. List DHCP servers in ADOM
  process.stdout.write("  [3/3] Querying DHCP servers...  ");
  const dhcpRes = await rpc("get", [{ url: `/pm/config/adom/${adom}/obj/system/dhcp/server`, option: ["count"] }]);
  const dhcpCode = dhcpRes.result?.[0]?.status?.code;
  if (dhcpCode !== 0) {
    console.log("\x1b[33mWARN\x1b[0m");
    console.log(`        Could not query DHCP servers (${dhcpRes.result?.[0]?.status?.message || "unknown error"})`);
  } else {
    const dhcpData = dhcpRes.result[0].data;
    const count = typeof dhcpData === "number" ? dhcpData : Array.isArray(dhcpData) ? dhcpData.length : "unknown";
    console.log("\x1b[32mOK\x1b[0m");
    console.log(`        DHCP servers found: ${count}`);
  }

  console.log("");
  console.log("  \x1b[32m✓ All checks passed\x1b[0m");
  console.log("");
} catch (err) {
  console.log("\x1b[31mFAIL\x1b[0m");
  console.error("");
  if (err.code === "ECONNREFUSED") {
    console.error(`  ✗ Connection refused — ${host}:${port}`);
  } else if (err.code === "ENOTFOUND") {
    console.error(`  ✗ Host not found — ${host}`);
  } else if (err.code === "ETIMEDOUT" || err.message === "Connection timed out") {
    console.error(`  ✗ Connection timed out — ${host}:${port}`);
  } else {
    console.error(`  ✗ ${err.message}`);
  }
  console.error("");
  process.exit(1);
}
