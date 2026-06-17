import { join } from "node:path";
import { PATHS } from "../config.ts";

// `lfg setup` — thin wrapper that runs the idempotent bootstrap script from the
// cloned repo. On a brand-new VPS you instead curl|bash the same script (it then
// installs Bun + lfg and you can re-run via `lfg setup` afterwards).
export async function cmdSetup(args: string[]): Promise<void> {
  const script = join(PATHS.root, "scripts", "setup.sh");
  const proc = Bun.spawn(["bash", script, ...args], {
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
    env: { ...process.env },
  });
  const code = await proc.exited;
  if (code !== 0) process.exit(code);
}
