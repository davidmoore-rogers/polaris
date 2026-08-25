-- Trigram indexes for the address book's server-side search.
--
-- `GET /contacts?q=` and the recipient typeahead both resolve their contacts
-- half with `ILIKE '%q%'` on email and name. Substring matching cannot use a
-- btree index, so without these every keystroke is a sequential scan of the
-- whole table. That was survivable while the address book was hand-curated and
-- tens of rows deep; it is not once a bulk source can grow the table to the
-- size of the company.
--
-- Indexed on `lower(...)` because the query lower-cases both sides (email is
-- stored lower-cased already; name is not), matching the shape Prisma's
-- `mode: "insensitive"` emits. Same pattern as the 20260507200000 search
-- indexes, which already create the extension -- repeated here with IF NOT
-- EXISTS so this migration stands alone on a database restored from a dump
-- that predates it.
CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE INDEX IF NOT EXISTS "contacts_email_trgm"
  ON contacts USING gin (lower(email) gin_trgm_ops);

-- name is nullable; a NULL simply produces no index entry, and a row with no
-- name is unreachable by a name search either way.
CREATE INDEX IF NOT EXISTS "contacts_name_trgm"
  ON contacts USING gin (lower(name) gin_trgm_ops);
