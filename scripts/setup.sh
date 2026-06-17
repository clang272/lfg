#!/usr/bin/env bash
#
# lfg — one-command setup for a fresh VPS.
#
# Provisions Bun, tmux, git, the Claude CLI, clones lfg, joins your Tailscale
# tailnet, and runs the web UI as a systemd user service reachable ONLY over the
# tailnet (via `tailscale serve`, never the public internet).
#
# Brand-new VPS (run as a normal sudo user, NOT root):
#   curl -fsSL https://raw.githubusercontent.com/BennyKok/lfg/main/scripts/setup.sh | bash
#   # or non-interactively, with the Tailscale auth key supplied up front:
#   TS_AUTHKEY=tskey-auth-xxxx curl -fsSL https://raw.githubusercontent.com/BennyKok/lfg/main/scripts/setup.sh | bash
#
# Re-run / update after install:
#   lfg setup
#
# It is idempotent — safe to run repeatedly.

set -euo pipefail

# ---- config (override via env) ----
LFG_REPO_URL="${LFG_REPO_URL:-https://github.com/BennyKok/lfg.git}"
# Where prebuilt release tarballs live (GitHub "owner/repo"). Defaults align
# with LFG_REPO_URL but can be pointed at a fork.
LFG_REPO_SLUG="${LFG_REPO_SLUG:-BennyKok/lfg}"
LFG_DIR="${LFG_DIR:-$HOME/lfg}"
LFG_REPOS_ROOT="${LFG_REPOS_ROOT:-$HOME/repos}"
LFG_PORT="${LFG_PORT:-8766}"
TS_AUTHKEY="${TS_AUTHKEY:-}"
SERVICE="lfg"
# Install source:
#   release (default) — download the bundled tarball (vendored node_modules incl.
#                       the private "vibes" AI-SDK provider). No registry install.
#   source            — git clone + `bun install` (for development / forks that
#                       can resolve the private provider themselves).
LFG_INSTALL_MODE="${LFG_INSTALL_MODE:-release}"
# Which release to pull in release mode: "latest" or a tag like v0.1.0.
LFG_RELEASE="${LFG_RELEASE:-latest}"

say()  { printf '\033[1;36m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[!]\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[1;31m[x]\033[0m %s\n' "$*" >&2; exit 1; }

on_err() { die "setup failed at line $1. Fix the issue above and re-run — it resumes safely."; }
trap 'on_err $LINENO' ERR

# ---- preflight ----
[ "$(id -u)" -eq 0 ] && die "Run as a normal sudo-capable user, not root — agents must not run as root."
command -v sudo >/dev/null   || die "sudo is required."
command -v apt-get >/dev/null || die "This script targets Debian/Ubuntu (apt-get not found)."
command -v systemctl >/dev/null || die "systemd (systemctl) is required."

# If invoked from inside an existing lfg checkout (i.e. via `lfg setup`), use it.
SCRIPT_SRC="${BASH_SOURCE[0]:-}"
if [ -n "$SCRIPT_SRC" ] && [ -f "$SCRIPT_SRC" ]; then
  MAYBE_ROOT="$(cd "$(dirname "$SCRIPT_SRC")/.." && pwd)"
  if [ -f "$MAYBE_ROOT/package.json" ] && grep -q '"name": *"lfg"' "$MAYBE_ROOT/package.json" 2>/dev/null; then
    LFG_DIR="$MAYBE_ROOT"
  fi
fi

ensure_path_line() { # append a line to ~/.bashrc once
  grep -qxF "$1" "$HOME/.bashrc" 2>/dev/null || echo "$1" >> "$HOME/.bashrc"
}

# ---- 1. base packages ----
say "Installing base packages (git, tmux, curl, jq)…"
sudo apt-get update -y -qq
sudo apt-get install -y -qq git tmux curl ca-certificates jq

# ---- 2. Bun ----
if ! command -v bun >/dev/null 2>&1; then
  say "Installing Bun…"
  curl -fsSL https://bun.sh/install | bash
fi
export PATH="$HOME/.bun/bin:$PATH"
ensure_path_line 'export PATH="$HOME/.bun/bin:$PATH"'
command -v bun >/dev/null || die "Bun install did not land on PATH."

# ---- 3. agent CLIs (claude / codex / opencode) ----
# The release bundle ships NO vendored agent binaries — lfg drives whatever
# `claude` / `codex` / `opencode` it finds on PATH (override via LFG_*_PATH).
# Claude is required (default agent); codex + opencode are optional/best-effort.
if ! command -v claude >/dev/null 2>&1; then
  say "Installing the Claude CLI…"
  curl -fsSL https://claude.ai/install.sh | bash
fi
export PATH="$HOME/.local/bin:$PATH"
ensure_path_line 'export PATH="$HOME/.local/bin:$PATH"'

# Optional runtimes — install globally via bun (lands in ~/.bun/bin, already on
# PATH). Best-effort: a failure just means that agent kind is unavailable.
if [ "${LFG_INSTALL_CODEX:-1}" = "1" ] && ! command -v codex >/dev/null 2>&1; then
  say "Installing the Codex CLI (optional)…"
  bun add -g @openai/codex >/dev/null 2>&1 || warn "codex install failed — the 'codex' agent kind will be unavailable."
fi
if [ "${LFG_INSTALL_OPENCODE:-1}" = "1" ] && ! command -v opencode >/dev/null 2>&1; then
  say "Installing OpenCode (optional)…"
  bun add -g opencode-ai >/dev/null 2>&1 || warn "opencode install failed — the 'opencode' agent kind will be unavailable."
fi

# ---- 4. fetch lfg (bundled release tarball, or git clone for dev) ----
# A git checkout always wins — `lfg setup` from inside a dev clone updates via
# git, never clobbering it with a release tarball.
if [ -d "$LFG_DIR/.git" ]; then
  LFG_INSTALL_MODE="source"
fi

if [ "$LFG_INSTALL_MODE" = "source" ]; then
  if [ -d "$LFG_DIR/.git" ]; then
    say "Updating lfg at $LFG_DIR (git)…"
    git -C "$LFG_DIR" pull --ff-only || warn "git pull skipped (local changes?)"
  else
    say "Cloning lfg into $LFG_DIR (git)…"
    git clone "$LFG_REPO_URL" "$LFG_DIR"
  fi
  # The web UI ships prebuilt in web/dist, so no web build is needed here.
  say "Installing dependencies…"
  ( cd "$LFG_DIR" && bun install )
else
  # Release mode: download the self-contained tarball (vendored node_modules,
  # incl. the private "vibes" AI-SDK provider that isn't on the public registry)
  # and extract it over $LFG_DIR. No `bun install` — nothing to resolve.
  ASSET="lfg-linux-x64.tar.gz"
  if [ "$LFG_RELEASE" = "latest" ]; then
    URL="https://github.com/$LFG_REPO_SLUG/releases/latest/download/$ASSET"
  else
    URL="https://github.com/$LFG_REPO_SLUG/releases/download/$LFG_RELEASE/$ASSET"
  fi
  say "Downloading bundled release ($LFG_RELEASE) from $LFG_REPO_SLUG…"
  TMP_TGZ="$(mktemp --suffix=.tar.gz)"
  curl -fSL "$URL" -o "$TMP_TGZ" || die "Could not download $URL — check the tag, or use LFG_INSTALL_MODE=source."
  # Verify the checksum when the release ships one (best-effort).
  if curl -fsSL "$URL.sha256" -o "$TMP_TGZ.sha256" 2>/dev/null; then
    EXPECTED="$(awk '{print $1}' "$TMP_TGZ.sha256")"
    ACTUAL="$(sha256sum "$TMP_TGZ" | awk '{print $1}')"
    [ "$EXPECTED" = "$ACTUAL" ] || die "Checksum mismatch for $ASSET — refusing to install."
    say "Checksum verified."
  fi
  mkdir -p "$LFG_DIR"
  # Strip the leading lfg/ dir; leaves $LFG_DIR/.env and data/ (not in the tarball) intact.
  say "Extracting into $LFG_DIR…"
  tar -xzf "$TMP_TGZ" -C "$LFG_DIR" --strip-components=1
  rm -f "$TMP_TGZ" "$TMP_TGZ.sha256"
fi

# ---- 6. expose the `lfg` command on PATH ----
mkdir -p "$HOME/.local/bin"
ln -sf "$LFG_DIR/src/cli.ts" "$HOME/.local/bin/lfg"
chmod +x "$LFG_DIR/src/cli.ts" 2>/dev/null || true

# ---- 7. .env (never overwrite an existing one) ----
if [ ! -f "$LFG_DIR/.env" ]; then
  say "Creating .env from .env.example…"
  cp "$LFG_DIR/.env.example" "$LFG_DIR/.env"
fi
seed_env() { grep -q "^$1=" "$LFG_DIR/.env" || echo "$1=$2" >> "$LFG_DIR/.env"; }
seed_env LFG_HOST 127.0.0.1
seed_env LFG_PORT "$LFG_PORT"
seed_env LFG_REPOS_ROOT "$LFG_REPOS_ROOT"
chmod 600 "$LFG_DIR/.env"
mkdir -p "$LFG_REPOS_ROOT"

# ---- 8. Tailscale ----
if ! command -v tailscale >/dev/null 2>&1; then
  say "Installing Tailscale…"
  curl -fsSL https://tailscale.com/install.sh | sh
fi
if ! tailscale status >/dev/null 2>&1; then
  say "Joining your tailnet…"
  if [ -z "$TS_AUTHKEY" ]; then
    if [ -t 0 ]; then
      read -rsp "Tailscale auth key (tskey-auth-…): " TS_AUTHKEY; echo
    else
      die "No tailnet session and no TTY. Re-run with TS_AUTHKEY=tskey-auth-… prefixed."
    fi
  fi
  sudo tailscale up --authkey "$TS_AUTHKEY" --ssh
  unset TS_AUTHKEY
fi

# ---- 9. systemd user service ----
say "Installing the systemd user service ($SERVICE)…"
UNIT_DIR="$HOME/.config/systemd/user"
mkdir -p "$UNIT_DIR"
cat > "$UNIT_DIR/$SERVICE.service" <<UNIT
[Unit]
Description=lfg — self-hosted AI coding agent control plane
After=network-online.target tailscaled.service
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=$LFG_DIR
EnvironmentFile=$LFG_DIR/.env
# claude/codex must resolve when spawned into tmux panes (see src/tmux.ts).
Environment=PATH=$HOME/.local/bin:$HOME/.bun/bin:/usr/local/bin:/usr/bin:/bin
# Hard-bind to loopback so a stale .env can never expose the UI publicly.
Environment=LFG_HOST=127.0.0.1
ExecStart=$HOME/.bun/bin/bun run $LFG_DIR/src/cli.ts serve
Restart=on-failure
RestartSec=3
# The tmux server that holds every Claude session is spawned by serve, so it
# lives in this unit's cgroup. With the default KillMode=control-group a restart
# (every deploy) SIGKILLs the whole cgroup — wiping all running sessions. Kill
# only the main bun process so tmux and the sessions survive a redeploy.
KillMode=process

[Install]
WantedBy=default.target
UNIT

# Keep the user manager (and tmux + lfg serve) alive across logout/reboot.
sudo loginctl enable-linger "$USER"
systemctl --user daemon-reload
systemctl --user enable --now "$SERVICE.service"

# ---- 10. expose the UI over the tailnet (HTTPS on MagicDNS), never publicly ----
say "Configuring tailscale serve → 127.0.0.1:$LFG_PORT…"
sudo tailscale serve --bg --https=443 "http://127.0.0.1:$LFG_PORT" || \
  warn "tailscale serve failed — enable HTTPS/MagicDNS in the Tailscale admin console, then re-run."

# ---- done ----
URL="$(tailscale status --json 2>/dev/null | jq -r '.Self.DNSName' | sed 's/\.$//' || true)"
echo
say "Done. lfg is running as a systemd user service."
[ -n "${URL:-}" ] && echo "    Web UI (tailnet only):  https://$URL"
cat <<NEXT

Next steps:
  1. Authenticate Claude once (interactive, one-time):
       claude            # complete the browser OAuth, or set ANTHROPIC_API_KEY in $LFG_DIR/.env
  2. Edit $LFG_DIR/.env for optional integrations (WhatsApp, GitHub token, etc.).
  3. Restart after any change:  systemctl --user restart $SERVICE
  4. Logs:                      journalctl --user -u $SERVICE -f

The UI is reachable only from devices on your tailnet. Do NOT open port $LFG_PORT
or 443 to the public internet — Tailscale handles ingress over WireGuard.
NEXT
