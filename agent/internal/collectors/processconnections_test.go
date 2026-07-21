package collectors

import (
	"fmt"
	"testing"

	"github.com/polaris/agent/internal/transport"
)

func findConn(out []*transport.ProcessConnectionSample, match func(s *transport.ProcessConnectionSample) bool) *transport.ProcessConnectionSample {
	for _, s := range out {
		if match(s) {
			return s
		}
	}
	return nil
}

func countKind(out []*transport.ProcessConnectionSample, name, kind string) int {
	n := 0
	for _, s := range out {
		if s.Name == name && s.Kind == kind {
			n++
		}
	}
	return n
}

func TestBuildConnectionSamplesDirectionHeuristic(t *testing.T) {
	raws := []connRaw{
		// nginx listens on :443 …
		{Name: "nginx", Proto: "tcp", Status: "LISTEN", LocalAddr: "0.0.0.0", LocalPort: 443},
		// … a client connected to it (local port ∈ listen set → inbound, peer's
		// ephemeral port dropped) …
		{Name: "nginx", Proto: "tcp", Status: "ESTABLISHED", LocalAddr: "10.0.0.1", LocalPort: 443, RemoteAddr: "10.9.9.9", RemotePort: 51544},
		// … and nginx dialed out to postgres (ephemeral source port dropped).
		{Name: "nginx", Proto: "tcp", Status: "ESTABLISHED", LocalAddr: "10.0.0.1", LocalPort: 40122, RemoteAddr: "10.0.0.5", RemotePort: 5432},
	}
	out := buildConnectionSamples(raws)
	if len(out) != 3 {
		t.Fatalf("expected 3 samples, got %d: %+v", len(out), out)
	}
	if s := findConn(out, func(s *transport.ProcessConnectionSample) bool { return s.Kind == "listen" }); s == nil || s.LocalPort != 443 || s.LocalAddr != "0.0.0.0" {
		t.Errorf("listen row wrong: %+v", s)
	}
	if s := findConn(out, func(s *transport.ProcessConnectionSample) bool { return s.Kind == "inbound" }); s == nil || s.RemoteIp != "10.9.9.9" || s.LocalPort != 443 || s.RemotePort != 0 {
		t.Errorf("inbound row wrong (peer ephemeral port must be dropped): %+v", s)
	}
	if s := findConn(out, func(s *transport.ProcessConnectionSample) bool { return s.Kind == "outbound" }); s == nil || s.RemoteIp != "10.0.0.5" || s.RemotePort != 5432 || s.LocalPort != 0 {
		t.Errorf("outbound row wrong (our ephemeral port must be dropped): %+v", s)
	}
}

func TestBuildConnectionSamplesEphemeralPortDedup(t *testing.T) {
	// 40 outbound connections to the same dst from different source ports must
	// collapse to ONE row.
	var raws []connRaw
	for i := 0; i < 40; i++ {
		raws = append(raws, connRaw{
			Name: "java", Proto: "tcp", Status: "ESTABLISHED",
			LocalAddr: "10.0.0.1", LocalPort: 40000 + i,
			RemoteAddr: "10.0.0.5", RemotePort: 5432,
		})
	}
	out := buildConnectionSamples(raws)
	if len(out) != 1 {
		t.Fatalf("expected 1 deduped outbound row, got %d", len(out))
	}
}

func TestBuildConnectionSamplesUdpListen(t *testing.T) {
	raws := []connRaw{
		// UDP has no LISTEN state: an unconnected bound socket IS the listener.
		{Name: "dnsmasq", Proto: "udp", LocalAddr: "0.0.0.0", LocalPort: 53},
		// Connected UDP with a remote peer → outbound.
		{Name: "dnsmasq", Proto: "udp", LocalAddr: "10.0.0.1", LocalPort: 41000, RemoteAddr: "8.8.8.8", RemotePort: 53},
	}
	out := buildConnectionSamples(raws)
	if s := findConn(out, func(s *transport.ProcessConnectionSample) bool { return s.Kind == "listen" && s.Proto == "udp" }); s == nil || s.LocalPort != 53 {
		t.Errorf("udp listen row wrong: %+v", s)
	}
	if s := findConn(out, func(s *transport.ProcessConnectionSample) bool { return s.Kind == "outbound" && s.Proto == "udp" }); s == nil || s.RemoteIp != "8.8.8.8" || s.RemotePort != 53 {
		t.Errorf("udp outbound row wrong: %+v", s)
	}
}

func TestBuildConnectionSamplesLoopbackPeersSkipped(t *testing.T) {
	raws := []connRaw{
		// Loopback LISTEN is kept (real fact about the program) …
		{Name: "redis", Proto: "tcp", Status: "LISTEN", LocalAddr: "127.0.0.1", LocalPort: 6379},
		// … loopback peers are noise and dropped.
		{Name: "redis", Proto: "tcp", Status: "ESTABLISHED", LocalAddr: "127.0.0.1", LocalPort: 6379, RemoteAddr: "127.0.0.1", RemotePort: 51000},
		{Name: "redis", Proto: "tcp", Status: "ESTABLISHED", LocalAddr: "127.0.0.1", LocalPort: 42000, RemoteAddr: "::1", RemotePort: 8080},
	}
	out := buildConnectionSamples(raws)
	if len(out) != 1 || out[0].Kind != "listen" {
		t.Fatalf("expected only the listen row, got %+v", out)
	}
}

func TestBuildConnectionSamplesCaps(t *testing.T) {
	var raws []connRaw
	// 250 distinct listen ports (cap 200) + 600 distinct outbound dsts (cap 500)
	// + 250 distinct inbound peers on one listening port (cap 200).
	for i := 0; i < 250; i++ {
		raws = append(raws, connRaw{Name: "big", Proto: "tcp", Status: "LISTEN", LocalAddr: "0.0.0.0", LocalPort: 1000 + i})
	}
	for i := 0; i < 600; i++ {
		raws = append(raws, connRaw{
			Name: "big", Proto: "tcp", Status: "ESTABLISHED",
			LocalAddr: "10.0.0.1", LocalPort: 50000,
			RemoteAddr: fmt.Sprintf("10.%d.%d.7", i/250, i%250), RemotePort: 8080,
		})
	}
	for i := 0; i < 250; i++ {
		raws = append(raws, connRaw{
			Name: "big", Proto: "tcp", Status: "ESTABLISHED",
			LocalAddr: "10.0.0.1", LocalPort: 1000,
			RemoteAddr: fmt.Sprintf("10.200.%d.%d", i/250, i%250), RemotePort: 40000 + i,
		})
	}
	out := buildConnectionSamples(raws)
	if n := countKind(out, "big", "listen"); n != maxListenRowsPerProc {
		t.Errorf("listen rows = %d, want %d", n, maxListenRowsPerProc)
	}
	if n := countKind(out, "big", "outbound"); n != maxOutboundRowsPerProc {
		t.Errorf("outbound rows = %d, want %d", n, maxOutboundRowsPerProc)
	}
	if n := countKind(out, "big", "inbound"); n != maxInboundRowsPerProc {
		t.Errorf("inbound rows = %d, want %d", n, maxInboundRowsPerProc)
	}
}

func TestNormalizeIP(t *testing.T) {
	cases := map[string]string{
		"::ffff:10.1.2.3": "10.1.2.3", // v4-mapped v6 folds to dotted quad
		"fe80::1%eth0":    "fe80::1",  // zone scope stripped
		"10.0.0.1":        "10.0.0.1",
		"":                "",
		"*":               "*",
		"not-an-ip":       "not-an-ip",
	}
	for in, want := range cases {
		if got := normalizeIP(in); got != want {
			t.Errorf("normalizeIP(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestBuildConnectionSamplesEmpty(t *testing.T) {
	if out := buildConnectionSamples(nil); out != nil {
		t.Errorf("nil input should yield nil, got %+v", out)
	}
}
