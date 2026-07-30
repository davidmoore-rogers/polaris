package collectors

import "testing"

func TestParseCapEff(t *testing.T) {
	cases := []struct {
		name, in, want string
	}{
		{
			name: "ptrace-only unit (the prod regression shape)",
			in:   "Name:\tpolaris-agent\nCapInh:\t0000000000000000\nCapPrm:\t0000000000080000\nCapEff:\t0000000000080000\nCapBnd:\t0000000000080000\n",
			want: "0000000000080000",
		},
		{
			name: "the fixed pair (SYS_PTRACE bit 19 + DAC_READ_SEARCH bit 2)",
			in:   "CapEff:\t0000000000080004\n",
			want: "0000000000080004",
		},
		{
			name: "unprivileged",
			in:   "CapEff:\t0000000000000000\n",
			want: "0000000000000000",
		},
		{
			name: "line absent",
			in:   "Name:\tpolaris-agent\nUid:\t1000\n",
			want: "",
		},
		{
			name: "empty body",
			in:   "",
			want: "",
		},
	}
	for _, c := range cases {
		if got := parseCapEff(c.in); got != c.want {
			t.Errorf("%s: parseCapEff = %q, want %q", c.name, got, c.want)
		}
	}
}
