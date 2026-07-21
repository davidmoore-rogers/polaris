-- Agent-side automation script execution rides the existing AgentCommand
-- queue (action="run_script") rather than a parallel poll/claim/result stack.
-- payload carries { runId, interpreter, body, sha256, args, timeoutSec } —
-- body inline (bounded ≤64KB by the registry), sha256 verified by the agent
-- before executing. NULL for the existing process-control commands.
ALTER TABLE "agent_commands" ADD COLUMN "payload" JSONB;
