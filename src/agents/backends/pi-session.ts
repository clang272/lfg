// Headless session harness for the "pi" agent kind.
//
// Pi can run as a TTY app, but its repaint stream is not a useful lfg
// transcript. Drive it one turn at a time through `pi --print --mode json`
// against a fixed Pi session file, and self-write the Claude-shaped transcript
// lfg already knows how to stream.
import {
  type AisdkCommand,
  cmdPath,
  patchEntry,
  removeEntry,
  writeEntry,
} from "../../aisdk-registry.ts";
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

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

function describeJson(value: unknown): string {
  if (value == null) return "";
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function piSessionPathFor(cwd: string, uuid: string): string {
  const enc = cwd.replace(/\//g, "--").replace(/^-+/, "");
  return join(homedir(), ".pi", "agent", "sessions", "lfg", enc, `${uuid}.jsonl`);
}

function textFromJson(value: unknown): string {
  if (typeof value === "string") return value;
  if (!value || typeof value !== "object") return "";
  const obj = value as Record<string, unknown>;
  for (const k of ["text", "content", "message", "response", "output", "delta"]) {
    const v = obj[k];
    if (typeof v === "string") return v;
  }
  const parts = obj.parts;
  if (Array.isArray(parts)) return parts.map(textFromJson).filter(Boolean).join("");
  return "";
}

function contentFromPiJson(raw: string): unknown[] {
  const trimmed = raw.trim();
  if (!trimmed) return [];
  const deltas: string[] = [];
  let finalText = "";
  for (const line of trimmed.split("\n")) {
    const s = line.trim();
    if (!s) continue;
    try {
      const parsed = JSON.parse(s) as Record<string, unknown>;
      const type = String(parsed.type ?? "");
      const event = parsed.assistantMessageEvent as Record<string, unknown> | undefined;
      if (type === "message_update" && event) {
        const eventType = String(event.type ?? "");
        if (eventType === "text_delta" && typeof event.delta === "string") deltas.push(event.delta);
        if (eventType === "text_end" && typeof event.content === "string") finalText = event.content;
        continue;
      }
      if ((type === "message_end" || type === "turn_end") && parsed.message) {
        const t = textFromJson(parsed.message);
        if (t) finalText = t;
        continue;
      }
      if (type === "agent_end" && Array.isArray(parsed.messages)) {
        const lastAssistant = [...parsed.messages]
          .reverse()
          .find((m) => m && typeof m === "object" && (m as Record<string, unknown>).role === "assistant");
        const t = textFromJson(lastAssistant);
        if (t) finalText = t;
      }
    } catch {}
  }
  const text = finalText || deltas.join("");
  if (text) return [{ type: "text", text }];
  try {
    const parsed = JSON.parse(trimmed);
    const t = Array.isArray(parsed)
      ? parsed.map(textFromJson).filter(Boolean).join("")
      : textFromJson(parsed);
    if (t) return [{ type: "text", text: t }];
  } catch {}
  return [{ type: "text", text: trimmed }];
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
  const piSessionPath = piSessionPathFor(cwd, sessionKey);
  try {
    mkdirSync(dirname(transcriptPath), { recursive: true });
    mkdirSync(dirname(piSessionPath), { recursive: true });
  } catch {}

  let parentUuid: string | null = null;
  let closing = false;
  let activeAbort: AbortController | null = null;
  let turnQueue = Promise.resolve();

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
    patchEntry(sessionKey, { busy: true });
  }

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

  async function runPiTurn(text: string): Promise<void> {
    const controller = new AbortController();
    activeAbort = controller;
    patchEntry(sessionKey, { busy: true });
    const args = [
      resolvePiBin(),
      "--print",
      "--mode",
      "json",
      "--session",
      piSessionPath,
    ];
    if (model && model !== "pi") args.push("--model", model);
    args.push(text);
    try {
      const proc = Bun.spawn(args, {
        cwd,
        stdout: "pipe",
        stderr: "pipe",
        signal: controller.signal,
        env: {
          ...process.env,
          CONTROL_WORKING_DIRECTORY: cwd,
          CONTROL_CONVERSATION_ID: sessionKey,
          CONTROL_RUN_ID: sessionKey,
        },
      });
      const [stdout, stderr, code] = await Promise.all([
        new Response(proc.stdout).text().catch(() => ""),
        new Response(proc.stderr).text().catch(() => ""),
        proc.exited.catch((e) => (controller.signal.aborted ? 130 : Promise.reject(e))),
      ]);
      if (controller.signal.aborted || closing) return;
      if (code === 0) {
        writeAssistant(contentFromPiJson(stdout));
      } else {
        writeAssistant(
          [{ type: "text", text: stderr.trim() || stdout.trim() || `Pi exited with code ${code}` }],
          true,
        );
      }
    } catch (e) {
      if (!controller.signal.aborted && !closing)
        writeAssistant([{ type: "text", text: `Pi turn failed: ${e instanceof Error ? e.message : String(e)}` }], true);
    } finally {
      if (activeAbort === controller) activeAbort = null;
      patchEntry(sessionKey, { busy: false });
    }
  }

  function send(text: string): void {
    const t = text.trim();
    if (!t) return;
    writeUser(t);
    markBusy();
    turnQueue = turnQueue.then(() => runPiTurn(t), () => runPiTurn(t));
  }

  function shutdown(): void {
    closing = true;
    activeAbort?.abort();
    removeEntry(sessionKey);
    setTimeout(() => process.exit(0), 50);
  }

  function dispatch(cmd: AisdkCommand): void {
    if (cmd.type === "send") send(cmd.text);
    else if (cmd.type === "interrupt") {
      activeAbort?.abort();
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

  await new Promise<never>(() => {});
}

if (import.meta.main) {
  cmdPiSession(process.argv.slice(2)).catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  });
}
