#!/usr/bin/env node
/**
 * scripts/fetch-std-mibs.mjs — pull the eleven canonical standard MIB
 * modules used by the SNMP Walk tab's browse tree.
 *
 * Each module is written to src/services/stdMibs/ and a SHA-256 line is
 * appended to SOURCES.md alongside the source URL it actually came from.
 *
 * Two mirrors, tracked per module in `mirror`:
 *   pysnmp   — https://mibs.pysnmp.com/asn1/<MODULE>   (the original source
 *              for the first seven modules; tracks IETF + IEEE upstreams)
 *   netdisco — the netdisco-mibs `rfc/` tree, used for the four modules added
 *              in the switch physical-layer work (POWER-ETHERNET / BRIDGE /
 *              Q-BRIDGE / RSTP) because the pysnmp mirror was returning
 *              HTTP 522 at the time. Each of those four was verified after
 *              download: correct `<NAME> DEFINITIONS ::= BEGIN` envelope, an
 *              RFC reference and LAST-UPDATED matching the published RFC
 *              (3621 / 4188 / 4363 / 4318), IETF Trust copyright present, and
 *              — the real check — every symbol resolving to its canonical
 *              OID through scripts/smoke-std-mibs.ts.
 *
 * Re-run this script to refresh the bundle; existing files are overwritten in
 * place. Network access required. If a mirror is down, prefer fixing the URL
 * over silently swapping sources — the SHA-256 in SOURCES.md is what makes a
 * substituted file detectable.
 */
import { writeFileSync, readFileSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import https from "node:https";

const here = dirname(fileURLToPath(import.meta.url));
const outDir = join(here, "..", "src", "services", "stdMibs");

const MIBS = [
  { module: "SNMPv2-MIB",       stdKey: "std:system",          mirror: "pysnmp",   rootOid: "1.3.6.1.2.1.1",   description: "RFC 3418 — system group + sysObjectID/sysDescr/sysUpTime/sysContact/etc." },
  { module: "IF-MIB",           stdKey: "std:interfaces",      mirror: "pysnmp",   rootOid: "1.3.6.1.2.1.2",   description: "RFC 2863 — ifTable (legacy 32-bit counters) + ifXTable. Single file backs both std:interfaces and std:if-ext." },
  { module: "HOST-RESOURCES-MIB", stdKey: "std:host-resources", mirror: "pysnmp",  rootOid: "1.3.6.1.2.1.25", description: "RFC 2790 — hrStorageTable / hrProcessorTable / hrSWRunTable." },
  { module: "ENTITY-MIB",       stdKey: "std:entity",          mirror: "pysnmp",   rootOid: "1.3.6.1.2.1.47",  description: "RFC 4133 — entPhysicalTable hardware inventory." },
  { module: "ENTITY-SENSOR-MIB", stdKey: "std:entity-sensor",  mirror: "pysnmp",   rootOid: "1.3.6.1.2.1.99",  description: "RFC 3433 — entPhySensorTable temperature/voltage/etc." },
  { module: "LLDP-MIB",         stdKey: "std:lldp",            mirror: "pysnmp",   rootOid: "1.0.8802.1.1.2",  description: "IEEE 802.1AB — lldpLocPortTable / lldpRemTable / lldpRemManAddrTable. Re-read the IEEE license boilerplate before bundling updates." },
  { module: "POWER-ETHERNET-MIB", stdKey: "std:poe",           mirror: "netdisco", rootOid: "1.3.6.1.2.1.105", description: "RFC 3621 — pethPsePortTable (per-port PoE detection status + power class) / pethMainPseTable (per-PSE consumption watts). No per-port wattage object exists in this MIB." },
  { module: "BRIDGE-MIB",       stdKey: "std:bridge",          mirror: "netdisco", rootOid: "1.3.6.1.2.1.17",  description: "RFC 4188 — dot1dTpFdbTable (MAC forwarding), dot1dBasePortIfIndex (the basePort→ifIndex join), dot1dStp (spanning tree). Q-BRIDGE-MIB and RSTP-MIB both anchor on symbols from here." },
  { module: "Q-BRIDGE-MIB",     stdKey: "std:q-bridge",        mirror: "netdisco", rootOid: "1.3.6.1.2.1.17.7", description: "RFC 4363 — dot1qTpFdbTable, the VLAN-aware forwarding database a VLAN-aware switch populates instead of dot1dTpFdbTable." },
  { module: "RSTP-MIB",         stdKey: "std:rstp",            mirror: "netdisco", rootOid: "1.3.6.1.2.1.134", description: "RFC 4318 — dot1dStpExtPortTable (oper edge-port / point-to-point / protocol migration), the RSTP complement to BRIDGE-MIB's dot1dStp." },
];

/** Where each mirror serves a module's ASN.1 text. */
const MIRRORS = {
  pysnmp:   (m) => `https://mibs.pysnmp.com/asn1/${encodeURIComponent(m)}`,
  netdisco: (m) => `https://raw.githubusercontent.com/netdisco/netdisco-mibs/master/rfc/${encodeURIComponent(m)}.txt`,
};

function fetch(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { "User-Agent": "polaris-mib-fetch/1.0" } }, (res) => {
      if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return fetch(res.headers.location).then(resolve, reject);
      }
      if (res.statusCode !== 200) {
        return reject(new Error(`${url} → HTTP ${res.statusCode}`));
      }
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
      res.on("error", reject);
    }).on("error", reject);
  });
}

function sha256(text) {
  return createHash("sha256").update(text, "utf-8").digest("hex");
}

async function main() {
  const sourcesLines = [
    "# Standard MIB sources",
    "",
    "These canonical MIB modules back the SNMP Walk tab's browse tree for",
    "built-in MIBs (`std:system`, `std:interfaces`, `std:if-ext`, `std:host-resources`,",
    "`std:entity`, `std:entity-sensor`, `std:lldp`, `std:poe`, `std:bridge`,",
    "`std:q-bridge`, `std:rstp`). They are loaded by",
    "[../stdMibLibrary.ts](../stdMibLibrary.ts) at first use.",
    "",
    "Re-pull via:",
    "",
    "```",
    "node scripts/fetch-std-mibs.mjs",
    "```",
    "",
    "Source mirrors (per-module, see the `mirror` field in the fetch script):",
    "",
    "- <https://mibs.pysnmp.com/> — tracks IETF + IEEE upstreams.",
    "- <https://github.com/netdisco/netdisco-mibs> (`rfc/` tree) — used for the four",
    "  switch physical-layer modules, whose download from pysnmp was returning HTTP 522.",
    "  Each was verified post-download against its published RFC (envelope, RFC",
    "  reference, LAST-UPDATED, IETF Trust copyright) and, decisively, by every symbol",
    "  resolving to its canonical OID via `scripts/smoke-std-mibs.ts`.",
    "",
    "## Files",
    "",
    "| Module | std key | Root OID | Source URL | SHA-256 | Bytes |",
    "|---|---|---|---|---|---|",
  ];

  for (const m of MIBS) {
    const buildUrl = MIRRORS[m.mirror];
    if (!buildUrl) throw new Error(`${m.module}: unknown mirror "${m.mirror}"`);
    const url = buildUrl(m.module);
    process.stdout.write(`Fetching ${m.module} (${m.mirror})… `);
    const text = await fetch(url);
    const filename = `${m.module}.txt`;
    const outPath = join(outDir, filename);
    writeFileSync(outPath, text, "utf-8");
    const hash = sha256(text);
    const bytes = Buffer.byteLength(text, "utf-8");
    sourcesLines.push(`| \`${m.module}\` | \`${m.stdKey}\` | \`${m.rootOid}\` | <${url}> | \`${hash}\` | ${bytes} |`);
    console.log(`${bytes} bytes, ${hash.slice(0, 12)}…`);
  }

  sourcesLines.push("");
  sourcesLines.push("## Licensing");
  sourcesLines.push("");
  sourcesLines.push("- **IETF RFC-derived MIBs** (SNMPv2-MIB, IF-MIB, HOST-RESOURCES-MIB, ENTITY-MIB,");
  sourcesLines.push("  ENTITY-SENSOR-MIB) carry the IETF Trust legal provisions — permissive, allows");
  sourcesLines.push("  bundling and redistribution.");
  sourcesLines.push("- **LLDP-MIB** (IEEE 802.1AB) carries an IEEE-specific copyright header. IEEE");
  sourcesLines.push("  historically allows reproduction of standalone MIB modules; the boilerplate is");
  sourcesLines.push("  preserved in the file. Re-read the in-file header on every refresh and have a");
  sourcesLines.push("  human verify before committing significant version changes.");
  sourcesLines.push("");

  writeFileSync(join(outDir, "SOURCES.md"), sourcesLines.join("\n"), "utf-8");
  console.log(`\nWrote ${MIBS.length} MIB files + SOURCES.md to ${outDir}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
