//go:build linux

package collectors

import "testing"

func TestParseSystemdUnit(t *testing.T) {
	cases := map[string]string{
		// cgroup v2
		"0::/system.slice/nginx.service\n": "nginx.service",
		// cgroup v1 (multiple controllers)
		"12:pids:/system.slice/sshd.service\n11:memory:/system.slice/sshd.service\n": "sshd.service",
		// user scope (no .service) → falls back to .scope
		"0::/user.slice/user-1000.slice/session-3.scope\n": "session-3.scope",
		// not under a unit
		"0::/\n": "",
		"":       "",
	}
	for in, want := range cases {
		if got := parseSystemdUnit(in); got != want {
			t.Errorf("parseSystemdUnit(%q) = %q, want %q", in, got, want)
		}
	}
}
