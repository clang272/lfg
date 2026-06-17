import type { CollectorResult } from "./index.ts";
import { fetchMain, listFilesAtMain, readFileAtMain } from "./git-fresh.ts";

export async function collectRepoFiles(spec: {
  kind: "repo_files";
  repo?: string;
  globs: string[];
  max_files?: number;
  max_bytes_per_file?: number;
  max_total_bytes?: number;
}): Promise<CollectorResult> {
  const root = spec.repo ?? process.env.LFG_REPO ?? process.cwd();
  const maxFiles = spec.max_files ?? 25;
  const maxBytes = spec.max_bytes_per_file ?? 8000;
  const maxTotal = spec.max_total_bytes ?? 160_000;

  // Read from fresh `origin/main`, NOT the working tree — the box keeps stale
  // worktrees that would otherwise make the agent diff days-old code.
  const fetched = fetchMain(root);

  const files = listFilesAtMain(root, spec.globs).sort();
  if (!files.length) {
    return {
      title: `Repo files (${root}@origin/main)`,
      body: `(no matches at origin/main for: ${spec.globs.join(", ")})`,
      ok: false,
      warning: fetched.ok ? "no glob matches" : fetched.warning,
    };
  }
  const matchedCount = files.length;

  const included: { path: string; size: number; truncated: boolean; body: string }[] = [];
  let totalBytes = 0;
  for (const rel of files) {
    if (included.length >= maxFiles) break;
    let body = readFileAtMain(root, rel);
    if (body == null) continue;
    const size = Buffer.byteLength(body);
    if (size > maxBytes * 4) continue; // skip huge files entirely
    const truncated = body.length > maxBytes;
    if (truncated) body = body.slice(0, maxBytes) + "\n… (truncated)";
    if (totalBytes + body.length > maxTotal) break;
    totalBytes += body.length;
    included.push({ path: rel, size, truncated, body });
  }

  const parts: string[] = [];
  parts.push(`*${included.length} files (${matchedCount} matched) at origin/main, ~${Math.round(totalBytes / 1024)} kB total*`);
  if (!fetched.ok) parts.push(`> ⚠️ ${fetched.warning} — origin/main may be behind GitHub.`);
  parts.push("");
  for (const f of included) {
    const ext = (f.path.split(".").pop() ?? "").toLowerCase();
    const lang = ({ ts: "ts", tsx: "tsx", js: "js", jsx: "jsx", css: "css", json: "json", md: "md" } as Record<string, string>)[ext] ?? "";
    parts.push(`### \`${f.path}\` (${f.size} bytes${f.truncated ? ", truncated" : ""})`);
    parts.push("```" + lang);
    parts.push(f.body);
    parts.push("```");
    parts.push("");
  }

  return {
    title: `Repo files — ${spec.globs.join(", ")} (${included.length}) @origin/main`,
    body: parts.join("\n"),
    ok: true,
    warning: fetched.ok ? undefined : fetched.warning,
  };
}
