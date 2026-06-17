// Recover full URLs from a captured terminal pane. The live terminal reads its
// output off `tmux attach`, where a long URL is broken across rows — and not
// always as a tmux auto-wrap (Claude's TUI inserts its own breaks at the pane
// width), so `capture-pane -J` can't rejoin it. We reconstruct instead by
// stitching consecutive FULL-WIDTH rows together, which covers both auto-wrap
// and hard-wrap-at-width. As a bonus we also pull any OSC 8 hyperlink targets,
// which carry the whole URL in an escape sequence regardless of how it renders.

// RFC-3986-ish URL characters (plus %), used to walk a URL run within a row.
const URLCHAR = /[A-Za-z0-9\-._~:/?#[\]@!$&'()*+,;=%]/;
const TRAILING = /[.,;:!?]+$/;

function urlRunFrom(line: string, start: number): string {
  let r = "";
  for (let k = start; k < line.length; k++) {
    if (URLCHAR.test(line[k])) r += line[k];
    else break;
  }
  return r;
}

// Full URLs in `\x1b]8;;<url>\x07` / `\x1b]8;;<url>\x1b\\` hyperlink sequences.
export function osc8Urls(escaped: string): string[] {
  const out: string[] = [];
  const re = /\x1b\]8;;([^\x1b\x07]*)(?:\x07|\x1b\\)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(escaped))) {
    if (m[1] && /^https?:\/\//i.test(m[1])) out.push(m[1].replace(TRAILING, ""));
  }
  return out;
}

// Reconstruct URLs from a plain (no-escape) capture, joining wrapped rows.
// `width` is the pane width: a row whose URL run reaches the last column is
// treated as wrapped, so the next row's leading URL run is a continuation.
export function reconstructUrls(plain: string, width: number): string[] {
  const lines = plain.split("\n");
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    for (const s of lines[i].matchAll(/https?:\/\//g)) {
      const p = s.index ?? 0;
      let url = urlRunFrom(lines[i], p);
      // The run continues onto the next row only if it filled this row to the
      // edge (URL touches the last column of a full-width line).
      let atEdge = p + url.length === lines[i].length && lines[i].length >= width;
      let j = i;
      while (atEdge && j + 1 < lines.length) {
        const next = lines[j + 1];
        const cont = urlRunFrom(next, 0);
        if (!cont) break; // next row doesn't start with URL chars → not a continuation
        url += cont;
        // Keep going only if this continuation also filled the row to the edge.
        atEdge = cont.length === next.length && next.length >= width;
        j++;
      }
      out.push(url.replace(TRAILING, ""));
    }
  }
  return out;
}

// Combined, de-duplicated, OSC 8 (most reliable) first.
export function detectUrls(opts: {
  plain: string;
  escaped?: string;
  width: number;
}): string[] {
  const urls = [
    ...(opts.escaped ? osc8Urls(opts.escaped) : []),
    ...reconstructUrls(opts.plain, opts.width),
  ];
  const uniq = [...new Set(urls)];
  // Drop fragments: a URL that is a strict prefix of another detected URL is a
  // truncated-wrap artifact (we saw the same URL both whole and cut short), so
  // keep only the longer, more complete one.
  return uniq.filter((u) => !uniq.some((v) => v !== u && v.startsWith(u)));
}
