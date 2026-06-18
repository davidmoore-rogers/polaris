// processtelemetry.go — per-pinned-program CPU/RAM sampling (Feature C).
//
// Unlike the inventory snapshot (cumulative CPUPercent), telemetry wants the
// INSTANTANEOUS rate. gopsutil's process.Percent needs two reads around an
// interval; we prime every matching PID's counter, sleep once, then read the
// delta — so total cost is one sleep regardless of how many PIDs match (the
// pinned set is small). Results are aggregated by program name (summed across
// instances) to match the AssetProcessSample model.
package collectors

import (
	"time"

	"github.com/shirou/gopsutil/v3/process"

	"github.com/polaris/agent/internal/transport"
)

// processCPUSampleWindow is the prime→read gap for the instantaneous CPU delta.
// Short enough to keep the loop snappy, long enough for a meaningful number.
const processCPUSampleWindow = 300 * time.Millisecond

// ProcessTelemetryOnce samples CPU/RAM for the pinned program names and returns
// one aggregated row per name. Returns nil when nothing is pinned or the
// process table can't be read.
func ProcessTelemetryOnce(pinnedNames []string) []*transport.ProcessTelemetrySample {
	if len(pinnedNames) == 0 {
		return nil
	}
	want := make(map[string]bool, len(pinnedNames))
	for _, n := range pinnedNames {
		want[n] = true
	}
	procs, err := process.Processes()
	if err != nil {
		return nil
	}

	// Collect the matching processes once (name lookup is the expensive call).
	type match struct {
		p    *process.Process
		name string
	}
	var matches []match
	for _, p := range procs {
		name, err := p.Name()
		if err != nil || !want[name] {
			continue
		}
		matches = append(matches, match{p: p, name: name})
		_, _ = p.Percent(0) // prime the per-PID CPU counter
	}
	if len(matches) == 0 {
		return nil
	}
	time.Sleep(processCPUSampleWindow)

	// Aggregate the delta read by program name.
	type agg struct {
		count int
		cpu   float64
		rss   uint64
	}
	byName := make(map[string]*agg)
	order := make([]string, 0)
	for _, m := range matches {
		a := byName[m.name]
		if a == nil {
			a = &agg{}
			byName[m.name] = a
			order = append(order, m.name)
		}
		a.count++
		if v, err := m.p.Percent(0); err == nil {
			a.cpu += v
		}
		if mi, err := m.p.MemoryInfo(); err == nil && mi != nil {
			a.rss += mi.RSS
		}
	}

	ts := time.Now().UTC().Format(time.RFC3339Nano)
	out := make([]*transport.ProcessTelemetrySample, 0, len(order))
	for _, name := range order {
		a := byName[name]
		cpu := a.cpu
		rss := a.rss
		out = append(out, &transport.ProcessTelemetrySample{
			Timestamp:     ts,
			Name:          name,
			CpuPct:        &cpu,
			MemRssBytes:   &rss,
			InstanceCount: a.count,
		})
	}
	return out
}
