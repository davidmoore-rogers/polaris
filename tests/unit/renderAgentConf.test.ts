/**
 * tests/unit/renderAgentConf.test.ts
 *
 * Asserts agent.conf serialization is correct for both single-pin (legacy)
 * and dual-pin (Phase 2) shapes. The agent.conf file is the contract between
 * agentInstallService (TypeScript) and the Go agent's config.Load. Both
 * sides have to agree on key names + the comma-separated pin list format.
 */

import { describe, expect, it } from "vitest";
import { renderAgentConf } from "../../src/services/agentInstallService.js";

const CANON = "sha256:1111111111111111111111111111111111111111111111111111111111111111";
const STAGED_A = "sha256:2222222222222222222222222222222222222222222222222222222222222222";

describe("renderAgentConf", () => {
  it("emits the legacy single-pin shape when no additional pins are passed", () => {
    const body = renderAgentConf({
      serverUrl: "https://polaris.example.com",
      certFingerprint: CANON,
      enrollmentToken: "polaris_e1",
      agentId: "agent-1",
    });
    expect(body).toMatch(/^server_url\s+= https:\/\/polaris\.example\.com$/m);
    expect(body).toMatch(new RegExp(`^cert_fingerprint\\s+= ${CANON}$`, "m"));
    // Even in single-pin shape we ALSO emit the dual-pin key (with just the
    // canonical) so Phase 2 agent binaries read the unified format.
    expect(body).toMatch(new RegExp(`^cert_fingerprints\\s+= ${CANON}$`, "m"));
    expect(body).toMatch(/^enrollment_token\s+= polaris_e1$/m);
    expect(body).toMatch(/^agent_id\s+= agent-1$/m);
  });

  it("emits dual-pin cert_fingerprints when additionalCertFingerprints is provided", () => {
    const body = renderAgentConf({
      serverUrl: "https://polaris.example.com",
      certFingerprint: CANON,
      additionalCertFingerprints: [STAGED_A],
      enrollmentToken: "polaris_e1",
      agentId: "agent-1",
    });
    // Legacy line still present with the canonical (downgrade compat).
    expect(body).toMatch(new RegExp(`^cert_fingerprint\\s+= ${CANON}$`, "m"));
    // Dual-pin line carries the union, comma-separated, canonical first.
    expect(body).toMatch(new RegExp(`^cert_fingerprints\\s+= ${CANON},${STAGED_A}$`, "m"));
  });

  it("preserves canonical-first ordering when multiple staged pins are provided", () => {
    const STAGED_B = "sha256:3333333333333333333333333333333333333333333333333333333333333333";
    const body = renderAgentConf({
      serverUrl: "https://polaris.example.com",
      certFingerprint: CANON,
      additionalCertFingerprints: [STAGED_A, STAGED_B],
      enrollmentToken: "polaris_e1",
      agentId: "agent-1",
    });
    expect(body).toMatch(new RegExp(`^cert_fingerprints\\s+= ${CANON},${STAGED_A},${STAGED_B}$`, "m"));
  });

  it("handles empty additionalCertFingerprints identically to the legacy single-pin call", () => {
    const a = renderAgentConf({
      serverUrl: "https://polaris.example.com",
      certFingerprint: CANON,
      enrollmentToken: "polaris_e1",
      agentId: "agent-1",
    });
    const b = renderAgentConf({
      serverUrl: "https://polaris.example.com",
      certFingerprint: CANON,
      additionalCertFingerprints: [],
      enrollmentToken: "polaris_e1",
      agentId: "agent-1",
    });
    expect(a).toBe(b);
  });
});
