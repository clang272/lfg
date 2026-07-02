// Headless interactive session harness for the "pi" agent kind.
//
// Pi is a TTY-oriented CLI, but it does not currently have a transcript format
// that lfg can discover like Claude/Codex. This harness gives it the same lfg
// UX contract as the other managed agents: stable session id, command-file
// control, busy state, and a Claude-shaped transcript that the existing live
// view can stream without Pi-specific frontend code.
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

function transcriptPathFor(cwd: string, uuid: string): string {
  const enc = cwd.replace(/\//g, "-");
  return join(homedir(), ".claude", "projects", enc, `${uuid}.jsonl`);
}

function resolvePiBin(): string {
  if (process.env.LFG_PI_PATH) return process.env.LFG_PI_PATH;
  return Bun.which("pi") ?? "pi";
}

function shellQuote(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}

function piSpawnArgs(): string[] {
  const pi = resolvePiBin();
  const script = process.platform === "linux" ? Bun.which("script") : null;
  if (script) return [script, "-qfec", `${shellQuote(pi)} chat`, "/dev/null"];
  return [pi, "chat"];
}

function writePipe(pipe: unknown, text: string): void {
  const p = pipe as {
    write?: (chunk: string) => unknown;
    flush?: () => unknown;
    getWriter?: () => { write: (chunk: string) => unknown; releaseLock?: () => void };
  } | null;
  try {
    if (p?.write) {
      p.write(text);
      p.flush?.();
      return;
    }
    const writer = p?.getWriter?.();
    if (writer) {
      void writer.write(text);
      writer.releaseLock?.();
    }
  } catch {}
}

function describeJson(value: unknown): string {
  if (value == null) return "";
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

export async function cmdPiSession(argv: string[]): Promise<void> {
  const key = arg(argv, "--key");
  const cwd = arg(argv, "--cwd") ?? process.cwd();
  const tmuxName = arg(argv, "--tmux") ?? "";
  const model = arg(argv, "--model") ?? "pi";
  const dashI = argv.indexOf("--");
  const initialPrompt = dashI >= 0 ? argv.slice(dashI + 1).join(" ").trim() : "";

  if (!key) {
    console.error("pi-session: --key <uuid> is required");
    process.exit(1);
  }
  const sessionKey = key;

  try {
    process.chdir(cwd);
  } catch {}

  const transcriptPath = transcriptPathFor(cwd, sessionKey);
  try {
    mkdirSync(join(transcriptPath, ".."), { recursive: true });
  } catch {}

  let parentUuid: string | null = null;
  let closing = false;
  let quietTimer: ReturnType<typeof setTimeout> | null = null;
  const recentSent: string[] = [];

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
      sessionId: sessionKey,
    });
    parentUuid = uuid;
  }

  function writeAssistant(content: unknown[], apiError = false): void {
    if (!content.length) return;
    const uuid = crypto.randomUUID();
    appendLine({
      parentUuid,
      type: "assistant",
      ...(apiError ? { isApiErrorMessage: true } : {}),
      message: { role: "assistant", model, content },
      uuid,
      timestamp: new Date().toISOString(),
      cwd,
      sessionId: sessionKey,
    });
    parentUuid = uuid;
  }

  function markBusy(): void {
    if (quietTimer) clearTimeout(quietTimer);
    patchEntry(sessionKey, { busy: true });
    quietTimer = setTimeout(() => patchEntry(sessionKey, { busy: false }), 1500);
  }

  function recordPiLine(raw: string, source: "stdout" | "stderr"): void {
    const text = raw.replace(/\r/g, "").trimEnd();
    if (!text.trim()) return;
    markBusy();
    const stripped = text.trim();
    const echoed = recentSent.indexOf(stripped);
    if (echoed >= 0) {
      recentSent.splice(echoed, 1);
      return;
    }
    if (stripped.startsWith("{") && stripped.endsWith("}")) {
      try {
        const payload = JSON.parse(stripped) as {
          type?: string;
          text?: string;
          name?: string;
          arguments?: unknown;
          output?: unknown;
          exit_code?: unknown;
          reason?: string;
          scope?: string;
        };
        const type = String(payload.type ?? "").toLowerCase();
        if (["assistant", "assistant_message", "message", "token"].includes(type) && payload.text) {
          writeAssistant([{ type: "text", text: String(payload.text) }]);
          return;
        }
        if (type === "tool_call") {
          writeAssistant([
            {
              type: "tool_use",
              name: String(payload.name || "tool"),
              input: payload.arguments ?? {},
            },
          ]);
          return;
        }
        if (type === "tool_result") {
          writeAssistant([
            {
              type: "tool_result",
              content: describeJson(payload.output),
            },
          ]);
          return;
        }
        if (type === "approval_request") {
          writeAssistant([
            {
              type: "tool_use",
              name: "AskUserQuestion",
              input: {
                question: payload.reason || "Pi requested approval",
                options: ["Approve", "Deny"],
                scope: payload.scope || "pi.tool",
              },
            },
          ]);
          return;
        }
        if (type === "status") return;
      } catch {}
    }
    writeAssistant([{ type: "text", text }], source === "stderr");
  }

  async function pump(stream: ReadableStream<Uint8Array> | null, source: "stdout" | "stderr"): Promise<void> {
    if (!stream) return;
    const decoder = new TextDecoder();
    let buf = "";
    try {
      for await (const chunk of stream as unknown as AsyncIterable<Uint8Array>) {
        buf += decoder.decode(chunk, { stream: true });
        const lines = buf.split("\n");
        buf = lines.pop() ?? "";
        for (const line of lines) recordPiLine(line, source);
      }
      buf += decoder.decode();
      if (buf.trim()) recordPiLine(buf, source);
    } catch (e) {
      if (!closing) writeAssistant([{ type: "text", text: `Pi stream failed: ${e instanceof Error ? e.message : String(e)}` }], true);
    }
  }

  const pi = Bun.spawn(piSpawnArgs(), {
    cwd,
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
      CONTROL_WORKING_DIRECTORY: cwd,
      CONTROL_CONVERSATION_ID: sessionKey,
      CONTROL_RUN_ID: sessionKey,
    },
  });

  writeEntry({
    sessionId: sessionKey,
    agent: "pi",
    harnessPid: process.pid,
    tmuxName,
    cwd,
    model,
    busy: false,
    title: initialPrompt ? initialPrompt.slice(0, 72) : null,
    createdAt: Date.now(),
  });

  void pump(pi.stdout as ReadableStream<Uint8Array> | null, "stdout");
  void pump(pi.stderr as ReadableStream<Uint8Array> | null, "stderr");

  function send(text: string): void {
    const t = text.trim();
    if (!t) return;
    writeUser(t);
    recentSent.push(t);
    if (recentSent.length > 12) recentSent.shift();
    markBusy();
    writePipe(pi.stdin, `${t}\n`);
  }

  function shutdown(): void {
    closing = true;
    if (quietTimer) clearTimeout(quietTimer);
    try {
      pi.kill();
    } catch {}
    removeEntry(sessionKey);
    setTimeout(() => process.exit(0), 50);
  }

  function dispatch(cmd: AisdkCommand): void {
    if (cmd.type === "send") send(cmd.text);
    else if (cmd.type === "interrupt") {
      try {
        pi.kill("SIGINT");
      } catch {}
      patchEntry(sessionKey, { busy: false });
    } else if (cmd.type === "close") shutdown();
  }

  const cmdFile = cmdPath(sessionKey);
  let cmdOffset = 0;
  const poll = setInterval(() => {
    let raw = "";
    try {
      raw = readFileSync(cmdFile, "utf8");
    } catch {
      return;
    }
    if (raw.length <= cmdOffset) {
      if (raw.length < cmdOffset) cmdOffset = 0;
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

  if (initialPrompt) send(initialPrompt);

  const code = await pi.exited.catch(() => null);
  if (!closing) {
    if (code !== 0 && code != null) writeAssistant([{ type: "text", text: `Pi exited with code ${code}` }], true);
    patchEntry(sessionKey, { busy: false });
  }
  clearInterval(poll);
}

if (import.meta.main) {
  cmdPiSession(process.argv.slice(2)).catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  });
}
