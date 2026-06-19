// servicecontrol.go — execute operator process-control commands (Phase 4).
//
// RunServiceControl(action, target) is implemented per-OS (systemctl on Linux;
// net + sc on Windows; unsupported elsewhere). The server only ever sends a
// resolved service/unit name as `target` (controllable=true) — the agent
// re-validates the action + target shape here as defense-in-depth before
// shelling out (exec with args, never a shell, so no injection — but a strict
// charset check rejects anything surprising).
package collectors

import "regexp"

// validControlAction is the closed set the agent will execute.
func validControlAction(action string) bool {
	return action == "stop" || action == "start" || action == "restart"
}

// unit/service names: systemd units (letters, digits, @ : - _ . \) and Windows
// service short names (letters, digits, - _ .). One conservative charset covers
// both; anything else is rejected.
var validTargetRe = regexp.MustCompile(`^[A-Za-z0-9@:._\\-]{1,256}$`)

func validControlTarget(target string) bool {
	return validTargetRe.MatchString(target)
}
