-- ARP presence evidence for stale-reservation detection. lastSeenArp is
-- bumped by the discovery sync when the FortiGate ARP table shows the
-- reservation's IP bound to the reservation's MAC (minutes-fresh L2
-- presence — catches statically-configured and ICMP-silent devices that
-- never pull a lease). Folded into the stale-detection "freshest signal"
-- alongside lastSeenLeased and the correlated Asset.lastSeen.

ALTER TABLE "reservations"
    ADD COLUMN "lastSeenArp" TIMESTAMP(3);
