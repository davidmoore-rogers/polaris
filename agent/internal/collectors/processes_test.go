package collectors

import "testing"

func TestAggregateByName(t *testing.T) {
	raws := []procRaw{
		{Name: "nginx", CPUPct: 5, RSSBytes: 100, Username: "www", Exe: "/usr/sbin/nginx", CreateMsec: 2000},
		{Name: "nginx", CPUPct: 7, RSSBytes: 150, Username: "www", Exe: "/usr/sbin/nginx", CreateMsec: 1000},
		{Name: "postgres", CPUPct: 3, RSSBytes: 800, Username: "pg", Exe: "/usr/bin/postgres", CreateMsec: 500},
	}
	out := aggregateByName(raws)
	if len(out) != 2 {
		t.Fatalf("expected 2 programs, got %d", len(out))
	}
	// Sorted by summed CPU desc: nginx (12) before postgres (3).
	if out[0].Name != "nginx" {
		t.Fatalf("expected nginx first (highest summed CPU), got %s", out[0].Name)
	}
	if out[0].InstanceCount != 2 {
		t.Errorf("nginx instanceCount = %d, want 2", out[0].InstanceCount)
	}
	if out[0].CpuPct == nil || *out[0].CpuPct != 12 {
		t.Errorf("nginx cpu = %v, want 12 (summed)", out[0].CpuPct)
	}
	if out[0].MemRssBytes == nil || *out[0].MemRssBytes != 250 {
		t.Errorf("nginx rss = %v, want 250 (summed)", out[0].MemRssBytes)
	}
	// Earliest CreateTime kept (1000 ms, not 2000).
	if out[0].StartedAt == nil || *out[0].StartedAt != msecToRFC3339(1000) {
		t.Errorf("nginx startedAt = %v, want earliest (1000ms)", out[0].StartedAt)
	}
	if out[1].Name != "postgres" || out[1].InstanceCount != 1 {
		t.Errorf("postgres row wrong: %+v", out[1])
	}
}

func TestAggregateByNameEmpty(t *testing.T) {
	if out := aggregateByName(nil); len(out) != 0 {
		t.Errorf("nil input should yield empty, got %d", len(out))
	}
}

func TestAggregateByNameTieBreakByName(t *testing.T) {
	// Equal CPU → deterministic order by name asc.
	raws := []procRaw{
		{Name: "zeta", CPUPct: 1},
		{Name: "alpha", CPUPct: 1},
	}
	out := aggregateByName(raws)
	if out[0].Name != "alpha" || out[1].Name != "zeta" {
		t.Errorf("equal-CPU tie should sort by name; got %s, %s", out[0].Name, out[1].Name)
	}
}
