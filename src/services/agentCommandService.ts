/**
 * src/services/agentCommandService.ts — process-control command queue (Phase 4).
 *
 * Operator Stop/Start/Restart requests against a service-backed process become
 * AgentCommand rows. The agent polls pending commands, executes via the OS
 * service manager, and reports the outcome. Operator-initiated only — the agent
 * never self-acts. Every transition writes an audit Event.
 *
 * Safety rails (the actuation is high-blast-radius): the request path requires a
 * RESOLVED service/unit (controllable=true) — raw process kill is intentionally
 * NOT supported — an active agent, and the `processControl` RBAC gate at the
 * route layer.
 */

import { prisma } from "../db.js";
import { logEvent } from "./eventLogService.js";
import { AppError } from "../utils/errors.js";

export type ControlAction = "stop" | "start" | "restart";

export interface AgentCommandView {
  id: string;
  action: string;
  target: string;
  /** run_script commands: { runId, interpreter, body, sha256, args, timeoutSec }.
   *  Absent for process-control commands (old agents ignore unknown fields). */
  payload?: unknown;
}

/**
 * Enqueue a control command for one process. Validates the process is
 * service-backed (controllable) and the asset has an active agent. Returns the
 * created command.
 */
export async function requestProcessControl(
  assetId: string,
  name: string,
  action: ControlAction,
  actor: string | undefined,
): Promise<{ id: string; target: string }> {
  const proc = await prisma.assetProcess.findUnique({ where: { assetId_name: { assetId, name } } });
  if (!proc) throw new AppError(404, `Process "${name}" not found in this asset's inventory`);
  if (!proc.controllable || !proc.serviceUnit) {
    throw new AppError(409, `"${name}" has no resolved service/unit — start/stop/restart isn't available for it`);
  }
  const agent = await prisma.managedAgent.findUnique({ where: { assetId }, select: { id: true, installStatus: true } });
  if (!agent) throw new AppError(409, "This asset has no Polaris Agent — process control requires an installed agent");
  if (agent.installStatus !== "active") throw new AppError(409, "The Polaris Agent on this asset isn't active");

  const cmd = await prisma.agentCommand.create({
    data: { assetId, managedAgentId: agent.id, action, target: proc.serviceUnit, requestedBy: actor ?? null },
  });
  await logEvent({
    action: `asset.process.${action}.requested`,
    resourceType: "asset",
    resourceId: assetId,
    resourceName: name,
    actor,
    level: "warning",
    message: `Process ${action} requested for "${name}" (${proc.serviceUnit})`,
    details: { commandId: cmd.id, target: proc.serviceUnit },
  });
  return { id: cmd.id, target: proc.serviceUnit };
}

// Unit-name charset accepted for control — mirrors the agent's validControlTarget
// (systemd units: letters/digits/@:._- ; Windows service short names). Rejecting
// here keeps a malformed unit out of the command queue before it reaches a shell-
// free exec on-agent.
const CONTROL_UNIT_RE = /^[A-Za-z0-9@:._-]{1,256}$/;

/**
 * Enqueue a control command for one service/unit (Services tab). Validates the
 * unit exists in the asset's service inventory and is controllable, and that the
 * asset has an active agent. Returns the created command. Mirrors
 * requestProcessControl but keys on AssetService by (assetId, unit).
 */
export async function requestServiceControl(
  assetId: string,
  unit: string,
  action: ControlAction,
  actor: string | undefined,
): Promise<{ id: string; target: string }> {
  if (!CONTROL_UNIT_RE.test(unit)) throw new AppError(400, `Invalid unit name "${unit}"`);
  const svc = await prisma.assetService.findUnique({ where: { assetId_unit: { assetId, unit } } });
  if (!svc) throw new AppError(404, `Service "${unit}" not found in this asset's inventory`);
  if (!svc.controllable) {
    throw new AppError(409, `"${unit}" is not controllable (masked / not-loaded) — start/stop/restart isn't available for it`);
  }
  const agent = await prisma.managedAgent.findUnique({ where: { assetId }, select: { id: true, installStatus: true } });
  if (!agent) throw new AppError(409, "This asset has no Polaris Agent — service control requires an installed agent");
  if (agent.installStatus !== "active") throw new AppError(409, "The Polaris Agent on this asset isn't active");

  const cmd = await prisma.agentCommand.create({
    data: { assetId, managedAgentId: agent.id, action, target: unit, requestedBy: actor ?? null },
  });
  await logEvent({
    action: `asset.service.${action}.requested`,
    resourceType: "asset",
    resourceId: assetId,
    resourceName: unit,
    actor,
    level: "warning",
    message: `Service ${action} requested for "${unit}"`,
    details: { commandId: cmd.id, target: unit },
  });
  return { id: cmd.id, target: unit };
}

/**
 * Agent poll: return this agent's pending commands and atomically mark them
 * "sent" so a slow agent doesn't re-execute them on the next poll. Bounded.
 */
export async function fetchPendingCommands(managedAgentId: string): Promise<AgentCommandView[]> {
  const cmds = await prisma.agentCommand.findMany({
    where: { managedAgentId, status: "pending" },
    orderBy: { requestedAt: "asc" },
    take: 20,
    select: { id: true, action: true, target: true, payload: true },
  });
  if (cmds.length > 0) {
    await prisma.agentCommand.updateMany({
      where: { id: { in: cmds.map((c) => c.id) } },
      data: { status: "sent", sentAt: new Date() },
    });
    // run_script commands are "running" from the run's perspective the moment
    // they ship to the agent (the stuck sweep doesn't apply — agent runs
    // complete via /command-result).
    const scriptCmdIds = cmds.filter((c) => c.action === "run_script").map((c) => c.id);
    if (scriptCmdIds.length > 0) {
      await prisma.automationScriptRun.updateMany({
        where: { agentCommandId: { in: scriptCmdIds }, status: "pending" },
        data: { status: "running", startedAt: new Date() },
      });
    }
  }
  return cmds.map((c) => ({ id: c.id, action: c.action, target: c.target, ...(c.payload ? { payload: c.payload } : {}) }));
}

const OUTPUT_CAP_BYTES = 64 * 1024;
const RUN_STATUSES = new Set(["succeeded", "failed", "timeout"]);

/** Agent result report. Bound to the agent's own commands; audited.
 *  run_script commands additionally complete their linked AutomationScriptRun
 *  (resultState carries the run status; stdout/stderr/exitCode optional). */
export async function recordCommandResult(
  managedAgentId: string,
  commandId: string,
  success: boolean,
  error: string | null,
  resultState: string | null,
  output?: { exitCode?: number | null; stdout?: string | null; stderr?: string | null },
): Promise<void> {
  const cmd = await prisma.agentCommand.findUnique({ where: { id: commandId } });
  if (!cmd || cmd.managedAgentId !== managedAgentId) {
    throw new AppError(404, "Command not found for this agent");
  }
  await prisma.agentCommand.update({
    where: { id: commandId },
    data: { status: success ? "succeeded" : "failed", completedAt: new Date(), error, resultState },
  });

  if (cmd.action === "run_script") {
    // resultState is the run status the agent observed; anything else maps
    // from the success flag (defensive against older/foreign reporters).
    const runStatus = resultState && RUN_STATUSES.has(resultState) ? resultState : success ? "succeeded" : "failed";
    const run = await prisma.automationScriptRun.findFirst({ where: { agentCommandId: commandId } });
    if (run) {
      await prisma.automationScriptRun.update({
        where: { id: run.id },
        data: {
          status: runStatus,
          exitCode: output?.exitCode ?? null,
          stdout: (output?.stdout ?? "").slice(0, OUTPUT_CAP_BYTES) || null,
          stderr: ((output?.stderr ?? "") || (error ?? "")).slice(0, OUTPUT_CAP_BYTES) || null,
          completedAt: new Date(),
        },
      });
      await logEvent({
        action: "automation.script.run",
        resourceType: "automation-script",
        resourceId: run.scriptId ?? undefined,
        resourceName: run.scriptName,
        actor: run.requestedBy ?? "system:automation",
        level: runStatus === "succeeded" ? "info" : "warning",
        message: `Automation script "${run.scriptName}" ${runStatus} on agent ${cmd.assetId} (exit ${output?.exitCode ?? "n/a"})`,
        details: { runId: run.id, scriptId: run.scriptId, ruleId: run.ruleId, notificationId: run.notificationId, exitCode: output?.exitCode ?? null, runOn: "agent", status: runStatus, assetId: cmd.assetId },
      });
    }
    return;
  }

  await logEvent({
    action: `asset.process.${cmd.action}.result`,
    resourceType: "asset",
    resourceId: cmd.assetId,
    actor: cmd.requestedBy ?? undefined,
    level: success ? "info" : "warning",
    message: `Process ${cmd.action} of "${cmd.target}" ${success ? "succeeded" : "failed"}${error ? `: ${error}` : ""}`,
    details: { commandId, resultState },
  });
}

/** UI status poll for one command (scoped to the asset). */
export async function getCommandStatus(assetId: string, commandId: string): Promise<{
  id: string; action: string; target: string; status: string; error: string | null; resultState: string | null;
} | null> {
  const cmd = await prisma.agentCommand.findUnique({ where: { id: commandId } });
  if (!cmd || cmd.assetId !== assetId) return null;
  return { id: cmd.id, action: cmd.action, target: cmd.target, status: cmd.status, error: cmd.error, resultState: cmd.resultState };
}
