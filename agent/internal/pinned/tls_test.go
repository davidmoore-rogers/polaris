package pinned

import (
	"crypto/sha256"
	"encoding/hex"
	"strings"
	"testing"
)

// fakeDER returns deterministic test bytes + the SHA-256 fingerprint that
// VerifyPeerCertificate would compute against them. Real X.509 DER isn't
// needed for testing the pin check — VerifyPeerCertificate hashes whatever
// it sees in rawCerts[0].
func fakeDER(seed string) ([]byte, string) {
	der := []byte("der-" + seed)
	sum := sha256.Sum256(der)
	return der, "sha256:" + hex.EncodeToString(sum[:])
}

func TestVerifyPeerCertificate_AcceptsMatchingPin(t *testing.T) {
	der, pin := fakeDER("alpha")
	v := VerifyPeerCertificate([]string{pin})
	if err := v([][]byte{der}, nil); err != nil {
		t.Fatalf("expected no error on matching pin, got %v", err)
	}
}

func TestVerifyPeerCertificate_RejectsMismatchingPin(t *testing.T) {
	derA, _ := fakeDER("alpha")
	_, pinB := fakeDER("beta")
	v := VerifyPeerCertificate([]string{pinB})
	if err := v([][]byte{derA}, nil); err == nil {
		t.Fatal("expected error on mismatched pin, got nil")
	} else if !strings.Contains(err.Error(), "mismatch") {
		t.Fatalf("expected mismatch error, got %v", err)
	}
}

func TestVerifyPeerCertificate_AcceptsAnyPinInSet(t *testing.T) {
	// Phase 2 dual-pin: agent has BOTH old and new pin during rotation
	// window. Server can present either cert; verifier accepts either.
	derA, pinA := fakeDER("alpha")
	derB, pinB := fakeDER("beta")
	v := VerifyPeerCertificate([]string{pinA, pinB})

	if err := v([][]byte{derA}, nil); err != nil {
		t.Errorf("expected pin A to match in set, got %v", err)
	}
	if err := v([][]byte{derB}, nil); err != nil {
		t.Errorf("expected pin B to match in set, got %v", err)
	}

	// A third cert that's in neither pin is rejected.
	derC, _ := fakeDER("gamma")
	if err := v([][]byte{derC}, nil); err == nil {
		t.Error("expected unrelated cert to fail pin check")
	}
}

func TestVerifyPeerCertificate_RejectsEmptyPinSet(t *testing.T) {
	v := VerifyPeerCertificate([]string{})
	der, _ := fakeDER("alpha")
	if err := v([][]byte{der}, nil); err == nil {
		t.Fatal("expected error when no pins configured, got nil")
	}
}

func TestVerifyPeerCertificate_RejectsNoCertPresented(t *testing.T) {
	_, pin := fakeDER("alpha")
	v := VerifyPeerCertificate([]string{pin})
	if err := v(nil, nil); err == nil {
		t.Fatal("expected error when no peer cert presented, got nil")
	}
}

func TestVerifyPeerCertificate_SkipsMalformedPinEntries(t *testing.T) {
	// Set contains a bad entry alongside a good one — verifier should
	// accept the good pin instead of refusing the whole set.
	der, pin := fakeDER("alpha")
	v := VerifyPeerCertificate([]string{"not-a-pin", "", "  ", "sha1:abc", pin})
	if err := v([][]byte{der}, nil); err != nil {
		t.Fatalf("expected good pin to pass despite malformed siblings, got %v", err)
	}
}

func TestVerifyPeerCertificate_AllPinsBadIsRejected(t *testing.T) {
	v := VerifyPeerCertificate([]string{"not-a-pin", "", "sha1:abc"})
	der, _ := fakeDER("alpha")
	if err := v([][]byte{der}, nil); err == nil {
		t.Fatal("expected error when every pin in set is malformed, got nil")
	}
}

func TestVerifyPeerCertificate_LowercaseAndTrim(t *testing.T) {
	der, pin := fakeDER("alpha")
	// Operator might paste with stray whitespace or upper-case.
	pinNoisy := "  " + strings.ToUpper(pin) + "  "
	v := VerifyPeerCertificate([]string{pinNoisy})
	if err := v([][]byte{der}, nil); err != nil {
		t.Fatalf("expected normalized pin to match, got %v", err)
	}
}

func TestTLSConfig_PinsThroughToVerifier(t *testing.T) {
	der, pin := fakeDER("alpha")
	cfg := TLSConfig([]string{pin})
	if cfg.VerifyPeerCertificate == nil {
		t.Fatal("expected VerifyPeerCertificate to be set")
	}
	if err := cfg.VerifyPeerCertificate([][]byte{der}, nil); err != nil {
		t.Fatalf("expected pin to flow through to verifier, got %v", err)
	}
	if !cfg.InsecureSkipVerify {
		t.Error("expected InsecureSkipVerify=true (pin verification replaces chain check)")
	}
}
