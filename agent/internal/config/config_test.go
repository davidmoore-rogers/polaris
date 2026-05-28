package config

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

const (
	canonPin = "sha256:1111111111111111111111111111111111111111111111111111111111111111"
	stagedA  = "sha256:2222222222222222222222222222222222222222222222222222222222222222"
	stagedB  = "sha256:3333333333333333333333333333333333333333333333333333333333333333"
)

func writeAgentConf(t *testing.T, body string) string {
	t.Helper()
	dir := t.TempDir()
	p := filepath.Join(dir, "agent.conf")
	if err := os.WriteFile(p, []byte(body), 0o600); err != nil {
		t.Fatalf("write: %v", err)
	}
	return p
}

// Legacy agent.conf written by a pre-Phase-2 installer — only single
// `cert_fingerprint` line. Load should project that into a one-element
// pin set so callers reading Pins() always get a non-empty slice.
func TestLoad_LegacySinglePinConfig(t *testing.T) {
	p := writeAgentConf(t, "server_url       = https://polaris.example.com\n"+
		"cert_fingerprint = "+canonPin+"\n"+
		"bearer_token     = polaris_xyz\n")
	cfg, err := Load(p)
	if err != nil {
		t.Fatalf("load: %v", err)
	}
	if cfg.CertFingerprint != canonPin {
		t.Errorf("CertFingerprint: got %q want %q", cfg.CertFingerprint, canonPin)
	}
	pins := cfg.Pins()
	if len(pins) != 1 || pins[0] != canonPin {
		t.Errorf("Pins(): got %v want [%s]", pins, canonPin)
	}
}

// Phase 2 agent.conf with `cert_fingerprints` (comma-separated). Load
// populates the set; CertFingerprint is set to the first element for
// legacy-reader compat.
func TestLoad_DualPinConfig(t *testing.T) {
	p := writeAgentConf(t, "server_url        = https://polaris.example.com\n"+
		"cert_fingerprints = "+canonPin+","+stagedA+","+stagedB+"\n"+
		"bearer_token      = polaris_xyz\n")
	cfg, err := Load(p)
	if err != nil {
		t.Fatalf("load: %v", err)
	}
	pins := cfg.Pins()
	if len(pins) != 3 {
		t.Fatalf("Pins() len: got %d want 3 (%v)", len(pins), pins)
	}
	if pins[0] != canonPin || pins[1] != stagedA || pins[2] != stagedB {
		t.Errorf("Pins(): got %v want [%s %s %s]", pins, canonPin, stagedA, stagedB)
	}
	if cfg.CertFingerprint != canonPin {
		t.Errorf("CertFingerprint should mirror first pin: got %q want %q", cfg.CertFingerprint, canonPin)
	}
}

// When BOTH legacy + dual-pin keys are present, dual-pin wins (Phase 2
// installer writes both for downgrade safety).
func TestLoad_BothKeys_DualPinWins(t *testing.T) {
	p := writeAgentConf(t, "server_url        = https://polaris.example.com\n"+
		"cert_fingerprint  = "+canonPin+"\n"+
		"cert_fingerprints = "+canonPin+","+stagedA+"\n"+
		"bearer_token      = polaris_xyz\n")
	cfg, err := Load(p)
	if err != nil {
		t.Fatalf("load: %v", err)
	}
	pins := cfg.Pins()
	if len(pins) != 2 {
		t.Errorf("Pins() len: got %d want 2 (%v)", len(pins), pins)
	}
}

func TestLoad_DualPinTolerantOfWhitespace(t *testing.T) {
	p := writeAgentConf(t, "server_url        = https://polaris.example.com\n"+
		"cert_fingerprints =   "+canonPin+" , , "+stagedA+",\n"+
		"bearer_token      = polaris_xyz\n")
	cfg, err := Load(p)
	if err != nil {
		t.Fatalf("load: %v", err)
	}
	pins := cfg.Pins()
	if len(pins) != 2 || pins[0] != canonPin || pins[1] != stagedA {
		t.Errorf("Pins(): got %v want [%s %s]", pins, canonPin, stagedA)
	}
}

func TestSetPins_NoOpWhenUnchanged(t *testing.T) {
	cfg := &Config{
		CertFingerprint:  canonPin,
		CertFingerprints: []string{canonPin, stagedA},
	}
	changed := cfg.SetPins([]string{canonPin, stagedA})
	if changed {
		t.Error("SetPins should return false when pin set is unchanged")
	}
}

func TestSetPins_DetectsAddedPin(t *testing.T) {
	cfg := &Config{
		CertFingerprint:  canonPin,
		CertFingerprints: []string{canonPin},
	}
	changed := cfg.SetPins([]string{canonPin, stagedA})
	if !changed {
		t.Fatal("SetPins should return true when pin set differs")
	}
	if len(cfg.CertFingerprints) != 2 {
		t.Errorf("CertFingerprints len: got %d want 2", len(cfg.CertFingerprints))
	}
	if cfg.CertFingerprint != canonPin {
		t.Errorf("CertFingerprint should still be canonical: got %q want %q", cfg.CertFingerprint, canonPin)
	}
}

func TestSetPins_PromotesNewCanonicalWhenOldRetired(t *testing.T) {
	cfg := &Config{
		CertFingerprint:  canonPin,
		CertFingerprints: []string{canonPin, stagedA},
	}
	// Operator retired the canonical pin; staged pin becomes canonical.
	changed := cfg.SetPins([]string{stagedA})
	if !changed {
		t.Fatal("SetPins should return true on promotion")
	}
	if cfg.CertFingerprint != stagedA {
		t.Errorf("CertFingerprint should be promoted to %q, got %q", stagedA, cfg.CertFingerprint)
	}
}

func TestSetPins_NormalizesCaseAndWhitespace(t *testing.T) {
	cfg := &Config{}
	cfg.SetPins([]string{"  " + strings.ToUpper(canonPin) + "  ", ""})
	pins := cfg.Pins()
	if len(pins) != 1 || pins[0] != canonPin {
		t.Errorf("expected normalized pin, got %v", pins)
	}
}

func TestSaveLoadRoundTrip_PreservesDualPinSet(t *testing.T) {
	p := filepath.Join(t.TempDir(), "agent.conf")
	cfg := &Config{
		path:             p,
		ServerURL:        "https://polaris.example.com",
		CertFingerprint:  canonPin,
		CertFingerprints: []string{canonPin, stagedA},
		BearerToken:      "polaris_xyz",
	}
	if err := cfg.Save(); err != nil {
		t.Fatalf("save: %v", err)
	}
	// Reload from disk.
	cfg2, err := Load(p)
	if err != nil {
		t.Fatalf("reload: %v", err)
	}
	pins := cfg2.Pins()
	if len(pins) != 2 || pins[0] != canonPin || pins[1] != stagedA {
		t.Errorf("round-trip Pins(): got %v want [%s %s]", pins, canonPin, stagedA)
	}
	// Save() also wrote the legacy single-pin key for downgrade safety.
	body, _ := os.ReadFile(p)
	if !strings.Contains(string(body), "cert_fingerprint  = "+canonPin) {
		t.Error("Save() should write legacy cert_fingerprint line for downgrade safety")
	}
	if !strings.Contains(string(body), "cert_fingerprints = "+canonPin+","+stagedA) {
		t.Error("Save() should write dual-pin cert_fingerprints line")
	}
}

func TestValidate_RequiresAtLeastOnePin(t *testing.T) {
	cfg := &Config{
		ServerURL:       "https://polaris.example.com",
		CertFingerprint: "",
		EnrollmentToken: "polaris_e1",
	}
	if err := cfg.Validate(); err == nil {
		t.Fatal("expected Validate to fail with no pin")
	}
}
