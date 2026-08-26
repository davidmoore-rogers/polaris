-- Address-book directory (GAL) sync — schema half. See business rule 35.
--
-- 1. contacts gains provenance (`origin`) + the directory-sourced identity
--    fields a picker needs to tell two people apart.
-- 2. directory_contact_sources records, per (integration, directory object),
--    which Contact rows the SYNC created — so a reconcile deletes only what it
--    wrote and a hand-added row survives forever.
--
-- Both are inert until an integration opts in: `origin` defaults to 'manual',
-- which is exactly what every existing row is.

-- ─── contacts ───────────────────────────────────────────────────────────────

-- WHO owns this row: 'manual' | 'entra' | 'ad'. Denormalized from
-- directory_contact_sources so the visibility gate and the alert fire-time load
-- are one indexed WHERE rather than a join. NOT NULL with a default, so every
-- pre-existing row is correctly claimed as operator-owned without a backfill.
ALTER TABLE "contacts" ADD COLUMN "origin" TEXT NOT NULL DEFAULT 'manual';

-- 'person' | 'group' — a mail-enabled distribution list is not a person.
ALTER TABLE "contacts" ADD COLUMN "kind" TEXT NOT NULL DEFAULT 'person';

-- Directory-sourced identity. Employee PII at rest: it rides every pg_dump this
-- install produces, including the off-host backup copies. It must never reach
-- Event.details or the logs, which are readable by anyone holding events access
-- and are shipped off-host by the syslog (CEF) and SFTP archivers.
ALTER TABLE "contacts" ADD COLUMN "jobTitle"   TEXT;
ALTER TABLE "contacts" ADD COLUMN "department" TEXT;
ALTER TABLE "contacts" ADD COLUMN "phone"      TEXT;

-- The visibility gate ("show me only the rows an operator curated") and the
-- sync's own reconcile both filter on this, on a table a bulk source can grow
-- to the size of the company.
CREATE INDEX "contacts_origin_idx" ON "contacts"("origin");

-- ─── directory_contact_sources ──────────────────────────────────────────────

-- One row per (integration, directory object) the sync created. A person
-- present in BOTH AD and Entra owns ONE contact with TWO of these; the contact
-- is deleted only when its LAST source row goes.
--
-- `observed` is the per-source field blob. The contact row is PROJECTED from
-- the set rather than last-writer-wins, so two directories that disagree cannot
-- ping-pong it on alternating runs — the AssetSource / projectAssetFromSources
-- shape, at contact scale.
CREATE TABLE "directory_contact_sources" (
  "integrationId" TEXT NOT NULL,
  "externalId"    TEXT NOT NULL,
  "sourceKind"    TEXT NOT NULL,
  "contactId"     TEXT NOT NULL,
  "observed"      JSONB NOT NULL,
  "firstSeenAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "lastSeenAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "directory_contact_sources_pkey" PRIMARY KEY ("integrationId", "externalId")
);

-- Deleting the contact takes its provenance with it; that direction is safe
-- because a contact with no rows left is precisely a contact nothing claims.
ALTER TABLE "directory_contact_sources"
  ADD CONSTRAINT "directory_contact_sources_contactId_fkey"
  FOREIGN KEY ("contactId") REFERENCES "contacts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Deliberately NO foreign key on integrationId. A cascade from integrations
-- would strip the provenance while leaving the contact rows it justified in
-- place — which is exactly the state in which the sync can no longer tell its
-- own rows from an operator's, so it could neither refresh nor remove them.
-- Integration delete and the sync-disable toggle call purgeDirectoryContacts
-- explicitly instead, which removes both halves in the right order.

-- "which contact does this source feed" (the projection) and "everything this
-- integration owns" (the reconcile + the purge).
CREATE INDEX "directory_contact_sources_contactId_idx" ON "directory_contact_sources"("contactId");
CREATE INDEX "directory_contact_sources_integrationId_idx" ON "directory_contact_sources"("integrationId");
