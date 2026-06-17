// The Terminal tab: a faithful browser terminal — ghostty-web (Ghostty's real
// VT engine compiled to WASM) bridged over a websocket to a persistent tmux
// shell on the box. ghostty-web renders Claude Code's heavy TUI faithfully where
// xterm.js mangles it, which is the case we mostly care about here.
import { useCallback, useEffect, useRef, useState } from "react";
import type { TouchEvent as ReactTouchEvent } from "react";
import { init, Terminal as GhosttyTerminal, FitAddon } from "ghostty-web";
import { ClipboardPaste, ExternalLink, TerminalSquare, X } from "lucide-react";

// One WASM load per page, shared across mount/unmount of the tab.
let ghosttyReady: Promise<void> | null = null;
const ensureGhostty = () => (ghosttyReady ??= init());

// Merge freshly-seen URLs into the running list, most-recent first, deduped and
// capped. `found` is chronological, so unshifting in order leaves the newest at
// the front. Returns `prev` unchanged when nothing moved (so React can bail).
function mergeUrls(prev: string[], found: string[], cap = 8): string[] {
  const out = [...prev];
  for (const u of found) {
    const i = out.indexOf(u);
    if (i >= 0) out.splice(i, 1);
    out.unshift(u);
  }
  const next = out.slice(0, cap);
  return next.length === prev.length && next.every((u, i) => u === prev[i]) ? prev : next;
}

// Raw byte sequences for the on-screen key toolbar (phones can't send these).
const KEYS = {
  esc: "\x1b",
  tab: "\t",
  ctrlC: "\x03",
  up: "\x1b[A",
  down: "\x1b[B",
  left: "\x1b[D",
  right: "\x1b[C",
  enter: "\r",
};

const TERM_SESSION = "main";

export function TermView() {
  const hostRef = useRef<HTMLDivElement>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const termRef = useRef<InstanceType<typeof GhosttyTerminal> | null>(null);
  const [status, setStatus] = useState<"connecting" | "open" | "reconnecting" | "closed">("connecting");
  // URLs detected in the output stream → rendered as tappable chips, since a
  // wrapped URL is hard to tap inside the terminal grid (and reliable on iOS).
  const [links, setLinks] = useState<string[]>([]);
  // Long-press → Paste: ghostty's canvas input doesn't receive iOS's native
  // paste menu, so we surface our own. pasteAt = floating button position;
  // pasteInput = the native-input fallback when clipboard reads are blocked.
  const [pasteAt, setPasteAt] = useState<{ x: number; y: number } | null>(null);
  const [pasteInput, setPasteInput] = useState(false);
  const lpTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lpStart = useRef<{ x: number; y: number } | null>(null);
  const pasteInputRef = useRef<HTMLInputElement>(null);

  // Send raw bytes (keystrokes / control sequences) to the PTY.
  const sendRaw = useCallback((data: string) => {
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(new TextEncoder().encode(data));
  }, []);

  const cancelLongPress = useCallback(() => {
    if (lpTimer.current) {
      clearTimeout(lpTimer.current);
      lpTimer.current = null;
    }
  }, []);

  const onTouchStart = useCallback(
    (e: ReactTouchEvent) => {
      const t = e.touches[0];
      if (!t) return;
      lpStart.current = { x: t.clientX, y: t.clientY };
      cancelLongPress();
      lpTimer.current = setTimeout(
        () => setPasteAt({ x: t.clientX, y: t.clientY }),
        450,
      );
    },
    [cancelLongPress],
  );

  const onTouchMove = useCallback(
    (e: ReactTouchEvent) => {
      const t = e.touches[0];
      if (!t || !lpStart.current) return;
      if (Math.hypot(t.clientX - lpStart.current.x, t.clientY - lpStart.current.y) > 12)
        cancelLongPress();
    },
    [cancelLongPress],
  );

  // Read the clipboard and type it into the PTY (no trailing Enter — paste
  // semantics; the user reviews and hits ⏎). Falls back to a native input when
  // the browser blocks programmatic clipboard reads (common on iOS).
  const doPaste = useCallback(async () => {
    setPasteAt(null);
    try {
      const text = await navigator.clipboard.readText();
      if (text) {
        sendRaw(text);
        termRef.current?.focus();
        return;
      }
    } catch {
      /* fall through */
    }
    setPasteInput(true);
  }, [sendRaw]);

  const submitPasteInput = useCallback(() => {
    const v = pasteInputRef.current?.value ?? "";
    if (v) sendRaw(v);
    setPasteInput(false);
    termRef.current?.focus();
  }, [sendRaw]);

  useEffect(() => {
    let disposed = false;
    let term: InstanceType<typeof GhosttyTerminal> | null = null;
    let fit: FitAddon | null = null;
    let ro: ResizeObserver | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let attempt = 0;

    // (Re)open the socket. The tmux shell session lives independently of serve,
    // so when serve restarts (deploys) the socket drops but the session is
    // intact — reconnecting just re-attaches and tmux repaints. That's what
    // makes a deploy non-destructive instead of wiping the terminal.
    const connect = () => {
      if (disposed || !term) return;
      const proto = location.protocol === "https:" ? "wss:" : "ws:";
      const url = `${proto}//${location.host}/api/term?session=${encodeURIComponent(
        TERM_SESSION,
      )}&cols=${term.cols}&rows=${term.rows}`;
      const ws = new WebSocket(url);
      ws.binaryType = "arraybuffer";
      wsRef.current = ws;

      ws.onopen = () => {
        attempt = 0;
        setStatus("open");
        term?.focus();
        // Force tmux to repaint the reattached session at our geometry.
        if (term) ws.send(JSON.stringify({ t: "resize", cols: term.cols, rows: term.rows }));
      };
      ws.onmessage = (e) => {
        if (typeof e.data === "string") term?.write(e.data);
        else term?.write(new Uint8Array(e.data as ArrayBuffer));
      };
      ws.onclose = () => {
        wsRef.current = null;
        if (disposed) return;
        // Reconnect with backoff (0.5s → 5s) so a serve restart self-heals.
        setStatus("reconnecting");
        const delay = Math.min(5000, 500 * 2 ** attempt++);
        reconnectTimer = setTimeout(connect, delay);
      };
    };

    (async () => {
      await ensureGhostty();
      if (disposed || !hostRef.current) return;
      const isDark = document.documentElement.classList.contains("dark");
      term = new GhosttyTerminal({
        fontSize: 13,
        scrollback: 8000,
        cursorBlink: true,
        theme: isDark
          ? { background: "#0b0b0d", foreground: "#d4d4d8" }
          : { background: "#ffffff", foreground: "#18181b" },
      });
      fit = new FitAddon();
      term.loadAddon(fit);
      term.open(hostRef.current);
      try { fit.fit(); } catch {}
      termRef.current = term;

      // Keystrokes → binary frames; resizes → JSON control frames (the backend
      // distinguishes the two by frame type).
      term.onData((d: string) => {
        const ws = wsRef.current;
        if (ws && ws.readyState === WebSocket.OPEN) ws.send(new TextEncoder().encode(d));
      });
      term.onResize(({ cols, rows }: { cols: number; rows: number }) => {
        const ws = wsRef.current;
        if (ws && ws.readyState === WebSocket.OPEN)
          ws.send(JSON.stringify({ t: "resize", cols, rows }));
      });

      ro = new ResizeObserver(() => {
        try { fit?.fit(); } catch {}
      });
      ro.observe(hostRef.current);
      connect();
    })();

    return () => {
      disposed = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      try { ro?.disconnect(); } catch {}
      try { wsRef.current?.close(); } catch {}
      try { term?.dispose(); } catch {}
      termRef.current = null;
      wsRef.current = null;
    };
  }, []);

  // Detect links by polling tmux's logical buffer (wrapped lines rejoined), so
  // long URLs survive — the rendered stream breaks them at every wrap. Cheap
  // and only runs while the tab is mounted.
  useEffect(() => {
    let alive = true;
    const poll = async () => {
      try {
        const r = await fetch(`/api/term/scan?session=${TERM_SESSION}`);
        const d = await r.json();
        if (alive && Array.isArray(d.urls) && d.urls.length)
          setLinks((prev) => mergeUrls(prev, d.urls));
      } catch {}
    };
    void poll();
    const iv = setInterval(poll, 2000);
    return () => {
      alive = false;
      clearInterval(iv);
    };
  }, []);

  // Drop any pending long-press timer if the tab unmounts mid-press.
  useEffect(() => cancelLongPress, [cancelLongPress]);

  // Lock pinch/double-tap/focus auto-zoom WHILE the terminal is mounted (iOS
  // zooms on a tap into the canvas's hidden input and on double-tap). We scope
  // it to this tab by patching the viewport meta and restoring it on unmount,
  // so the rest of the app keeps normal zoom.
  useEffect(() => {
    const meta = document.querySelector('meta[name="viewport"]');
    if (!meta) return;
    const prev = meta.getAttribute("content") ?? "";
    meta.setAttribute("content", prev + ", maximum-scale=1, user-scalable=no");
    return () => meta.setAttribute("content", prev);
  }, []);

  return (
    <div className="flex h-full flex-col overflow-hidden rounded-2xl border border-border bg-[#0b0b0d]">
      <div className="flex items-center gap-2 border-b border-white/10 px-3 py-1.5 text-xs text-white/60">
        <TerminalSquare className="size-3.5" />
        <span className="font-medium">terminal · {TERM_SESSION}</span>
        <span
          className={`ml-auto inline-flex items-center gap-1 ${
            status === "open"
              ? "text-emerald-400"
              : status === "closed"
                ? "text-destructive"
                : "text-white/50"
          }`}
        >
          <span className="size-1.5 rounded-full bg-current" />
          {status}
        </span>
      </div>
      <div
        ref={hostRef}
        onClick={() => termRef.current?.focus()}
        onTouchStart={onTouchStart}
        onTouchMove={onTouchMove}
        onTouchEnd={cancelLongPress}
        onTouchCancel={cancelLongPress}
        onContextMenu={(e) => {
          e.preventDefault();
          setPasteAt({ x: e.clientX, y: e.clientY });
        }}
        style={{
          touchAction: "manipulation",
          WebkitTouchCallout: "none",
          userSelect: "none",
        }}
        className="min-h-0 flex-1 overflow-hidden p-1.5"
      />
      {/* Detected links — tappable chips opening in a new tab. Reliable on iOS
          where tapping a wrapped URL inside the grid isn't. */}
      {links.length > 0 ? (
        <div className="flex items-center gap-1.5 border-t border-white/10 px-2 py-1.5">
          <ExternalLink className="size-3.5 shrink-0 text-white/40" />
          <div className="flex min-w-0 flex-1 gap-1.5 overflow-x-auto">
            {links.map((u) => (
              <a
                key={u}
                href={u}
                target="_blank"
                rel="noreferrer noopener"
                title={u}
                style={{ touchAction: "manipulation" }}
                className="max-w-[60vw] shrink-0 truncate rounded-md bg-sky-500/20 px-2.5 py-1 text-xs font-medium text-sky-300 active:bg-sky-500/40"
              >
                {u.replace(/^https?:\/\//, "")}
              </a>
            ))}
          </div>
          <button
            onClick={() => setLinks([])}
            style={{ touchAction: "manipulation" }}
            className="shrink-0 rounded-md p-1 text-white/40 active:bg-white/10"
            aria-label="clear links"
          >
            <X className="size-3.5" />
          </button>
        </div>
      ) : null}

      {/* On-screen control keys — a terminal is unusable on a phone without them. */}
      <div className="flex flex-wrap items-center gap-1 border-t border-white/10 px-2 py-1.5">
        {[
          ["esc", "Esc"],
          ["tab", "Tab"],
          ["ctrlC", "^C"],
          ["up", "↑"],
          ["down", "↓"],
          ["left", "←"],
          ["right", "→"],
          ["enter", "⏎"],
        ].map(([k, label]) => (
          <button
            key={k}
            onClick={() => sendRaw(KEYS[k as keyof typeof KEYS])}
            style={{ touchAction: "manipulation" }}
            className="rounded-md bg-white/10 px-2.5 py-1 text-xs font-medium text-white/80 active:bg-white/25"
          >
            {label}
          </button>
        ))}
        <button
          onClick={doPaste}
          style={{ touchAction: "manipulation" }}
          className="ml-auto flex items-center gap-1 rounded-md bg-white/10 px-2.5 py-1 text-xs font-medium text-white/80 active:bg-white/25"
        >
          <ClipboardPaste className="size-3.5" />
          Paste
        </button>
      </div>

      {/* Long-press / right-click → floating Paste button at the touch point. */}
      {pasteAt ? (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setPasteAt(null)} />
          <button
            onClick={doPaste}
            style={{
              position: "fixed",
              left: Math.max(8, Math.min(pasteAt.x - 40, window.innerWidth - 110)),
              top: Math.max(8, pasteAt.y - 48),
              touchAction: "manipulation",
            }}
            className="z-50 flex items-center gap-1.5 rounded-xl bg-white px-4 py-2.5 text-sm font-semibold text-black shadow-xl active:scale-95"
          >
            <ClipboardPaste className="size-4" />
            Paste
          </button>
        </>
      ) : null}

      {/* Fallback when the browser blocks clipboard reads: a real input the user
          can long-press → Paste into (always works on iOS), then send. */}
      {pasteInput ? (
        <div className="fixed inset-x-0 bottom-0 z-50 flex items-center gap-2 border-t border-white/10 bg-[#0b0b0d] p-2 pb-[calc(0.5rem+env(safe-area-inset-bottom))]">
          <input
            ref={pasteInputRef}
            autoFocus
            placeholder="Long-press here → Paste, then Send"
            onKeyDown={(e) => {
              if (e.key === "Enter") submitPasteInput();
            }}
            style={{ fontSize: 16 }}
            className="min-w-0 flex-1 rounded-lg border border-white/15 bg-white/5 px-3 py-2 text-white placeholder:text-white/30"
          />
          <button
            onClick={submitPasteInput}
            className="rounded-lg bg-white px-3 py-2 text-sm font-semibold text-black active:scale-95"
          >
            Send
          </button>
          <button
            onClick={() => setPasteInput(false)}
            className="rounded-lg p-2 text-white/50 active:bg-white/10"
            aria-label="cancel paste"
          >
            <X className="size-4" />
          </button>
        </div>
      ) : null}
    </div>
  );
}
