---
name: lfg-sessions
description: See and drive the other lfg Claude Code sessions — list them, read what a session is doing, send it instructions, interrupt it, start/stop one, and track which session is currently in focus. Use whenever the user (especially over voice) refers to "my session", "the coding agent", "what is X working on", "tell it to…", "switch to…", or otherwise wants to manage work across sessions.
---

# Driving lfg sessions

You are running inside lfg and can orchestrate the other Claude Code sessions it
manages, over its local HTTP API. The API is on the same box, unauthenticated:

```
BASE=http://localhost:8766
```

Each session has a stable `sessionId` (UUID) and a human `title`. Work in terms of
the title with the user ("the auth session", "the one fixing billing"); resolve it
to a `sessionId` via the list. **Speak results in one short conversational line** —
you're being read aloud.

## Which session are we working on (focus pointer)

Persist the focused session so it survives across turns:

```bash
mkdir -p ~/.lfg
echo "<sessionId>" > ~/.lfg/active-session   # set focus
cat ~/.lfg/active-session 2>/dev/null         # recall focus
```

When the user names or implies a session ("let's work on the auth one"), resolve it
and write it to the pointer. When they say "it" / "that session" without naming one,
use the pointer. If the pointer is empty and it's ambiguous, list sessions and ask
which one (briefly).

## Capabilities

```bash
# List sessions. Only act on entries that have both sessionId and tmuxTarget.
curl -s $BASE/api/sessions | jq '.sessions[] | {sessionId, title, agent, tmuxName, tmuxTarget, assignedUser, lastUserText, lastActivityAt}'

# Read the full normalized transcript for context/history questions
curl -s "$BASE/api/sessions/<id>/messages?full=1" | jq -r '.messages[] | "\(.role)/\(.kind): \(.text)"'

# Quick status read only (recent tail)
curl -s "$BASE/api/sessions/<id>/messages?limit=20" | jq -r '.messages[] | "\(.role)/\(.kind): \(.text)"'

# Send an instruction / steer a session (queued; delivered when it's ready)
curl -s -X POST $BASE/api/sessions/<id>/send -H 'Content-Type: application/json' -d '{"text":"run the tests and report failures"}'

# Interrupt a session's current turn (Escape — stop / redirect it)
curl -s -X POST $BASE/api/sessions/<id>/interrupt

# Check delivery status of things you sent
curl -s $BASE/api/sessions/<id>/queue | jq '.queue'

# Start a new worker session (defaults to the configured repo; pass cwd to change)
curl -s -X POST $BASE/api/sessions/new -H 'Content-Type: application/json' -d '{"prompt":"investigate the failing deploy"}' | jq '{sessionId, tmuxName}'

# Close a session you started
curl -s -X POST $BASE/api/sessions/<id>/close
```

## Workflow

1. **Resolve** the target: focus pointer → else match the user's words against `title`
   / `lastUserText` from the list → else ask which one. Ignore list entries
   whose `sessionId` or `tmuxTarget` is null; they cannot be read/driven reliably.
   If `~/.lfg/active-session` points at a session that is absent from the
   current driveable list, treat the pointer as stale and choose from the list.
2. **Act**: use `/messages?full=1` when answering history/context questions,
   checking what was already decided, or briefing yourself before steering a
   session. Use `/messages?limit=20` only for a quick live status check. Use
   `send` to instruct; `interrupt` to stop or redirect; `new`/`close` to manage
   lifecycle.
3. **Confirm** in one line ("Sent. The auth session is running the tests now.").
4. Update the focus pointer whenever the working session changes.

## Cautions

- **Don't act on your own session.** You (the voice orchestrator) appear in the list
  too — your session runs in the lfg repo cwd and has the orchestrator brief. Never
  `send`/`interrupt`/`close` yourself. If unsure which is you, ask before closing
  anything.
- `send` is **queued and steers** — it interrupts the running turn and feeds your
  text as the next instruction. Use `interrupt` alone to just stop.
- A session with no `tmuxTarget` is a ghost (orphaned transcript) — skip it.
- Reads are cheap; prefer a quick `/messages` check over guessing.
