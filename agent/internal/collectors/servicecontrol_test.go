package collectors

import "testing"

func TestValidControlAction(t *testing.T) {
	for _, a := range []string{"stop", "start", "restart"} {
		if !validControlAction(a) {
			t.Errorf("%q should be valid", a)
		}
	}
	for _, a := range []string{"", "kill", "reload", "STOP"} {
		if validControlAction(a) {
			t.Errorf("%q should be rejected", a)
		}
	}
}

func TestValidControlTarget(t *testing.T) {
	for _, tgt := range []string{"nginx.service", "sshd", "user@1000.service", "MSSQLSERVER", "foo-bar_baz.scope"} {
		if !validControlTarget(tgt) {
			t.Errorf("%q should be valid", tgt)
		}
	}
	for _, tgt := range []string{"", "nginx; rm -rf /", "a b", "$(evil)", "name|pipe"} {
		if validControlTarget(tgt) {
			t.Errorf("%q should be rejected (injection-shaped)", tgt)
		}
	}
}
