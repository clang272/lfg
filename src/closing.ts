// Tombstones for just-closed sessions, so removal from the session list is
// deterministic. /close only sends the session's `claude`/`codex` process a
// SIGHUP (via tmux kill-session/kill-pane); the process takes a beat to actually
// exit, so the next listSessions() pgrep can still see it and the card flickers
// back for a poll or two. We record the closed pid here the instant we kill it;
// listSessions() filters tombstoned pids out, so a closed session leaves the
// list immediately and never reappears.
//
// The tombstone self-prunes after a short TTL — by then a SIGHUP'd process is
// long gone, so the entry has done its job. The TTL also means a closed session
// that somehow refuses to die *does* resurface (honest: it really is still
// running), and a much-later recycled pid is never wrongly suppressed.
const TTL_MS = 60_000;
const closed = new Map<number, number>(); // pid -> closedAt (ms)

// Record a pid we just killed. Pruning expired entries on each write keeps the
// map from accumulating tombstones for pids that died long ago.
export function markClosed(pid: number): void {
  if (!pid || pid <= 0) return;
  const now = Date.now();
  for (const [p, at] of closed) if (now - at > TTL_MS) closed.delete(p);
  closed.set(pid, now);
}

// True while a just-closed pid is still inside its tombstone window. Expired
// entries are dropped so the check stays self-healing.
export function isClosing(pid: number): boolean {
  const at = closed.get(pid);
  if (at == null) return false;
  if (Date.now() - at > TTL_MS) {
    closed.delete(pid);
    return false;
  }
  return true;
}
