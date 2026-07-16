-- Shared Device Map topology layouts: one row per (site, view) holding the
-- hand-tuned node positions ({ nodeId: {x,y} } pixel model coords) that were
-- previously only persisted per-browser in localStorage. siteId is the
-- FortiGate Asset id (topology root); view is "flat" or a floor-view key
-- ("b|<area>|<building>" / "f|<area>|<building>|<floor>"). Cascades away with
-- the site asset. Written by topologyLayoutService (PUT gated deviceMap=write);
-- read by everyone via the savedLayouts embed on GET /map/sites/:id/topology.
CREATE TABLE "topology_layouts" (
    "id" TEXT NOT NULL,
    "site_id" TEXT NOT NULL,
    "view" TEXT NOT NULL DEFAULT 'flat',
    "positions" JSONB NOT NULL,
    "updated_by" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "topology_layouts_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "topology_layouts_site_id_view_key" ON "topology_layouts"("site_id", "view");

ALTER TABLE "topology_layouts" ADD CONSTRAINT "topology_layouts_site_id_fkey" FOREIGN KEY ("site_id") REFERENCES "assets"("id") ON DELETE CASCADE ON UPDATE CASCADE;
