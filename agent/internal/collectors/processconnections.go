// processconnections.go — listening ports + outbound/inbound peers for MAPPED
// programs (Application Map).
//
// Cross-platform via gopsutil/v3/net (no build tags). Collection is scoped to
// the mapped program names ONLY — the whole point of the Map toggle is to avoid
// full-host collect-everything-then-filter — and the direction heuristic, dedup,
// and per-(program, kind) caps all run here, before transmit:
//
//   - TCP LISTEN rows (and UDP rows with no peer — UDP has no LISTEN state)
//     become kind="listen" and feed a per-program set of listening ports.
//   - Established rows whose LOCAL port is in that listen set are inbound
//     (peer connected to us) — recorded as remoteIp → localPort, dropping the
//     peer's ephemeral port.
//   - All other established rows are outbound — recorded as remoteIp:remotePort,
//     dropping our own ephemeral source port. That drop is what makes outbound
//     rows naturally dedup across scrapes.
//
// Loopback peers are skipped for inbound/outbound (a process talking to itself
// over 127.0.0.1 is noise on a connectivity map); listen rows keep loopback
// binds (they're real facts about the program). IPv4-mapped IPv6 (::ffff:a.b.c.d)
// is normalized to the dotted quad so server-side IP matching works.
package collectors

import (
	"net"
	"sort"
	"strings"

	gopsutilnet "github.com/shirou/gopsutil/v3/net"
	"github.com/shirou/gopsutil/v3/process"

	"github.com/polaris/agent/internal/transport"
)

// Per-(program, kind) row caps — mirrored by the server-side defensive caps in
// persistProcessConnections. Sorted before truncation so a capped set is stable
// across scrapes instead of churning membership.
const (
	maxListenRowsPerProc   = 200
	maxOutboundRowsPerProc = 500
	maxInboundRowsPerProc  = 200
)

// connRaw is one socket reading joined to its owning program, pre-dedup.
// Exported-ish shape kept minimal so buildConnectionSamples stays unit-testable
// without a live socket table.
type connRaw struct {
	Name       string
	Proto      string // "tcp" | "udp"
	Status     string // gopsutil TCP status ("LISTEN", "ESTABLISHED", ...); "" for UDP
	LocalAddr  string
	LocalPort  int
	RemoteAddr string
	RemotePort int
}

// ProcessConnectionsOnce collects connection facts for the mapped program
// names. Returns nil when nothing is mapped or the socket table can't be read.
func ProcessConnectionsOnce(mappedNames []string) []*transport.ProcessConnectionSample {
	if len(mappedNames) == 0 {
		return nil
	}
	want := make(map[string]bool, len(mappedNames))
	for _, n := range mappedNames {
		want[n] = true
	}
	// pid → mapped program name, resolved once (Name() is the expensive call).
	procs, err := process.Processes()
	if err != nil {
		return nil
	}
	nameByPid := make(map[int32]string)
	for _, p := range procs {
		name, err := p.Name()
		if err != nil || !want[name] {
			continue
		}
		nameByPid[p.Pid] = name
	}
	if len(nameByPid) == 0 {
		return nil
	}

	conns, err := gopsutilnet.Connections("all")
	if err != nil {
		return nil
	}
	raws := make([]connRaw, 0, 64)
	for _, c := range conns {
		name, ok := nameByPid[c.Pid]
		if !ok {
			continue
		}
		proto := protoOf(c.Type)
		if proto == "" {
			continue
		}
		raws = append(raws, connRaw{
			Name:       name,
			Proto:      proto,
			Status:     c.Status,
			LocalAddr:  normalizeIP(c.Laddr.IP),
			LocalPort:  int(c.Laddr.Port),
			RemoteAddr: normalizeIP(c.Raddr.IP),
			RemotePort: int(c.Raddr.Port),
		})
	}
	return buildConnectionSamples(raws)
}

// buildConnectionSamples applies the direction heuristic, dedup, and caps.
// Pure + deterministic — unit-tested directly.
func buildConnectionSamples(raws []connRaw) []*transport.ProcessConnectionSample {
	// Pass 1: listen rows + the per-(program, proto) listening-port sets the
	// direction heuristic keys on.
	type key struct{ name, kind, proto, laddr, raddr string; lport, rport int }
	seen := make(map[key]bool)
	listenPorts := make(map[string]map[int]bool) // "name/proto" → ports
	var out []*transport.ProcessConnectionSample

	add := func(name, kind, proto, laddr string, lport int, raddr string, rport int) {
		k := key{name, kind, proto, laddr, raddr, lport, rport}
		if seen[k] {
			return
		}
		seen[k] = true
		out = append(out, &transport.ProcessConnectionSample{
			Name: name, Kind: kind, Proto: proto,
			LocalAddr: laddr, LocalPort: lport,
			RemoteIp: raddr, RemotePort: rport,
		})
	}

	for _, r := range raws {
		if isListen(r) {
			lp := listenPorts[r.Name+"/"+r.Proto]
			if lp == nil {
				lp = make(map[int]bool)
				listenPorts[r.Name+"/"+r.Proto] = lp
			}
			lp[r.LocalPort] = true
			add(r.Name, "listen", r.Proto, r.LocalAddr, r.LocalPort, "", 0)
		}
	}
	// Pass 2: established rows → inbound/outbound by the listen-port sets.
	for _, r := range raws {
		if isListen(r) || r.RemoteAddr == "" || r.RemotePort == 0 {
			continue
		}
		if isLoopback(r.RemoteAddr) {
			continue
		}
		if listenPorts[r.Name+"/"+r.Proto][r.LocalPort] {
			// Peer connected to our listening port; drop its ephemeral port.
			add(r.Name, "inbound", r.Proto, "", r.LocalPort, r.RemoteAddr, 0)
		} else {
			// We dialed out; drop our ephemeral source port.
			add(r.Name, "outbound", r.Proto, "", 0, r.RemoteAddr, r.RemotePort)
		}
	}

	// Deterministic order, then per-(program, kind) caps.
	sort.SliceStable(out, func(i, j int) bool {
		a, b := out[i], out[j]
		if a.Name != b.Name {
			return a.Name < b.Name
		}
		if a.Kind != b.Kind {
			return a.Kind < b.Kind
		}
		if a.Proto != b.Proto {
			return a.Proto < b.Proto
		}
		if a.RemoteIp != b.RemoteIp {
			return a.RemoteIp < b.RemoteIp
		}
		if a.RemotePort != b.RemotePort {
			return a.RemotePort < b.RemotePort
		}
		if a.LocalAddr != b.LocalAddr {
			return a.LocalAddr < b.LocalAddr
		}
		return a.LocalPort < b.LocalPort
	})
	counts := make(map[string]int)
	capped := out[:0]
	for _, s := range out {
		ck := s.Name + "/" + s.Kind
		limit := maxOutboundRowsPerProc
		switch s.Kind {
		case "listen":
			limit = maxListenRowsPerProc
		case "inbound":
			limit = maxInboundRowsPerProc
		}
		if counts[ck] >= limit {
			continue
		}
		counts[ck]++
		capped = append(capped, s)
	}
	if len(capped) == 0 {
		return nil
	}
	return capped
}

// isListen: TCP rows in LISTEN state, or UDP rows with no peer (UDP sockets
// have no LISTEN state — an unconnected bound socket IS the listener).
func isListen(r connRaw) bool {
	if r.Proto == "tcp" {
		return r.Status == "LISTEN"
	}
	return r.RemoteAddr == "" || r.RemotePort == 0
}

// protoOf maps gopsutil's socket type to our proto token. Type follows
// syscall.SOCK_STREAM (1) / SOCK_DGRAM (2).
func protoOf(t uint32) string {
	switch t {
	case 1:
		return "tcp"
	case 2:
		return "udp"
	default:
		return ""
	}
}

// normalizeIP folds IPv4-mapped IPv6 to the dotted quad and canonicalizes via
// net.ParseIP so server-side string matching against asset IPs behaves.
func normalizeIP(s string) string {
	if s == "" || s == "*" {
		return s
	}
	// gopsutil sometimes reports zone-scoped link-locals (fe80::1%eth0).
	if i := strings.IndexByte(s, '%'); i >= 0 {
		s = s[:i]
	}
	ip := net.ParseIP(s)
	if ip == nil {
		return s
	}
	if v4 := ip.To4(); v4 != nil {
		return v4.String()
	}
	return ip.String()
}

func isLoopback(s string) bool {
	ip := net.ParseIP(s)
	return ip != nil && ip.IsLoopback()
}
