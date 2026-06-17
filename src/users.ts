// Lightweight multi-user tagging for sessions. There's no auth — this is a
// personal Tailscale tool — it's just a way to split the session list between
// people sharing the box. The *current* user is a per-browser choice
// (localStorage, picked on first visit); the session→user assignments live here
// server-side so they're shared across tabs/devices.
//
// Assignments are keyed by the tmux session NAME, not the sessionId: the name
// is stable, while /clear rotates the sessionId — keying on the name keeps a
// tag attached to the same terminal across clears.
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname } from "node:path";
import { PATHS } from "./config.ts";

// Fixed roster for now — add emails here to grow it.
export const USERS = (process.env.LFG_USERS ?? "")
  .split(",")
  .map((e) => e.trim())
  .filter(Boolean);

// Gravatar avatar URL for an email — shows the user's real photo if they have a
// Gravatar, else a deterministic per-email identicon. MD5 is computed here
// (the browser has no MD5) and the roster is served with avatars baked in.
export function gravatar(email: string): string {
  const h = createHash("md5").update(email.trim().toLowerCase()).digest("hex");
  return `https://www.gravatar.com/avatar/${h}?d=identicon&s=80`;
}

export function userRoster(): { email: string; avatar: string }[] {
  return USERS.map((email) => ({ email, avatar: gravatar(email) }));
}

const FILE = `${PATHS.data}/session-users.json`;

function readAll(): Record<string, string> {
  try {
    return JSON.parse(readFileSync(FILE, "utf8")) as Record<string, string>;
  } catch {
    return {};
  }
}

function writeAll(all: Record<string, string>): void {
  mkdirSync(dirname(FILE), { recursive: true });
  writeFileSync(FILE, JSON.stringify(all, null, 2));
}

// tmuxName → userEmail (only assigned names present).
export function userAssignments(): Record<string, string> {
  return readAll();
}

// Assign (or, with user=null, clear) the tag for a tmux session name. Unknown
// emails are rejected so a typo can't strand a session under a phantom user.
export function assignUser(tmuxName: string, user: string | null): boolean {
  if (user && !USERS.includes(user)) return false;
  const all = readAll();
  if (user) all[tmuxName] = user;
  else delete all[tmuxName];
  writeAll(all);
  return true;
}
