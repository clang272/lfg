// Headless interactive session harness for the "opencode" agent kind.
//
// This is the long-lived process behind an "opencode (ai sdk)" session. Like its
// Claude/codex siblings (./aisdk-session.ts, ./codex-aisdk-session.ts) it runs
// inside a tmux pane used purely as a process supervisor + lifecycle handle (we
// never drive I/O through the pane), and drives a multi-turn conversation through
// the Vercel AI SDK — here via the ai-sdk-provider-opencode-sdk provider, which
// talks to a local `opencode serve` HTTP server (auto-started). Auth is
// opencode's own config (~/.config/opencode auth); there is NO API key.
//
// Control plane is identical to the other AI-SDK harnesses:
//   - control IN: we tail a command file (data/aisdk/<key>.cmd) for
//     send / interrupt / close, written by the serve endpoints.
//   - busy + discovery: a registry entry (data/aisdk/<key>.json) we keep
//     updated; serve reads it for the live-view busy dot and session list.
//
// THE KEY DIFFERENCE from both siblings is the transcript. Claude lets the SDK
// write the standard JSONL for us; codex persists a rollout we can discover.
// opencode does NEITHER — it keeps conversation state server-side and writes no
// transcript file our discovery can read. So this harness SELF-PERSISTS a
// transcript in the EXACT Claude-projects JSONL shape, at the exact path
// findTranscriptById() resolves, so lfg's existing Claude discovery + SSE live
// stream read it unchanged with zero opencode-specific code on the read side.
//
// Id model: we mint a deterministic transcript UUID up front and use it as BOTH
// the control-plane KEY (registry/command file names) AND the transcript file
// name — we own the file, so they can be the same id (unlike codex, where the
// transcript id is assigned by the app-server after turn 1). opencode's own
// resume sessionId is learned after turn 1 and stored in the registry's threadId
// slot, used to resume the conversation on later turns. It is NOT surfaced as the
// live-view id (that stays the transcript uuid we wrote).
//
// Interrupt is an AbortController on the current turn — staying purely on the AI
// SDK surface (the provider aborts the in-flight request for us).
import {
  type AisdkCommand,
  cmdPath,
  patchEntry,
  removeEntry,
  writeEntry,
} from "../../aisdk-registry.ts";
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

function arg(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
}

// The provider's HTTP server is started by @opencode-ai/sdk via a bare
// `opencode serve` (cross-spawn, inheriting PATH) — there is no option in the
// installed types to pass a binary path. So we resolve the opencode binary
// ourselves and prepend its directory to PATH before the provider spawns it.
// Resolution order: LFG_OPENCODE_PATH override, then a PATH lookup, then this
// repo's node_modules/.bin/opencode (the `opencode-ai` dep installs it there).
function resolveOpencodePath(): string | undefined {
  try {
    if (process.env.LFG_OPENCODE_PATH) return process.env.LFG_OPENCODE_PATH;
    const onPath = Bun.which("opencode");
    if (onPath) return onPath;
    // import.meta.dir is …/src/agents/backends — climb to the repo root.
    const local = join(import.meta.dir, "../../../node_modules/.bin/opencode");
    return local;
  } catch {
    return undefined;
  }
}

// Make a resolved opencode binary discoverable to the SDK's bare `opencode`
// spawn by prepending its directory to PATH. No-op if we couldn't resolve one
// (then we rely on whatever PATH the harness inherited).
function ensureOpencodeOnPath(): void {
  const bin = resolveOpencodePath();
  if (!bin) return;
  const dir = bin.slice(0, Math.max(bin.lastIndexOf("/"), 0)) || ".";
  const sep = ":";
  const cur = process.env.PATH ?? "";
  if (!cur.split(sep).includes(dir)) process.env.PATH = dir + sep + cur;
}

// ---- Self-persisted Claude-shaped transcript ----------------------------------
// We replicate exactly what lfg's Claude discovery reads:
//   path: ~/.claude/projects/<enc-cwd>/<uuid>.jsonl, enc-cwd = cwd with every
//         "/" replaced by "-" (the same encoding candidateDirs() expects; and
//         findTranscriptById scans every dir anyway, so the file is found).
//   line envelope (copied from a real file under ~/.claude/projects/*/*.jsonl):
//     user:      { parentUuid, type:"user", message:{ role:"user",
//                  content:[{type:"text",text}] }, uuid, timestamp, cwd,
//                  sessionId }
//     assistant: { parentUuid, type:"assistant", message:{ role:"assistant",
//                  model, content:[{type:"text",text}|{type:"tool_use",name,
//                  input}] }, uuid, timestamp, cwd, sessionId }
// These are exactly the fields normalizeLineMessages / lastUserText /
// firstPromptTitle / lastAssistantModel parse — everything else Claude writes is
// ignored by the reader, so we keep our envelope minimal but faithful.
function transcriptPathFor(cwd: string, uuid: string): string {
  const enc = cwd.replace(/\//g, "-");
  return join(homedir(), ".claude", "projects", enc, `${uuid}.jsonl`);
}

export async function cmdOpencodeAisdkSession(argv: string[]): Promise<void> {
  // The control-plane key (a uuid) — names the registry/command files AND the
  // transcript file (we own it, so they're one id).
  const keyArg = arg(argv, "--key");
  const model = arg(argv, "--model") ?? "anthropic/claude-sonnet-4-6";
  const cwd = arg(argv, "--cwd") ?? process.cwd();
  const tmuxName = arg(argv, "--tmux") ?? "";
  // Everything after `--` is the initial prompt (mirrors the other harnesses).
  const dashI = argv.indexOf("--");
  const initialPrompt = dashI >= 0 ? argv.slice(dashI + 1).join(" ").trim() : "";

  if (!keyArg) {
    console.error("opencode-aisdk-session: --key <uuid> is required");
    process.exit(1);
  }
  const key: string = keyArg;

  try {
    process.chdir(cwd);
  } catch {}

  ensureOpencodeOnPath();

  const { streamText } = await import("ai");
  // Lazy-import the provider so the rest of the CLI never hard-depends on it.
  const { createOpencode } = await import("ai-sdk-provider-opencode-sdk");

  // One provider per harness; it owns the auto-started `opencode serve` child,
  // reused across every turn (and resume). directory scopes opencode's file
  // operations to this session's cwd. (The settings expose `cwd` too but it's
  // deprecated in favor of `directory`.)
  const provider = createOpencode({
    autoStartServer: true,
    defaultSettings: { directory: cwd },
  });

  // The transcript we OWN — minted up front so the file path is known before the
  // first turn and the live view can deep-link to it immediately.
  const transcriptPath = transcriptPathFor(cwd, key);
  try {
    mkdirSync(join(transcriptPath, ".."), { recursive: true });
  } catch {}
  let parentUuid: string | null = null; // chain lines like Claude does

  // Append one transcript line, tolerating any malformed input (a single bad
  // turn must never crash the harness or corrupt the file).
  function appendLine(obj: Record<string, unknown>): void {
    try {
      appendFileSync(transcriptPath, JSON.stringify(obj) + "\n");
    } catch {}
  }
  function writeUser(text: string): void {
    const uuid = crypto.randomUUID();
    appendLine({
      parentUuid,
      type: "user",
      message: { role: "user", content: [{ type: "text", text }] },
      uuid,
      timestamp: new Date().toISOString(),
      cwd,
      sessionId: key,
    });
    parentUuid = uuid;
  }
  // content is the assembled block list (text + any tool_use blocks).
  function writeAssistant(content: unknown[]): void {
    if (!content.length) return; // nothing to record (e.g. an empty/aborted turn)
    const uuid = crypto.randomUUID();
    appendLine({
      parentUuid,
      type: "assistant",
      // model lets lastAssistantModel() show the live model on the card.
      message: { role: "assistant", model, content },
      uuid,
      timestamp: new Date().toISOString(),
      cwd,
      sessionId: key,
    });
    parentUuid = uuid;
  }

  // Control-plane registry entry — the moment this exists (and our pid is alive),
  // serve surfaces the session in the live view. threadId (opencode's resume id)
  // starts null and is patched in after turn 1.
  writeEntry({
    sessionId: key,
    agent: "opencode",
    threadId: null,
    harnessPid: process.pid,
    tmuxName,
    cwd,
    model,
    busy: false,
    title: initialPrompt ? initialPrompt.slice(0, 72) : null,
    createdAt: Date.now(),
  });

  const queue: string[] = [];
  let sessionId: string | null = null; // opencode resume id, learned after turn 1
  let currentAc: AbortController | null = null;
  let draining = false;
  let closing = false;

  async function runTurn(prompt: string, signal: AbortSignal): Promise<void> {
    // Record the user turn immediately so it surfaces in the live view even
    // before the assistant replies.
    writeUser(prompt);

    // First turn: no sessionId → the provider creates a fresh opencode session.
    // Later turns: pass the captured sessionId to resume the same conversation.
    // (sessionId lives in the MODEL settings, the 2nd arg — NOT providerOptions,
    // which is where the codex provider wanted its threadId.)
    const llm = sessionId ? provider(model, { sessionId }) : provider(model);

    const result = streamText({
      model: llm,
      prompt,
      abortSignal: signal,
    });

    // Accumulate assistant output into Claude-shaped content blocks. Text is the
    // priority; tool calls are recorded best-effort as tool_use blocks. Never
    // throw out of the part loop on a malformed/unknown part.
    let textBuf = "";
    const toolBlocks: unknown[] = [];
    try {
      for await (const part of result.fullStream as any) {
        try {
          const t = part?.type;
          if (t === "error") {
            const errText = String((part as any).error);
            // The opencode provider emits an "error" stream part for events it
            // hasn't mapped yet — notably `question.asked` (the interactive
            // question event, which this headless harness can't answer anyway).
            // Treating that as a fatal turn error would fail the whole turn, so
            // tolerate it: log and CONTINUE the stream. Any OTHER error still
            // throws (a real generation failure).
            if (/question\.asked|not yet mapped/i.test(errText)) {
              console.error(
                `opencode-aisdk-session: ignoring unmapped stream event — ${errText.slice(0, 200)}`,
              );
            } else {
              throw new Error(errText.slice(0, 800));
            }
          } else if (t === "text-delta") {
            // AI SDK v6 streams text as `text-delta` parts; `.text` (v6) or
            // `.textDelta` (older) carries the chunk.
            textBuf += (part as any).text ?? (part as any).textDelta ?? "";
          } else if (t === "tool-call") {
            toolBlocks.push({
              type: "tool_use",
              name: (part as any).toolName ?? "tool",
              input: (part as any).input ?? (part as any).args ?? {},
            });
          }
        } catch (inner) {
          // A single bad part shouldn't abort the whole turn — but a thrown
          // `error` part is a real failure, so rethrow it to the outer catch.
          if (inner instanceof Error && inner.message) throw inner;
        }
      }
      await result.text; // surfaces a failed generation

      // Capture opencode's resume sessionId from the resolved metadata and pin
      // it for resume on later turns. It is NOT a transcript id (we own the
      // transcript), so it only ever feeds provider(model, { sessionId }).
      if (!sessionId) {
        try {
          const meta = (await result.providerMetadata) as any;
          const id = meta?.opencode?.sessionId;
          if (typeof id === "string" && id) {
            sessionId = id;
            patchEntry(key, { threadId: sessionId });
          }
        } catch {}
      }
    } catch (e) {
      if (signal.aborted) {
        // Interrupted on purpose — still persist whatever streamed so far.
        flushAssistant(textBuf, toolBlocks);
        return;
      }
      console.error(
        `opencode-aisdk-session turn failed: ${e instanceof Error ? e.message : e}`,
      );
    }
    flushAssistant(textBuf, toolBlocks);
  }

  // Write the assistant turn: a text block (if any) followed by tool_use blocks.
  function flushAssistant(text: string, toolBlocks: unknown[]): void {
    const content: unknown[] = [];
    if (text.trim()) content.push({ type: "text", text });
    for (const b of toolBlocks) content.push(b);
    writeAssistant(content);
  }

  async function drain(): Promise<void> {
    if (draining) return;
    draining = true;
    try {
      while (queue.length && !closing) {
        const prompt = queue.shift()!;
        currentAc = new AbortController();
        patchEntry(key, { busy: true });
        try {
          await runTurn(prompt, currentAc.signal);
        } finally {
          currentAc = null;
          patchEntry(key, { busy: false });
        }
      }
    } finally {
      draining = false;
    }
  }

  function shutdown(): void {
    closing = true;
    currentAc?.abort();
    removeEntry(key);
    // Dispose the provider so the auto-started `opencode serve` child doesn't
    // linger. (The installed types expose `dispose()`, not `close()`.)
    void Promise.resolve()
      .then(() => provider.dispose?.())
      .catch(() => {})
      // Give the registry write + provider dispose a tick, then exit so the
      // tmux pane closes.
      .finally(() => setTimeout(() => process.exit(0), 50));
  }

  function dispatch(cmd: AisdkCommand): void {
    if (cmd.type === "send") {
      if (cmd.text.trim()) {
        queue.push(cmd.text);
        void drain();
      }
    } else if (cmd.type === "interrupt") {
      currentAc?.abort();
    } else if (cmd.type === "close") {
      shutdown();
    }
  }

  // Tail the command file by byte offset — same polling approach as the other
  // harnesses (simple + reliable across filesystems; 250ms is interactive).
  const cmdFile = cmdPath(key);
  let cmdOffset = 0;
  const poll = setInterval(() => {
    let raw = "";
    try {
      raw = readFileSync(cmdFile, "utf8");
    } catch {
      return; // not created yet
    }
    if (raw.length <= cmdOffset) {
      if (raw.length < cmdOffset) cmdOffset = 0; // truncated/rotated
      return;
    }
    const fresh = raw.slice(cmdOffset);
    cmdOffset = raw.length;
    for (const line of fresh.split("\n")) {
      if (!line.trim()) continue;
      try {
        dispatch(JSON.parse(line) as AisdkCommand);
      } catch {}
    }
  }, 250);

  // First message, if any, kicks off the conversation immediately.
  if (initialPrompt) {
    queue.push(initialPrompt);
    void drain();
  }

  // Keep the process alive on the poll timer; resolve only on shutdown.
  await new Promise<void>((resolve) => {
    const exitWatch = setInterval(() => {
      if (closing) {
        clearInterval(poll);
        clearInterval(exitWatch);
        resolve();
      }
    }, 100);
  });
}

// Run directly: `bun src/agents/backends/opencode-aisdk-session.ts --key <uuid> ...`.
// Spawned standalone by spawnManagedOpencodeAisdkSession (not via the lfg CLI) so
// the harness has no dependency on the rest of the command surface.
if (import.meta.main) {
  cmdOpencodeAisdkSession(process.argv.slice(2)).catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  });
}
