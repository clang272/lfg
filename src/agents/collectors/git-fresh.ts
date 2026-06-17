// Shared helpers so watch-agent collectors diff against *fresh `origin/main`*,
// never whatever happens to be checked out on disk. The box keeps many
// long-lived worktrees (.claude/worktrees/*, /tmp/lfg-wt/*) that lag main by
// days; reading their working tree made the model-watch / repo-review agents
// flag "drift" that was already fixed on main. These read content straight
// from the `origin/main` ref via git plumbing — non-destructive: no checkout,
// no reset, the working tree is never touched (sibling agents work in it).

import { Glob } from "bun";

export const MAIN_REF = "origin/main";

function run(repo: string, args: string[]): { ok: boolean; out: string; err: string } {
  const proc = Bun.spawnSync({
    cmd: ["git", "-C", repo, ...args],
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    ok: proc.exitCode === 0,
    out: proc.stdout.toString(),
    err: proc.stderr.toString(),
  };
}

// Update the remote-tracking ref so `origin/main` reflects what's actually on
// GitHub right now. Best-effort: returns a warning on failure (offline, no
// remote) rather than throwing, but callers should surface it so a stale read
// is never silently presented as fresh.
export function fetchMain(repo: string): { ok: boolean; warning?: string } {
  const r = run(repo, ["fetch", "--quiet", "origin", "main"]);
  if (!r.ok) return { ok: false, warning: `git fetch origin main failed: ${r.err.trim() || "unknown error"}` };
  return { ok: true };
}

// Tracked file paths at `origin/main` matching any of the globs.
export function listFilesAtMain(repo: string, globs: string[]): string[] {
  const r = run(repo, ["ls-tree", "-r", "--name-only", MAIN_REF]);
  if (!r.ok) return [];
  const all = r.out.split("\n").filter(Boolean);
  const matchers = globs.map((g) => new Glob(g));
  return all.filter((p) => matchers.some((m) => m.match(p)));
}

// File contents at `origin/main` (null if the path doesn't exist there).
export function readFileAtMain(repo: string, path: string): string | null {
  const r = run(repo, ["show", `${MAIN_REF}:${path}`]);
  if (!r.ok) return null;
  return r.out;
}
