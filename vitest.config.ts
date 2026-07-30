import { defineConfig, defaultExclude } from "vitest/config";

export default defineConfig({
  test: {
    setupFiles: ["./tests/setup.ts"],
    // `.claude/worktrees/*` holds full scratch checkouts of this repo (one per
    // in-flight branch). Vitest's default include walks the whole cwd and the
    // default exclude doesn't cover them, so every worktree's tests were being
    // collected into `npm test` — silently inflating the suite, and failing loudly
    // once a worktree diverged enough to hit a real DB. Those checkouts are not
    // part of this project's suite; each has its own.
    exclude: [...defaultExclude, "**/.claude/**"],
  },
});
