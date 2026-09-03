-- Operator-editable device-type matching.
--
-- Until now the inference layer -- which discovery-time facts land a device in
-- which type bucket -- was hardcoded in two places: `inferAssetTypeFromOs` in
-- discoveryEngine.ts (directory sources) and `assetTypeForHit` in
-- networkScanService.ts (Network Discovery). Neither was visible to an
-- operator, so a fleet full of PDUs, cameras and controllers landed in `other`
-- with no way to teach Polaris otherwise short of a code change.
--
-- The rules move onto the registry row that owns the bucket. Built-in rows
-- take rules too: `is_protected` locks IDENTITY (name + label), which code
-- branches on, not the matching that fills the bucket.
--
-- The seeds below reproduce the pre-existing hardcoded behavior EXACTLY, so
-- this migration is a no-op for every install until an operator edits a rule.
-- `match_contexts` is per-type for that reason: server/workstation were
-- directory-only and firewall/switch/access_point/router/printer were
-- scan-only, and collapsing them into one set would have silently started
-- typing AD computers "printer" off their OS string.

ALTER TABLE "asset_type_defs"
  ADD COLUMN "match_rules"    JSONB,
  ADD COLUMN "match_contexts" TEXT[]  NOT NULL DEFAULT ARRAY[]::TEXT[],
  ADD COLUMN "match_priority" INTEGER NOT NULL DEFAULT 100;

-- ── Directory inference (was inferAssetTypeFromOs) ─────────────────────────
-- Order is load-bearing: `server` was tested before `workstation`, so a
-- "Windows Server 2019" box matches server and never reaches the
-- windows-10/11 branch.

UPDATE "asset_type_defs" SET
  "match_contexts" = ARRAY['directory'],
  "match_priority" = 20,
  "match_rules" = '{"clauses":[
    {"field":"os","op":"contains","value":"server"},
    {"field":"os","op":"contains","value":"centos"},
    {"field":"os","op":"contains","value":"red hat"},
    {"field":"os","op":"contains","value":"rhel"},
    {"field":"os","op":"contains","value":"rocky linux"},
    {"field":"os","op":"contains","value":"almalinux"},
    {"field":"os","op":"contains","value":"oracle linux"},
    {"field":"os","op":"contains","value":"freebsd"},
    {"field":"os","op":"contains","value":"openbsd"},
    {"field":"os","op":"contains","value":"netbsd"},
    {"field":"os","op":"contains","value":"esxi"},
    {"field":"os","op":"contains","value":"vmware"}
  ]}'::jsonb
WHERE "name" = 'server';

UPDATE "asset_type_defs" SET
  "match_contexts" = ARRAY['directory'],
  "match_priority" = 30,
  "match_rules" = '{"clauses":[
    {"field":"os","op":"regex","value":"windows\\s+(10|11|7|8|xp|vista)"},
    {"field":"os","op":"contains","value":"macos"},
    {"field":"os","op":"contains","value":"mac os x"},
    {"field":"os","op":"contains","value":"os x"},
    {"field":"os","op":"contains","value":"linux mint"},
    {"field":"os","op":"contains","value":"ubuntu"},
    {"field":"os","op":"contains","value":"fedora"},
    {"field":"os","op":"contains","value":"debian"},
    {"field":"os","op":"contains","value":"arch linux"},
    {"field":"os","op":"contains","value":"manjaro"},
    {"field":"os","op":"contains","value":"pop!_os"},
    {"field":"os","op":"contains","value":"elementary os"},
    {"field":"os","op":"contains","value":"zorin os"}
  ]}'::jsonb
WHERE "name" = 'workstation';

-- ── Network Discovery inference (was assetTypeForHit) ──────────────────────
-- Matched against the space-joined identity (`os` + `hostname`), which is what
-- the `any` field means. Priorities preserve the original if-ladder order.
-- The router pattern's second alternative (`\bios\b.*\brouter\b`) is dropped:
-- it can only match where `\brouter\b` already did.

UPDATE "asset_type_defs" SET
  "match_contexts" = ARRAY['scan'],
  "match_priority" = 10,
  "match_rules" = '{"clauses":[
    {"field":"any","op":"regex","value":"\\b(fortigate|firewall|palo alto|sonicwall)\\b"}
  ]}'::jsonb
WHERE "name" = 'firewall';

UPDATE "asset_type_defs" SET
  "match_contexts" = ARRAY['scan'],
  "match_priority" = 12,
  "match_rules" = '{"clauses":[
    {"field":"any","op":"regex","value":"\\b(fortiswitch|switch|catalyst|nexus)\\b"}
  ]}'::jsonb
WHERE "name" = 'switch';

UPDATE "asset_type_defs" SET
  "match_contexts" = ARRAY['scan'],
  "match_priority" = 14,
  "match_rules" = '{"clauses":[
    {"field":"any","op":"regex","value":"\\bfortiap\\b|access point|\\bwlan\\b|\\bwireless\\b"}
  ]}'::jsonb
WHERE "name" = 'access_point';

UPDATE "asset_type_defs" SET
  "match_contexts" = ARRAY['scan'],
  "match_priority" = 16,
  "match_rules" = '{"clauses":[
    {"field":"any","op":"regex","value":"\\brouter\\b"}
  ]}'::jsonb
WHERE "name" = 'router';

UPDATE "asset_type_defs" SET
  "match_contexts" = ARRAY['scan'],
  "match_priority" = 18,
  "match_rules" = '{"clauses":[
    {"field":"any","op":"regex","value":"\\bprinter\\b|laserjet|officejet"}
  ]}'::jsonb
WHERE "name" = 'printer';
