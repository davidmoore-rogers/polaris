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

func TestParseListUnits(t *testing.T) {
	// The plain (`--plain --no-legend`) table form the agent actually sees under
	// systemd — description carries embedded spaces; a failed unit may keep a
	// leading "●"; a non-.service row (belt-and-suspenders) is ignored.
	out := "" +
		"accounts-daemon.service   loaded active   running Accounts Service\n" +
		"truckscale-central.service loaded active  running Truck Scale Central Daemon\n" +
		"● oops.service             loaded failed  failed  Something Broke Badly\n" +
		"oneshot.service            loaded inactive dead    One Shot Setup\n" +
		"dbus.socket                loaded active   running D-Bus Socket\n"
	got := parseListUnits(out)

	if len(got) != 4 {
		t.Fatalf("expected 4 service units, got %d: %+v", len(got), got)
	}
	ts := got["truckscale-central.service"]
	if ts.Load != "loaded" || ts.Active != "active" || ts.Sub != "running" {
		t.Errorf("truckscale states = %+v, want loaded/active/running", ts)
	}
	if ts.Description != "Truck Scale Central Daemon" {
		t.Errorf("truckscale description = %q, want multi-word description", ts.Description)
	}
	// Leading bullet must be stripped so the unit name lands in column 0.
	oops, ok := got["oops.service"]
	if !ok {
		t.Fatalf("failed-unit row with leading ● was not parsed: %+v", got)
	}
	if oops.Active != "failed" || oops.Description != "Something Broke Badly" {
		t.Errorf("oops row = %+v, want active=failed, full description", oops)
	}
	if _, ok := got["dbus.socket"]; ok {
		t.Errorf("non-.service row should be ignored, got %+v", got["dbus.socket"])
	}
}

func TestParseListUnitsEmpty(t *testing.T) {
	if got := parseListUnits(""); len(got) != 0 {
		t.Errorf("empty input should yield no units, got %+v", got)
	}
	// A JSON blob (the interactive-session output the agent must NOT rely on)
	// has no whitespace-columned service rows, so it parses to nothing.
	if got := parseListUnits(`[{"unit":"x.service","load":"loaded"}]`); len(got) != 0 {
		t.Errorf("JSON input should not yield table rows, got %+v", got)
	}
}

func TestParseListUnitFiles(t *testing.T) {
	out := "" +
		"truckscale-central.service enabled  enabled\n" +
		"sshd.service               enabled\n" + // preset column optional
		"getty@.service             static\n" +
		"dbus.socket                enabled  enabled\n" // non-service ignored
	got := parseListUnitFiles(out)

	if len(got) != 3 {
		t.Fatalf("expected 3 service unit-files, got %d: %+v", len(got), got)
	}
	if got["truckscale-central.service"] != "enabled" {
		t.Errorf("truckscale state = %q, want enabled", got["truckscale-central.service"])
	}
	if got["getty@.service"] != "static" {
		t.Errorf("getty state = %q, want static", got["getty@.service"])
	}
	if _, ok := got["dbus.socket"]; ok {
		t.Errorf("non-.service unit-file should be ignored")
	}
}
