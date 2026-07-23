package collectors

import "testing"

func TestParseShowUnits(t *testing.T) {
	out := "Id=truckscale-central.service\nMainPID=2589126\nMemoryCurrent=925368320\n\n" +
		"Id=oneshot.service\nMainPID=0\nMemoryCurrent=[not set]\n\n" +
		"Id=unaccounted.service\nMainPID=42\nMemoryCurrent=18446744073709551615\n"
	got := parseShowUnits(out)

	if len(got) != 3 {
		t.Fatalf("expected 3 units, got %d: %+v", len(got), got)
	}

	ts := got["truckscale-central.service"]
	if ts.mainPid != 2589126 {
		t.Errorf("truckscale mainPid = %d, want 2589126", ts.mainPid)
	}
	if !ts.hasMem || ts.memBytes != 925368320 {
		t.Errorf("truckscale mem = (%d, has=%v), want 925368320", ts.memBytes, ts.hasMem)
	}

	one := got["oneshot.service"]
	if one.mainPid != 0 {
		t.Errorf("oneshot mainPid = %d, want 0", one.mainPid)
	}
	if one.hasMem {
		t.Errorf("oneshot should have no accounted memory, got %d", one.memBytes)
	}

	// uint64-max MemoryCurrent is the "unaccounted" sentinel → not reported.
	un := got["unaccounted.service"]
	if un.mainPid != 42 {
		t.Errorf("unaccounted mainPid = %d, want 42", un.mainPid)
	}
	if un.hasMem {
		t.Errorf("uint64-max MemoryCurrent must be treated as unaccounted, got %d", un.memBytes)
	}
}

func TestParseShowUnitsEmpty(t *testing.T) {
	if got := parseShowUnits(""); len(got) != 0 {
		t.Errorf("empty input should yield no units, got %+v", got)
	}
}
