// The Claude Code mods in claude/mods/, installed through Claude Code's own
// plugin CLI from this clone as a folder marketplace (.claude-plugin/
// marketplace.json). Claude Code reads such plugins from the folder itself, so
// a git pull updates them with no reinstall. The installer adds the marketplace
// and installs whichever of config.json's mods are missing; `install --check`
// asks `claude plugin list` where each one is read from, which catches a mod
// still read from an old clone. Hosts without the claude CLI are skipped.
import { spawnSync } from "node:child_process";
import path from "node:path";

export const MARKETPLACE = "mexxi";

export function modFolder(checkout, mod) {
  return path.join(checkout, "claude/mods", mod);
}

// Runs the claude CLI and returns stdout, or null when it is not installed.
function claude(args, { env, cli }) {
  const result = spawnSync(cli, args, { env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  if (result.error?.code === "ENOENT") return null;
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${cli} ${args.join(" ")} failed: ${(result.stderr || result.stdout).trim()}`);
  }
  return result.stdout;
}

// What `install --check` reports and what an install would run.
export function planMods({ checkout, mods, env = process.env, cli = "claude" }) {
  const listed = claude(["plugin", "list", "--json"], { env, cli });
  if (listed === null) return { available: false, drift: [], marketplace: false, install: [], uninstall: [] };
  let plugins;
  try {
    plugins = JSON.parse(listed);
    if (!Array.isArray(plugins)) throw new Error("not an array");
  } catch (error) {
    throw new Error(`could not read \`${cli} plugin list --json\` (${error.message})`);
  }
  const ours = plugins.filter((plugin) => typeof plugin?.id === "string" && plugin.id.endsWith(`@${MARKETPLACE}`));
  const drift = [];
  const install = [];
  let marketplace = false;
  for (const mod of mods) {
    const entry = ours.find((plugin) => plugin.id === `${mod}@${MARKETPLACE}`);
    const expected = modFolder(checkout, mod);
    if (!entry) {
      drift.push(`claude: mod ${mod}@${MARKETPLACE} is not installed`);
      install.push(mod);
      marketplace = true;
    } else if (!entry.readFromFolder || path.resolve(entry.readFromFolder) !== expected) {
      drift.push(`claude: mod ${mod}@${MARKETPLACE} is read from ${entry.readFromFolder ?? entry.installPath ?? "an installed copy"}, not ${expected}`);
      marketplace = true;
    }
  }
  const uninstall = ours.filter((plugin) => !mods.includes(plugin.id.slice(0, -MARKETPLACE.length - 1))).map((plugin) => plugin.id);
  for (const id of uninstall) drift.push(`claude: mod ${id} is installed but not in config.json's mods`);
  return { available: true, drift, marketplace, install, uninstall };
}

// Adding the marketplace again points it at this clone when it was added
// from another one; plugins already installed from it follow.
export function applyMods(plan, { checkout, env = process.env, cli = "claude" }) {
  if (plan.marketplace) claude(["plugin", "marketplace", "add", checkout, "--json"], { env, cli });
  for (const mod of plan.install) claude(["plugin", "install", `${mod}@${MARKETPLACE}`, "--json"], { env, cli });
  for (const id of plan.uninstall) claude(["plugin", "uninstall", id, "--json"], { env, cli });
}
