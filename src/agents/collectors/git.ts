import { access } from "node:fs/promises";
import type { CollectorResult } from "./index.ts";
import { MAIN_REF, fetchMain } from "./git-fresh.ts";

export async function collectGitLog(spec: {
  kind: "git_log";
  repo?: string;
  since?: string;
  pretty?: string;
}): Promise<CollectorResult> {
  const repo = spec.repo ?? process.env.LFG_REPO ?? process.cwd();
  const since = spec.since ?? "30 days ago";
  const pretty = spec.pretty ?? "%h %ad %s";

  const gitDir = `${repo}/.git`;
  try {
    await access(gitDir);
  } catch {
    return {
      title: `Git log (${repo})`,
      body: `(repo not found at ${repo})`,
      ok: false,
      warning: `no .git at ${gitDir}`,
    };
  }

  // Report history of fresh `origin/main`, not the local checkout's branch —
  // it may be a stale worktree parked on an old commit.
  const fetched = fetchMain(repo);

  const proc = Bun.spawnSync({
    cmd: [
      "git",
      "-C",
      repo,
      "log",
      MAIN_REF,
      "--no-merges",
      `--since=${since}`,
      `--pretty=format:${pretty}`,
      "--date=short",
    ],
    stdout: "pipe",
    stderr: "pipe",
  });

  if (proc.exitCode !== 0) {
    return {
      title: `Git log (${repo})`,
      body: "(git log failed: " + proc.stderr.toString() + ")",
      ok: false,
      warning: proc.stderr.toString(),
    };
  }

  const lines = proc.stdout.toString();
  const count = lines.split("\n").filter(Boolean).length;
  const warn = fetched.ok ? "" : `\n> ⚠️ ${fetched.warning} — origin/main may be behind GitHub.`;
  return {
    title: `Git log — ${repo}@origin/main (${count} commits since ${since})`,
    body: "```\n" + lines + "\n```" + warn,
    ok: true,
    warning: fetched.ok ? undefined : fetched.warning,
  };
}
