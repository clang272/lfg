// A self-contained PTY bridge built on Bun FFI — no native npm addon (node-pty
// won't load under Bun, and net.Socket refuses to adopt a pty master fd here).
//
// We allocate a real pseudo-terminal via libutil's openpty(3), spawn a command
// on the slave end (with `setsid -c` so the child becomes a session leader that
// owns the pty as its controlling terminal — tmux attach needs that), and pump
// the master fd in both directions. The master is set non-blocking and drained
// on a short interval: an idle read is a single EAGAIN syscall, so polling a
// handful of terminals costs nothing, and we get the full raw VT byte stream
// (escape sequences intact) that a faithful browser renderer wants.
import { dlopen, FFIType, ptr } from "bun:ffi";

// openpty lives in libutil on glibc < 2.34 and was folded into libc after; try
// the historical home first, then libc, so this works across distros.
function loadOpenpty(): (typeof import("bun:ffi"))["CFunction"] extends never
  ? any
  : any {
  for (const lib of ["libutil.so.1", "libc.so.6", "libutil.so"]) {
    try {
      const h = dlopen(lib, {
        openpty: {
          args: [FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr],
          returns: FFIType.int,
        },
      });
      if (h.symbols.openpty) return h;
    } catch {}
  }
  throw new Error("openpty() not found in libutil/libc — cannot allocate a PTY");
}

const PTY = loadOpenpty();
const LIBC = dlopen("libc.so.6", {
  ioctl: { args: [FFIType.int, FFIType.u64, FFIType.ptr], returns: FFIType.int },
  close: { args: [FFIType.int], returns: FFIType.int },
  read: { args: [FFIType.int, FFIType.ptr, FFIType.u64], returns: FFIType.i64 },
  write: { args: [FFIType.int, FFIType.ptr, FFIType.u64], returns: FFIType.i64 },
  fcntl: { args: [FFIType.int, FFIType.int, FFIType.int], returns: FFIType.int },
});

// Linux x86_64 constants.
const F_GETFL = 3;
const F_SETFL = 4;
const O_NONBLOCK = 0o4000;
const TIOCSWINSZ = 0x5414;

function winsizeBuf(cols: number, rows: number): Uint16Array {
  // struct winsize { unsigned short ws_row, ws_col, ws_xpixel, ws_ypixel }
  return new Uint16Array([rows & 0xffff, cols & 0xffff, 0, 0]);
}

export interface PtyOptions {
  cols?: number;
  rows?: number;
  cwd?: string;
  env?: Record<string, string | undefined>;
}

export class PtyBridge {
  private master = -1;
  private proc: Bun.Subprocess | null = null;
  private poll: ReturnType<typeof setInterval> | null = null;
  private rbuf = new Uint8Array(65536);
  private dec = new TextDecoder();
  private enc = new TextEncoder();
  private dataCb: ((chunk: Uint8Array) => void) | null = null;
  private exitCb: (() => void) | null = null;
  private closed = false;

  constructor(argv: string[], opts: PtyOptions = {}) {
    const cols = opts.cols ?? 80;
    const rows = opts.rows ?? 24;
    const amaster = new Int32Array(1);
    const aslave = new Int32Array(1);
    const ws = winsizeBuf(cols, rows);
    const rc = PTY.symbols.openpty(
      ptr(amaster),
      ptr(aslave),
      null,
      null,
      ptr(ws),
    );
    if (rc !== 0) throw new Error(`openpty failed (rc=${rc})`);
    this.master = amaster[0];
    const slave = aslave[0];

    // `setsid -c <argv>`: new session + acquire the slave pty as the controlling
    // terminal, which `tmux attach`/`new-session` requires.
    this.proc = Bun.spawn(["setsid", "-c", ...argv], {
      stdio: [slave, slave, slave],
      cwd: opts.cwd,
      env: { TERM: "xterm-256color", ...process.env, ...opts.env },
    });
    LIBC.symbols.close(slave); // parent keeps only the master

    // Non-blocking master so the drain loop never stalls the event loop.
    const flags = LIBC.symbols.fcntl(this.master, F_GETFL, 0);
    LIBC.symbols.fcntl(this.master, F_SETFL, flags | O_NONBLOCK);
  }

  onData(cb: (chunk: Uint8Array) => void): void {
    this.dataCb = cb;
    if (!this.poll) this.startPump();
  }

  onExit(cb: () => void): void {
    this.exitCb = cb;
  }

  private startPump(): void {
    this.poll = setInterval(() => this.drain(), 16);
  }

  private drain(): void {
    if (this.closed) return;
    for (;;) {
      const n = Number(
        LIBC.symbols.read(this.master, ptr(this.rbuf), BigInt(this.rbuf.length)),
      );
      if (n > 0) {
        // Copy out of the reused scratch buffer before handing it off.
        this.dataCb?.(this.rbuf.slice(0, n));
        continue;
      }
      if (n === 0) {
        // EOF: the child closed the slave (process exited / tmux detached).
        this.close();
        this.exitCb?.();
      }
      // n < 0 → EAGAIN (no data right now); stop draining until next tick.
      return;
    }
  }

  write(data: Uint8Array | string): void {
    if (this.closed || this.master < 0) return;
    const b = typeof data === "string" ? this.enc.encode(data) : data;
    LIBC.symbols.write(this.master, ptr(b), BigInt(b.length));
  }

  resize(cols: number, rows: number): void {
    if (this.closed || this.master < 0) return;
    const ws = winsizeBuf(cols, rows);
    // Updating the pty winsize raises SIGWINCH in the foreground process, so the
    // attached TUI repaints at the new geometry on its own.
    LIBC.symbols.ioctl(this.master, BigInt(TIOCSWINSZ), ptr(ws));
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.poll) {
      clearInterval(this.poll);
      this.poll = null;
    }
    if (this.master >= 0) {
      LIBC.symbols.close(this.master);
      this.master = -1;
    }
    // Best-effort: tear down the attach client. The tmux *session* it was
    // attached to is detached, not killed, so it survives for the next connect.
    try {
      this.proc?.kill();
    } catch {}
    this.proc = null;
  }
}

// Sanitize a caller-supplied terminal id into a tmux session name fragment:
// tmux session names can't contain `.` or `:` and we don't want shell-hostile
// chars. Keep it short and predictable.
export function termSessionName(id: string): string {
  const safe = (id || "main").replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 32) || "main";
  return `lfg-term-${safe}`;
}
