//go:build windows

package collectors

import "testing"

func TestParseTasklistSvc(t *testing.T) {
	out := "" +
		"\"svchost.exe\",\"880\",\"Dhcp,Dnscache\"\r\n" +
		"\"sqlservr.exe\",\"1234\",\"MSSQLSERVER\"\r\n" +
		"\"notepad.exe\",\"4567\",\"N/A\"\r\n"
	want := map[int32]bool{880: true, 1234: true, 4567: true}
	res := parseTasklistSvc(out, want)
	if res[880] != "Dhcp" { // first service when a PID hosts several
		t.Errorf("pid 880 = %q, want Dhcp", res[880])
	}
	if res[1234] != "MSSQLSERVER" {
		t.Errorf("pid 1234 = %q, want MSSQLSERVER", res[1234])
	}
	if _, ok := res[4567]; ok {
		t.Errorf("pid 4567 (N/A) should be omitted, got %q", res[4567])
	}
}

func TestParseTasklistSvcFilters(t *testing.T) {
	out := "\"a.exe\",\"100\",\"SvcA\"\r\n\"b.exe\",\"200\",\"SvcB\"\r\n"
	res := parseTasklistSvc(out, map[int32]bool{100: true}) // only want 100
	if res[100] != "SvcA" {
		t.Errorf("pid 100 = %q, want SvcA", res[100])
	}
	if _, ok := res[200]; ok {
		t.Error("pid 200 not in want-set should be excluded")
	}
}
