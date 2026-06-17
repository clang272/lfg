import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

export const PATHS = {
  root: ROOT,
  data: join(ROOT, "data"),
  sessionTitles: join(ROOT, "data", "session-titles.json"),
};
