package scriptexec

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"runtime"
	"strings"
	"testing"
)

func hashOf(body string) string {
	sum := sha256.Sum256([]byte(body))
	return hex.EncodeToString(sum[:])
}

// shellPayload builds a platform-appropriate payload (cmd on Windows, sh
// elsewhere) so the table tests run on both dev (Windows) and CI (Linux).
func shellPayload(t *testing.T, bodyWin, bodyNix string, timeoutSec int, args string) *Payload {
	t.Helper()
	body, interp := bodyNix, "sh"
	if runtime.GOOS == "windows" {
		body, interp = bodyWin, "cmd"
	}
	return &Payload{
		RunID:       "run-test",
		Interpreter: interp,
		Body:        body,
		Sha256:      hashOf(body),
		Args:        args,
		TimeoutSec:  timeoutSec,
	}
}

func TestParsePayload(t *testing.T) {
	if _, err := ParsePayload(nil); err == nil {
		t.Fatal("expected error for empty payload")
	}
	if _, err := ParsePayload(json.RawMessage(`{"runId":"r"}`)); err == nil {
		t.Fatal("expected error for missing body/sha256")
	}
	raw := json.RawMessage(`{"runId":"r","interpreter":"sh","body":"echo hi","sha256":"abc","args":"","timeoutSec":5}`)
	p, err := ParsePayload(raw)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if p.RunID != "r" || p.Body != "echo hi" {
		t.Fatalf("payload fields wrong: %+v", p)
	}
}

func TestRunRefusesHashMismatch(t *testing.T) {
	p := shellPayload(t, "@echo hi", "echo hi", 5, "")
	p.Sha256 = strings.Repeat("0", 64) // wrong
	res := Run(p)
	if res.Status != "failed" || !strings.Contains(res.Stderr, "sha256 mismatch") {
		t.Fatalf("expected sha256 refusal, got %+v", res)
	}
}

func TestRunRefusesUnknownInterpreter(t *testing.T) {
	body := "echo hi"
	p := &Payload{RunID: "r", Interpreter: "perl", Body: body, Sha256: hashOf(body), TimeoutSec: 5}
	res := Run(p)
	if res.Status != "failed" || !strings.Contains(res.Stderr, "unknown interpreter") {
		t.Fatalf("expected interpreter refusal, got %+v", res)
	}
}

func TestRunSuccessCapturesOutput(t *testing.T) {
	p := shellPayload(t, "@echo hello-agent", "echo hello-agent", 10, "")
	res := Run(p)
	if res.Status != "succeeded" || res.ExitCode != 0 {
		t.Fatalf("expected success, got %+v", res)
	}
	if !strings.Contains(res.Stdout, "hello-agent") {
		t.Fatalf("stdout missing: %q", res.Stdout)
	}
}

func TestRunNonZeroExit(t *testing.T) {
	p := shellPayload(t, "@exit /b 4", "exit 4", 10, "")
	res := Run(p)
	if res.Status != "failed" || res.ExitCode != 4 {
		t.Fatalf("expected failed/4, got %+v", res)
	}
}

func TestRunTimeoutKillsProcess(t *testing.T) {
	p := shellPayload(t, "@ping -n 30 127.0.0.1 >nul", "sleep 30", 1, "")
	res := Run(p)
	if res.Status != "timeout" {
		t.Fatalf("expected timeout, got %+v", res)
	}
}

func TestRunArgsSingleArgv(t *testing.T) {
	p := shellPayload(t, "@echo arg=%1", `echo "arg=$1"`, 10, "two words")
	res := Run(p)
	if res.Status != "succeeded" {
		t.Fatalf("expected success, got %+v", res)
	}
	// "two words" must arrive as ONE positional arg.
	if !strings.Contains(res.Stdout, "two words") {
		t.Fatalf("args were split or lost: %q", res.Stdout)
	}
}

func TestOutputCap(t *testing.T) {
	// Emit ~1 MB; captured stdout must stay ≤64 KB and the run still succeeds.
	nix := "i=0; while [ $i -lt 20000 ]; do echo 0123456789012345678901234567890123456789012345678901234567890; i=$((i+1)); done"
	win := "@for /l %%i in (1,1,20000) do @echo 0123456789012345678901234567890123456789012345678901234567890"
	p := shellPayload(t, win, nix, 60, "")
	res := Run(p)
	if res.Status != "succeeded" {
		t.Fatalf("expected success, got status=%s stderr=%q", res.Status, res.Stderr)
	}
	if len(res.Stdout) > outputCapBytes {
		t.Fatalf("stdout exceeds cap: %d bytes", len(res.Stdout))
	}
}
