/**
 * src/services/mibService.ts — SNMP MIB module storage + validation.
 *
 * Uploaded MIB files are stored inline in the database. Each upload is run
 * through a minimal SMI parser that:
 *   1. Verifies the file is printable text (rejects binaries / executables).
 *   2. Extracts the ASN.1 module name from `<NAME> DEFINITIONS ::= BEGIN`.
 *   3. Extracts every module referenced in the `IMPORTS ... FROM <X>` block,
 *      so the UI can warn when a dependency is missing.
 *   4. Confirms the file ends in `END` (ASN.1 module terminator).
 *
 * Anything that fails these checks is rejected — this is what gates the
 * upload form against arbitrary text or attempts to smuggle code in.
 */
import { prisma } from "../db.js";
import { AppError } from "../utils/errors.js";

const MAX_BYTES = 1024 * 1024; // 1 MB — MIBs are normally <100 KB

export interface ParsedMib {
  moduleName: string;
  imports: string[];
  cleanText: string; // contents with the BOM stripped, otherwise unchanged
}

// Strip ASN.1 comments. SMI (RFC 2578) supports two comment styles:
//   1. `-- ... <newline>` or `-- ... --` (the second `--` closes it)
//   2. line that begins with `--`
// We collapse comments to whitespace rather than dropping them so that line
// numbers in any later parser error message still line up with the source.
function stripComments(text: string): string {
  let out = "";
  let i = 0;
  const n = text.length;
  while (i < n) {
    const ch = text[i];
    // String literal — don't strip "--" inside a quoted DESCRIPTION
    if (ch === '"') {
      out += ch;
      i++;
      while (i < n && text[i] !== '"') {
        out += text[i];
        i++;
      }
      if (i < n) {
        out += text[i];
        i++;
      }
      continue;
    }
    if (ch === "-" && text[i + 1] === "-") {
      // Replace with a space, then scan to either end-of-line or the next "--"
      out += "  ";
      i += 2;
      while (i < n) {
        if (text[i] === "\n" || text[i] === "\r") break;
        if (text[i] === "-" && text[i + 1] === "-") {
          out += "  ";
          i += 2;
          break;
        }
        out += text[i] === "\t" ? "\t" : " ";
        i++;
      }
      continue;
    }
    out += ch;
    i++;
  }
  return out;
}

/**
 * Parse + validate a MIB. Throws AppError(400) on anything that doesn't
 * look like a real SMI module.
 */
export function parseMib(raw: string): ParsedMib {
  // BOM strip — some Windows-saved MIBs ship with a UTF-8 BOM
  let text = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;

  if (text.length === 0) throw new AppError(400, "MIB file is empty");
  if (text.length > MAX_BYTES) {
    throw new AppError(400, `MIB file exceeds ${MAX_BYTES} bytes`);
  }

  // Reject anything containing NUL bytes or other non-text control chars.
  // ASCII tab/CR/LF are fine; everything else <0x20 (except 0x7F) is suspicious.
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code === 0x09 || code === 0x0a || code === 0x0d) continue;
    if (code < 0x20 || code === 0x7f) {
      throw new AppError(
        400,
        "MIB file contains binary or control characters — only plain ASN.1/SMI text is accepted",
      );
    }
  }

  const stripped = stripComments(text);

  // Module declaration: `<MODULE-NAME> DEFINITIONS ::= BEGIN`
  // Module name is uppercase letters, digits, and hyphens (SMI rules).
  const headMatch = stripped.match(/([A-Z][A-Z0-9-]*)\s+DEFINITIONS(?:\s+[A-Z-]+)*\s*::=\s*BEGIN/);
  if (!headMatch) {
    throw new AppError(
      400,
      "MIB file is missing the `<NAME> DEFINITIONS ::= BEGIN` header — not a valid SMI module",
    );
  }
  const moduleName = headMatch[1];

  // Module must end with `END` token
  if (!/\bEND\s*$/.test(stripped.trim())) {
    throw new AppError(400, "MIB file does not end with the `END` token — file may be truncated");
  }

  // Imports — capture every `FROM <MODULE-NAME>` inside the IMPORTS block.
  // The IMPORTS block is optional but if present it terminates with `;`.
  const imports: string[] = [];
  const importsMatch = stripped.match(/\bIMPORTS\b([\s\S]*?);/);
  if (importsMatch) {
    const seen = new Set<string>();
    const re = /\bFROM\s+([A-Z][A-Z0-9-]*)/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(importsMatch[1]))) {
      if (!seen.has(m[1])) {
        seen.add(m[1]);
        imports.push(m[1]);
      }
    }
  }

  return { moduleName, imports, cleanText: text };
}

// ─── CRUD ──────────────────────────────────────────────────────────────────

export interface MibSummary {
  id: string;
  filename: string;
  moduleName: string;
  manufacturer: string | null;
  model: string | null;
  imports: string[];
  size: number;
  notes: string | null;
  uploadedBy: string | null;
  uploadedAt: Date;
}

export interface MibFilter {
  manufacturer?: string | null; // null = generic only; undefined = no filter
  model?: string | null;
  scope?: "all" | "device" | "generic";
}

export async function listMibs(filter: MibFilter = {}): Promise<MibSummary[]> {
  const where: Record<string, unknown> = {};
  if (filter.scope === "generic") where.manufacturer = null;
  if (filter.scope === "device") where.manufacturer = { not: null };
  if (filter.manufacturer !== undefined && filter.scope !== "generic") {
    where.manufacturer = filter.manufacturer === null ? null : { equals: filter.manufacturer, mode: "insensitive" };
  }
  if (filter.model !== undefined) {
    where.model = filter.model === null ? null : { equals: filter.model, mode: "insensitive" };
  }

  const rows = await prisma.mibFile.findMany({
    where,
    orderBy: [{ manufacturer: "asc" }, { model: "asc" }, { moduleName: "asc" }],
    select: {
      id: true,
      filename: true,
      moduleName: true,
      manufacturer: true,
      model: true,
      imports: true,
      size: true,
      notes: true,
      uploadedBy: true,
      uploadedAt: true,
    },
  });
  return rows;
}

export async function getMib(id: string): Promise<{
  id: string;
  filename: string;
  moduleName: string;
  manufacturer: string | null;
  model: string | null;
  contents: string;
  imports: string[];
  size: number;
  notes: string | null;
  uploadedBy: string | null;
  uploadedAt: Date;
}> {
  const row = await prisma.mibFile.findUnique({ where: { id } });
  if (!row) throw new AppError(404, "MIB not found");
  return row;
}

export interface CreateMibInput {
  filename: string;
  contents: string;
  manufacturer?: string | null;
  model?: string | null;
  notes?: string | null;
  uploadedBy?: string | null;
}

export async function createMib(input: CreateMibInput): Promise<MibSummary> {
  const filename = (input.filename || "").trim();
  if (!filename) throw new AppError(400, "filename is required");

  const manufacturer = input.manufacturer?.trim() || null;
  const model = input.model?.trim() || null;
  if (!manufacturer && model) {
    throw new AppError(400, "model cannot be set without a manufacturer (generic MIBs apply to all devices)");
  }

  const parsed = parseMib(input.contents);

  // Reject duplicate (manufacturer, model, moduleName) — Postgres uniqueness
  // treats NULLs as distinct so we still need to check generic MIBs by hand.
  const existing = await prisma.mibFile.findFirst({
    where: {
      manufacturer,
      model,
      moduleName: parsed.moduleName,
    },
    select: { id: true },
  });
  if (existing) {
    throw new AppError(
      409,
      `A MIB module named "${parsed.moduleName}" is already uploaded for this manufacturer/model — delete the existing one first`,
    );
  }

  const created = await prisma.mibFile.create({
    data: {
      filename,
      moduleName: parsed.moduleName,
      manufacturer,
      model,
      contents: parsed.cleanText,
      imports: parsed.imports,
      size: parsed.cleanText.length,
      notes: input.notes?.trim() || null,
      uploadedBy: input.uploadedBy || null,
    },
    select: {
      id: true,
      filename: true,
      moduleName: true,
      manufacturer: true,
      model: true,
      imports: true,
      size: true,
      notes: true,
      uploadedBy: true,
      uploadedAt: true,
    },
  });
  return created;
}

export async function deleteMib(id: string): Promise<void> {
  try {
    await prisma.mibFile.delete({ where: { id } });
  } catch {
    throw new AppError(404, "MIB not found");
  }
}

/**
 * Manufacturer + per-manufacturer model facets, used to seed the upload form
 * dropdowns. Combines distinct values from already-uploaded MIBs with distinct
 * values from the asset inventory so the picker isn't empty before the first
 * MIB is uploaded.
 */
export async function getMibFacets(): Promise<{
  manufacturers: string[];
  modelsByManufacturer: Record<string, string[]>;
}> {
  const [mibRows, assetRows] = await Promise.all([
    prisma.mibFile.findMany({
      where: { manufacturer: { not: null } },
      select: { manufacturer: true, model: true },
      distinct: ["manufacturer", "model"],
    }),
    prisma.asset.findMany({
      where: { manufacturer: { not: null } },
      select: { manufacturer: true, model: true },
      distinct: ["manufacturer", "model"],
    }),
  ]);

  const manufacturers = new Set<string>();
  const models: Record<string, Set<string>> = {};

  for (const r of [...mibRows, ...assetRows]) {
    const m = r.manufacturer?.trim();
    if (!m) continue;
    manufacturers.add(m);
    if (!models[m]) models[m] = new Set();
    if (r.model && r.model.trim()) models[m].add(r.model.trim());
  }

  const modelsByManufacturer: Record<string, string[]> = {};
  for (const m of Object.keys(models)) {
    modelsByManufacturer[m] = Array.from(models[m]).sort();
  }

  return {
    manufacturers: Array.from(manufacturers).sort(),
    modelsByManufacturer,
  };
}
