import { listAgents, loadAgent } from "../agents/registry.ts";
import { runAgent, runAllAgents } from "../agents/runner.ts";

const HELP = `lfg agents — multi-agent insight runner

Usage:
  lfg agents list                 List agents (name, title, enabled)
  lfg agents run --all            Run every enabled agent (cron path)
  lfg agents run <name>           Run a single agent
  lfg agents run <name> --dry     Build the prompt only, don't call claude
  lfg agents show <name>          Print agent frontmatter + body
`;

export async function cmdAgents(args: string[]) {
  const [sub, ...rest] = args;
  switch (sub) {
    case "list":
      return cmdList();
    case "run":
      return cmdRun(rest);
    case "show":
      return cmdShow(rest);
    case undefined:
    case "help":
    case "-h":
    case "--help":
      console.log(HELP);
      return;
    default:
      console.error(`Unknown agents subcommand: ${sub}\n`);
      console.log(HELP);
      process.exit(1);
  }
}

async function cmdList() {
  const agents = await listAgents();
  if (!agents.length) {
    console.log("(no agents found — drop files in agents/<name>.md)");
    return;
  }
  for (const a of agents) {
    const enabled = a.frontmatter.enabled === false ? "OFF" : "on ";
    const title = a.frontmatter.title ?? "";
    const inputs = (a.frontmatter.inputs ?? []).map((i) => i.kind).join(",");
    console.log(`${enabled}  ${a.name.padEnd(18)}  ${title.padEnd(32)}  [${inputs}]`);
  }
}

async function cmdRun(args: string[]) {
  let all = false;
  let dryRun = false;
  let name: string | undefined;
  for (const a of args) {
    if (a === "--all") all = true;
    else if (a === "--dry" || a === "--dry-run") dryRun = true;
    else if (!a.startsWith("--")) name = a;
  }

  const log = (line: string) => console.error(line);

  if (all) {
    const results = await runAllAgents({ dryRun, onLog: log });
    console.log(JSON.stringify(results, null, 2));
    return;
  }
  if (!name) {
    console.error("Usage: lfg agents run <name>|--all\n");
    console.log(HELP);
    process.exit(1);
  }
  const r = await runAgent(name, { dryRun, onLog: log });
  console.log(JSON.stringify(r, null, 2));
}

async function cmdShow(args: string[]) {
  const [name] = args;
  if (!name) {
    console.error("Usage: lfg agents show <name>");
    process.exit(1);
  }
  const a = await loadAgent(name);
  console.log(JSON.stringify(a.frontmatter, null, 2));
  console.log("---");
  console.log(a.body);
}
