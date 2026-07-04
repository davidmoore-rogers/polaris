-- API-token role cutover: replace the fixed scope-string list on ApiToken
-- with a Role binding. Each existing token's scope set is mapped onto a
-- seeded role whose permission matrix grants exactly what the scopes did:
--
--   assets:read       -> assets=read
--   dashboard:read    -> assets=read + events=read   (the NOC kiosk sections)
--   assets:quarantine -> assetsQuarantine=write
--
-- Combo scope sets get a union-matrix role. Seeded roles are plain custom
-- roles (not built-in, not protected) named api-<parts>; operators may edit
-- or replace them freely. A token whose scopes matched nothing (empty or
-- unknown) is bound to an api-no-access role — it keeps authenticating but
-- grants nothing, which matches its pre-cutover behavior.

ALTER TABLE "api_tokens" ADD COLUMN "role_id" TEXT;

DO $$
DECLARE
  tok RECORD;
  has_read BOOLEAN;
  has_dash BOOLEAN;
  has_quar BOOLEAN;
  rname TEXT;
  perms JSONB;
  rid TEXT;
BEGIN
  FOR tok IN SELECT "id", "scopes" FROM "api_tokens" LOOP
    has_read := 'assets:read' = ANY(tok."scopes");
    has_dash := 'dashboard:read' = ANY(tok."scopes");
    has_quar := 'assets:quarantine' = ANY(tok."scopes");

    perms := '{}'::jsonb;
    IF has_read OR has_dash THEN perms := perms || '{"assets":"read"}'::jsonb; END IF;
    IF has_dash THEN perms := perms || '{"events":"read"}'::jsonb; END IF;
    IF has_quar THEN perms := perms || '{"assetsQuarantine":"write"}'::jsonb; END IF;

    rname := 'api-' || concat_ws('-',
      CASE WHEN has_read THEN 'assets-read' END,
      CASE WHEN has_dash THEN 'noc' END,
      CASE WHEN has_quar THEN 'quarantine' END);
    IF rname = 'api-' THEN rname := 'api-no-access'; END IF;

    SELECT "id" INTO rid FROM "roles" WHERE "name" = rname;
    IF rid IS NULL THEN
      INSERT INTO "roles" ("id", "name", "description", "permissions", "is_built_in", "is_protected", "updatedAt")
      VALUES (
        gen_random_uuid()::text,
        rname,
        'Seeded by the API-token role cutover to match a legacy token scope set. Edit or replace freely.',
        perms,
        false,
        false,
        now()
      )
      RETURNING "id" INTO rid;
    END IF;

    UPDATE "api_tokens" SET "role_id" = rid WHERE "id" = tok."id";
  END LOOP;
END $$;

ALTER TABLE "api_tokens" ALTER COLUMN "role_id" SET NOT NULL;
ALTER TABLE "api_tokens"
  ADD CONSTRAINT "api_tokens_role_id_fkey"
  FOREIGN KEY ("role_id") REFERENCES "roles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE INDEX "api_tokens_role_id_idx" ON "api_tokens"("role_id");

ALTER TABLE "api_tokens" DROP COLUMN "scopes";
