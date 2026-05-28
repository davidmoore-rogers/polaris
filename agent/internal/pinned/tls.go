// Package pinned implements a TLS verifier that pins Polaris's HTTPS leaf
// cert by SHA-256 fingerprint. The agent does NOT trust system root CAs —
// the fingerprint is baked into agent.conf at install time and is the only
// thing the agent will accept on the wire.
//
// This is a stronger guarantee than typical "TLS with public CA trust":
//
//   - A compromised public CA can't forge a cert the agent will trust.
//   - An attacker who somehow swaps Polaris's hostname (DNS hijack, proxy
//     interception) can't substitute a different leaf — the pin won't match.
//   - The only way to rotate the pin is for an operator to re-run install
//     against a re-keyed Polaris server, which writes a fresh agent.conf.
//
// Fingerprint format: "sha256:<lowercase-hex>" — same format the server
// emits from httpsManager.getServerCertFingerprint().
package pinned

import (
	"crypto/sha256"
	"crypto/tls"
	"crypto/x509"
	"encoding/hex"
	"errors"
	"fmt"
	"strings"
)

const Prefix = "sha256:"

// VerifyPeerCertificate builds a custom callback that compares the
// presented leaf certificate's SHA-256 against ANY pin in `expected`.
// Plug into tls.Config.VerifyPeerCertificate.
//
// Dual-pin semantics: the agent accepts the cert if its fingerprint matches
// any element of the set. Operators stage a new pin (server-side via the
// Maintenance card → /config push) BEFORE rotating the server cert; the
// agent's TLS handshakes continue working through the rotation window
// because both old and new pins are trusted. Once every agent has heartbeated
// post-rotation, the operator drops the old pin from the set and the agent
// re-narrows to single-pin trust again.
//
// We also leave tls.Config.InsecureSkipVerify=true so the standard chain
// check (which is what consults system roots) is skipped — pin verification
// is the only check that fires.
func VerifyPeerCertificate(expected []string) func([][]byte, [][]*x509.Certificate) error {
	// Normalize the set once per TLS dialer creation — case + whitespace +
	// drop empties. The hot path on every handshake then just iterates a
	// pre-cleaned slice and compares.
	normalized := make([]string, 0, len(expected))
	for _, p := range expected {
		p = strings.ToLower(strings.TrimSpace(p))
		if p == "" {
			continue
		}
		if !strings.HasPrefix(p, Prefix) {
			// Don't return an error from this constructor — Go's TLS stack
			// calls VerifyPeerCertificate per-handshake and won't surface
			// constructor errors anyway. Skip the malformed entry; the
			// handshake will fail with "mismatch" if every entry was bad.
			continue
		}
		normalized = append(normalized, p)
	}
	return func(rawCerts [][]byte, _ [][]*x509.Certificate) error {
		if len(normalized) == 0 {
			return errors.New("no valid cert pins configured")
		}
		if len(rawCerts) == 0 {
			return errors.New("no peer certificate presented")
		}
		// Leaf cert is rawCerts[0] (the standard order on a TLS handshake).
		sum := sha256.Sum256(rawCerts[0])
		got := Prefix + hex.EncodeToString(sum[:])
		for _, p := range normalized {
			if got == p {
				return nil
			}
		}
		return fmt.Errorf("cert pin mismatch — got %s, expected one of [%s]", got, strings.Join(normalized, ", "))
	}
}

// TLSConfig returns a *tls.Config wired to pin against ANY fingerprint in
// `expectedFingerprints`. Caller injects this into http.Transport or
// websocket.Dialer. Single-pin callers pass a one-element slice.
func TLSConfig(expectedFingerprints []string) *tls.Config {
	return &tls.Config{
		// We skip the standard chain check entirely; the pin is sufficient.
		// VerifyPeerCertificate still fires either way (Go's TLS stack always
		// calls it when set, regardless of InsecureSkipVerify).
		InsecureSkipVerify:    true, //nolint:gosec // pin verification replaces it
		VerifyPeerCertificate: VerifyPeerCertificate(expectedFingerprints),
		MinVersion:            tls.VersionTLS12,
	}
}
