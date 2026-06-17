import type { CollectorResult } from "./index.ts";

// Host + supply-chain security collector. Runs a fixed battery of READ-ONLY
// probes on the dev box (this machine — the one lfg runs on) and a repo
// supply-chain audit, then hands the raw output to the agent to triage. This is
// the codified version of the manual "are we compromised on this server?" sweep:
// access/login history, account/sudo surface, listening ports + outbound,
// persistence (cron/systemd), rootkit indicators, recently-modified system
// binaries, and `bun audit` / `npm audit` + known-bad-package IoC grep.
//
// SAFETY: every command here is read-only — no command mutates state. The probe
// set is HARDCODED (the agent cannot inject commands), so this collector can
// never be steered into running arbitrary shell. `sudo -n` is used where root
// is needed (auth.log, lastb, iptables, find under /usr); on a box where the
// runner has NOPASSWD sudo those succeed, otherwise they degrade to a
// "(no access)" line rather than blocking.

const DEFAULT_REPO =
  process.env.LFG_SECURITY_REPO ?? process.env.LFG_REPO ?? process.cwd();
const PROBE_TIMEOUT_S = 60;
const MAX_PROBE_CHARS = 6000;

type Probe = { label: string; cmd: string };

// Each value is a list of read-only probes. Keys are the selectable section
// names exposed via the `sections` frontmatter field (default: all).
const SECTIONS: Record<string, Probe[]> = {
  access: [
    { label: "identity & live sessions", cmd: `id; echo; who -a 2>/dev/null | head -30` },
    { label: "recent logins (last 15)", cmd: `last -15 2>/dev/null | head -16` },
    {
      label: "failed logins — brute-force noise, expected on a public :22",
      cmd: `sudo -n lastb -15 2>/dev/null | head -16 || echo "(lastb needs root / no access)"`,
    },
    {
      label: "ACCEPTED ssh logins (watch the key fingerprints + source IPs)",
      cmd: `sudo -n grep -hE "Accepted (publickey|password|keyboard)" /var/log/auth.log* 2>/dev/null | tail -25 || echo "(no auth.log access)"`,
    },
    {
      label: "authorized_keys (dev + root) — any key here grants login",
      cmd: `for u in "$HOME" /root; do echo "## $u/.ssh/authorized_keys"; (sudo -n cat $u/.ssh/authorized_keys 2>/dev/null || cat $u/.ssh/authorized_keys 2>/dev/null || echo "(none / no access)"); done`,
    },
    {
      label: "sshd effective auth config",
      cmd: `sudo -n sshd -T 2>/dev/null | grep -iE '^(passwordauthentication|permitrootlogin|pubkeyauthentication|kbdinteractiveauthentication|permitemptypasswords)' || echo "(sshd -T needs root / no access)"`,
    },
  ],
  accounts: [
    { label: "users with a login shell", cmd: `grep -E '/(bash|sh|zsh|fish)$' /etc/passwd` },
    { label: "UID 0 accounts (should be root only)", cmd: `awk -F: '$3==0{print}' /etc/passwd` },
    {
      label: "sudoers.d (extra grants)",
      cmd: `sudo -n ls -la /etc/sudoers.d/ 2>/dev/null; echo; sudo -n grep -rvE '^#|^$' /etc/sudoers.d/ 2>/dev/null || echo "(no access)"`,
    },
  ],
  network: [
    { label: "listening sockets", cmd: `ss -tulpn 2>/dev/null | head -40 || netstat -tulpn 2>/dev/null | head -40` },
    {
      label: "established outbound (non-loopback)",
      cmd: `ss -tnp state established 2>/dev/null | grep -vE '127\\.0\\.0\\.1|::1|\\[::ffff:127' | head -40`,
    },
  ],
  persistence: [
    { label: "user crontab (dev)", cmd: `crontab -l 2>/dev/null || echo "(none)"` },
    { label: "root crontab", cmd: `sudo -n crontab -l 2>/dev/null || echo "(no access)"` },
    {
      label: "system cron (/etc/crontab + cron.d)",
      cmd: `sudo -n grep -rvE '^#|^$' /etc/crontab /etc/cron.d/ 2>/dev/null | head -40 || grep -rvE '^#|^$' /etc/crontab /etc/cron.d/ 2>/dev/null | head -40`,
    },
    {
      label: "cron.{daily,hourly,weekly,monthly} contents",
      cmd: `ls -la /etc/cron.daily /etc/cron.hourly /etc/cron.weekly /etc/cron.monthly 2>/dev/null`,
    },
    { label: "systemd timers", cmd: `systemctl list-timers --all --no-pager 2>/dev/null | head -25` },
    {
      label: "local (non-vendor) systemd units",
      cmd: `ls -la /etc/systemd/system/ /etc/systemd/system/multi-user.target.wants/ 2>/dev/null | grep -vE 'total|^d| -> /usr/lib/systemd| -> /lib/systemd' | head -40`,
    },
  ],
  rootkit: [
    {
      label: "/etc/ld.so.preload (userland-rootkit indicator)",
      cmd: `cat /etc/ld.so.preload 2>/dev/null && echo "!!! ld.so.preload EXISTS — INVESTIGATE !!!" || echo "(absent - good)"`,
    },
    {
      label: "LD_PRELOAD injected via env/profile",
      cmd: `grep -riE 'LD_PRELOAD' /etc/environment /etc/profile /etc/profile.d/ /etc/bash.bashrc 2>/dev/null || echo "(none)"`,
    },
    {
      label: "processes executing from /tmp /dev/shm /var/tmp",
      cmd: `ls -la /proc/*/exe 2>/dev/null | grep -E '/tmp/|/dev/shm|/var/tmp' | grep -viE 'chrome|playwright|node-gyp' || echo "(none)"`,
    },
    {
      label: "deleted-but-running binaries",
      cmd: `ls -la /proc/*/exe 2>/dev/null | grep '(deleted)' | grep -viE 'chrome|claude|bun|node|code|/snap/' || echo "(none suspicious)"`,
    },
    {
      label: "shell rc injection (dev) — curl|wget|base64|/dev/tcp|reverse-shell markers",
      cmd: `for f in "$HOME/.bashrc" "$HOME/.profile" "$HOME/.bash_profile" "$HOME/.bash_aliases"; do [ -f "$f" ] && grep -nE 'curl|wget|base64 -d|/dev/tcp|bash -i|nc -e|\\.onion' "$f"; done; echo "(scan done — lines above, if any, need review)"`,
    },
  ],
  integrity: [
    {
      label: "system binaries modified in the last 14 days (coherent apt batches = upgrades; lone outliers = suspect)",
      cmd: `sudo -n find /usr/bin /usr/sbin /bin /sbin /usr/local/bin /usr/local/sbin -type f -mtime -14 -printf '%TY-%Tm-%Td %p\\n' 2>/dev/null | sort | head -80 || echo "(find under /usr needs root / no access)"`,
    },
  ],
  supply_chain: [
    {
      label: "bun audit — CRITICAL + HIGH advisories",
      cmd: `bun audit 2>/dev/null | grep -iE 'critical:|high:' | sort -u | head -40; echo; bun audit 2>/dev/null | tail -8 | grep -iE 'vulnerabilit' || echo "(bun audit produced no summary — older bun?)"`,
    },
    {
      label: "npm audit — package-lock sub-projects",
      cmd: `for d in apps/infra/worker apps/infra/assets-worker apps/blog/scripts .deepsec; do [ -f "$d/package-lock.json" ] && { echo "## $d"; (cd "$d" && npm audit --omit=dev 2>/dev/null | grep -iE 'vulnerabilit|found 0|critical|high' | head -4); }; done`,
    },
    {
      label: "known-compromised-package IoC sweep (chalk/debug clipper + Shai-Hulud worm)",
      cmd: `echo "## Sept-2025 chalk/debug crypto-clipper poisoned versions"; grep -nE 'chalk@5\\.6\\.1|debug@4\\.4\\.2|ansi-styles@6\\.2\\.2|color-convert@3\\.1\\.1|strip-ansi@7\\.1\\.1|supports-color@10\\.2\\.1|ansi-regex@6\\.2\\.1|wrap-ansi@9\\.0\\.1|color-name@2\\.0\\.1|chalk-template@1\\.1\\.1' bun.lock 2>/dev/null && echo "!!! POISONED VERSION PRESENT !!!" || echo "(none of the poisoned versions present)"; echo; echo "## Shai-Hulud self-replicating worm markers"; grep -rlE 'webhook\\.site/bb8ca5f6|shai-hulud' . --include='*.json' --include='*.yml' --include='*.yaml' 2>/dev/null | grep -v node_modules | head; find . -name 'shai-hulud*' 2>/dev/null | grep -v node_modules | head; echo "(IoC sweep complete — any line above the 'complete' marker is a hit)"`,
    },
  ],
};

function runProbe(p: Probe, cwd?: string): string {
  const proc = Bun.spawnSync({
    cmd: ["timeout", String(PROBE_TIMEOUT_S), "bash", "-lc", p.cmd],
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env },
  });
  const out = proc.stdout.toString();
  const err = proc.stderr.toString().trim();
  let body = out.trim();
  if (err) body += `${body ? "\n" : ""}[stderr] ${err.slice(0, 400)}`;
  if (!body) body = "(no output)";
  if (body.length > MAX_PROBE_CHARS) body = body.slice(0, MAX_PROBE_CHARS) + "\n…(truncated)";
  return body;
}

export async function collectSecurityScan(spec: {
  kind: "security_scan";
  sections?: string[];
  repo?: string;
}): Promise<CollectorResult> {
  const repo = spec.repo ?? DEFAULT_REPO;
  const wanted = spec.sections?.length ? spec.sections : Object.keys(SECTIONS);
  const unknown = wanted.filter((s) => !(s in SECTIONS));
  if (unknown.length) {
    return {
      title: "security scan",
      body: `(unknown section(s): ${unknown.join(", ")} — valid: ${Object.keys(SECTIONS).join(", ")})`,
      ok: false,
      warning: `unknown security sections: ${unknown.join(", ")}`,
    };
  }

  const out: string[] = [];
  out.push(`host: $(hostname) — scanned read-only; supply-chain repo: ${repo}`);
  for (const section of wanted) {
    out.push(`\n### [${section}]`);
    const cwd = section === "supply_chain" ? repo : undefined;
    for (const probe of SECTIONS[section]) {
      out.push(`\n#### ${probe.label}\n\`\`\`\n${runProbe(probe, cwd)}\n\`\`\``);
    }
  }

  return {
    title: `Security scan — host probes + supply-chain audit (${wanted.join(", ")})`,
    body: out.join("\n").slice(0, 180_000),
    ok: true,
  };
}
