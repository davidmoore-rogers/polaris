-- Asset.monitoredStorage: hrStorage mountPaths pinned for fast-cadence polling.
-- Asset.monitoredIpsecTunnels: phase-1 tunnel names pinned for fast-cadence
-- IPsec polling. Both arrays follow the same shape as monitoredInterfaces.
ALTER TABLE "assets"
    ADD COLUMN "monitoredStorage"      TEXT[] DEFAULT ARRAY[]::TEXT[],
    ADD COLUMN "monitoredIpsecTunnels" TEXT[] DEFAULT ARRAY[]::TEXT[];
