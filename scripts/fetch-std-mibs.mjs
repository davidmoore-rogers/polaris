#!/usr/bin/env node
/**
 * scripts/fetch-std-mibs.mjs — pull the seven canonical standard MIB
 * modules used by the SNMP Walk tab's browse tree, from the pysnmp.com
 * textual MIB mirror.
 *
 * The mirror tracks the IETF and IEEE source MIBs verbatim and exposes
 * them at stable URLs. Each module is written to src/services/stdMibs/
 * and a SHA-256 line is appended to SOURCES.md alongside the source URL.
 *
 * Re-run this script to refresh the bundle; existing files are
 * overwritten in place. Network access required.
 */
import { writeFileSync, readFileSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import https from "node:https";

const here = dirname(fileURLToPath(import.meta.url));
const outDir = join(here, "..", "src", "services", "stdMibs");

const MIBS = [
  { module: "SNMPv2-MIB",       stdKey: "std:system",          rootOid: "1.3.6.1.2.1.1",   description: "RFC 3418 — system group + sysObjectID/sysDescr/sysUpTime/sysContact/etc." },
  { module: "IF-MIB",           stdKey: "std:interfaces",      rootOid: "1.3.6.1.2.1.2",   description: "RFC 2863 — ifTable (legacy 32-bit counters) + ifXTable. Single file backs both std:interfaces and std:if-ext." },
  { module: "HOST-RESOURCES-MIB", stdKey: "std:host-resources", rootOid: "1.3.6.1.2.1.25", description: "RFC 2790 — hrStorageTable / hrProcessorTable / hrSWRunTable." },
  { module: "ENTITY-MIB",       stdKey: "std:entity",          rootOid: "1.3.6.1.2.1.47",  description: "RFC 4133 — entPhysicalTable hardware inventory." },
  { module: "ENTITY-SENSOR-MIB", stdKey: "std:entity-sensor",  rootOid: "1.3.6.1.2.1.99",  description: "RFC 3433 — entPhySensorTable temperature/voltage/etc." },
  { module: "LLDP-MIB",         stdKey: "std:lldp",            rootOid: "1.0.8802.1.1.2",  description: "IEEE 802.1AB — lldpLocPortTable / lldpRemTable / lldpRemManAddrTable. Re-read the IEEE license boilerplate before bundling updates." },
];

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
    "These seven canonical MIB modules back the SNMP Walk tab's browse tree for",
    "built-in MIBs (`std:system`, `std:interfaces`, `std:if-ext`, `std:host-resources`,",
    "`std:entity`, `std:entity-sensor`, `std:lldp`). They are loaded by",
    "[../stdMibLibrary.ts](../stdMibLibrary.ts) at first use.",
    "",
    "Re-pull via:",
    "",
    "```",
    "node scripts/fetch-std-mibs.mjs",
    "```",
    "",
    "Source mirror: <https://mibs.pysnmp.com/> (tracks IETF + IEEE upstreams).",
    "",
    "## Files",
    "",
    "| Module | std key | Root OID | Source URL | SHA-256 | Bytes |",
    "|---|---|---|---|---|---|",
  ];

  for (const m of MIBS) {
    const url = `https://mibs.pysnmp.com/asn1/${encodeURIComponent(m.module)}`;
    process.stdout.write(`Fetching ${m.module}… `);
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
