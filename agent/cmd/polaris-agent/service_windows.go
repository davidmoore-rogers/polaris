//go:build windows

// Windows Service Control Manager integration for the Polaris Agent.
//
// When the agent.exe is registered as a Windows Service (the WINDOWS_INSTALL_PS
// installer template does this via New-Service), the SCM launches the process
// and waits for it to call StartServiceCtrlDispatcher / SetServiceStatus within
// ~30 seconds. A plain Go binary that just runs main() never reports running
// status, so the SCM kills it with "Cannot start service ... did not respond
// to the start or control request in a timely fashion."
//
// This file is the entire SCM-side scaffolding: detect whether we're running
// under SCM, hand off to svc.Run, and translate Stop / Shutdown control
// requests into context.Cancel on the shared agent runtime (runAgent in
// main.go). Console-mode execution (debug runs, the same binary invoked
// directly from a shell) falls through to main()'s signal-driven path.

package main

import (
	"context"
	"log"

	"golang.org/x/sys/windows/svc"
)

const windowsServiceName = "polaris-agent"

// tryRunAsWindowsService returns true if we were launched by the Windows
// Service Control Manager and have completed the lifecycle (Stop request
// arrived, runAgent returned, status reported back to SCM). main() should
// return immediately when this returns true — we've already done the work.
// Returns false on non-service invocations (console mode), so main() can
// fall through to its normal signal-driven path.
func tryRunAsWindowsService(confPath string) bool {
	isService, err := svc.IsWindowsService()
	if err != nil {
		// Defensive: if the SCM detection itself fails, log and proceed
		// as a console process. Better to mis-run as a console (visible
		// failure) than refuse to start entirely.
		log.Printf("svc.IsWindowsService failed: %v — falling back to console mode", err)
		return false
	}
	if !isService {
		return false
	}
	handler := &polarisService{confPath: confPath}
	if err := svc.Run(windowsServiceName, handler); err != nil {
		log.Fatalf("svc.Run(%q): %v", windowsServiceName, err)
	}
	return true
}

type polarisService struct {
	confPath string
}

// Execute is invoked by the SCM after svc.Run dispatches. It must report
// status transitions over `status` and react to control requests on `r`.
// The contract: report StartPending immediately, kick the workload, then
// report Running. On a Stop / Shutdown request, cancel the workload, wait
// for it to drain, then report Stopped and return.
func (p *polarisService) Execute(_ []string, r <-chan svc.ChangeRequest, status chan<- svc.Status) (bool, uint32) {
	status <- svc.Status{State: svc.StartPending}

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	done := make(chan struct{})
	go func() {
		defer close(done)
		runAgent(ctx, p.confPath)
	}()

	status <- svc.Status{
		State:   svc.Running,
		Accepts: svc.AcceptStop | svc.AcceptShutdown,
	}

	for {
		select {
		case req := <-r:
			switch req.Cmd {
			case svc.Interrogate:
				status <- req.CurrentStatus
			case svc.Stop, svc.Shutdown:
				status <- svc.Status{State: svc.StopPending}
				cancel()
				<-done
				status <- svc.Status{State: svc.Stopped}
				return false, 0
			default:
				log.Printf("polaris-agent: unexpected SCM control request: %v", req.Cmd)
			}
		case <-done:
			// runAgent returned on its own — config error, fatal log,
			// etc. Mark stopped with a non-zero exit code so the SCM's
			// failure-action policy (set by sc.exe failure in the
			// installer) triggers a restart.
			status <- svc.Status{State: svc.Stopped}
			return false, 1
		}
	}
}
