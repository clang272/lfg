import type { CollectorResult } from "./index.ts";

// Public, unauthenticated catalog of every model OpenRouter routes, with live
// per-token pricing. We project it to a compact $/1M table so the model-watch
// agent can diff it against our hardcoded SupportedModels without blowing up
// the prompt with the raw (huge) JSON.
const OR_MODELS_URL = "https://openrouter.ai/api/v1/models";

// Pricing in the OR response is a STRING of USD-per-token. Render it as a
// trimmed $/1M figure ("-" when the field is absent / zero so a missing
// cache-read rate is visually distinct from a real $0).
function perMillion(s: string | undefined): string {
  const n = Number(s);
  if (!isFinite(n) || n <= 0) return "-";
  const v = n * 1_000_000;
  const fixed = v >= 1 ? v.toFixed(2) : v.toPrecision(2);
  return "$" + fixed.replace(/(\.\d*?)0+$/, "$1").replace(/\.$/, "");
}

export async function collectOpenRouterModels(spec: {
  kind: "openrouter_models";
  // Case-insensitive substrings matched against id OR name; empty = all models.
  // Use to focus the table on the providers we route (deepseek, qwen, minimax,
  // z-ai, moonshotai, …) so the diff stays legible.
  filter?: string[];
  limit?: number;
}): Promise<CollectorResult> {
  let res: Response;
  try {
    res = await fetch(OR_MODELS_URL, { headers: { accept: "application/json" } });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return {
      title: "OpenRouter models",
      body: `(fetch threw: ${msg})`,
      ok: false,
      warning: msg,
    };
  }
  if (!res.ok) {
    return {
      title: "OpenRouter models",
      body: `(fetch failed: HTTP ${res.status} ${res.statusText})`,
      ok: false,
      warning: `HTTP ${res.status}`,
    };
  }

  const json = (await res.json()) as { data?: any[] };
  const all = json.data ?? [];
  let rows = all.map((m) => {
    const p = m.pricing ?? {};
    return {
      id: String(m.id ?? ""),
      name: String(m.name ?? m.id ?? ""),
      ctx: Number(m.context_length ?? 0) || 0,
      in: perMillion(p.prompt),
      out: perMillion(p.completion),
      cacheRead: perMillion(p.input_cache_read),
    };
  });

  const filt = (spec.filter ?? []).map((s) => s.toLowerCase()).filter(Boolean);
  if (filt.length) {
    rows = rows.filter((r) => {
      const hay = (r.id + " " + r.name).toLowerCase();
      return filt.some((f) => hay.includes(f));
    });
  }
  rows.sort((a, b) => a.id.localeCompare(b.id));

  const total = rows.length;
  const limit = spec.limit ?? 400;
  const shown = rows.slice(0, limit);

  const lines = shown.map(
    (r) =>
      `${r.id}\t${r.name}\tctx=${r.ctx}\tin=${r.in}/M\tout=${r.out}/M\tcacheRead=${r.cacheRead}/M`,
  );
  const body = [
    `*${shown.length}/${total} models${filt.length ? ` (filter: ${filt.join(", ")})` : ""} — live from ${OR_MODELS_URL}. Pricing is $/1M tokens; "-" = field absent.*`,
    "",
    "```",
    "id\tname\tcontext\tinput\toutput\tcache_read",
    ...lines,
    "```",
  ].join("\n");

  if (!shown.length) {
    return {
      title: "OpenRouter models",
      body: `(no models matched filter: ${filt.join(", ")})`,
      ok: false,
      warning: "no matches",
    };
  }

  return {
    title: `OpenRouter models (${shown.length}${total > shown.length ? ` of ${total}` : ""})`,
    body,
    ok: true,
  };
}
