// What the installer does for hares, which is opt-in (decision 0011): the
// `hares` link in ~/.local/bin and, on Linux with hares.service.systemdUserUnit,
// three systemd user units. The link is owned by where it points, like ibni's.
// The units are owned by a state file that records each path and the hash of
// what was written, so a unit mexxi did not write is a conflict and is never
// overwritten, and turning the feature off removes exactly what was recorded.
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdir, readFile, readlink, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { readJson } from "./host-hooks.mjs";

export const UNIT_HEADER = "# Managed by mexxi's installer. Edits are overwritten.";
// The units `systemctl enable --now` starts; the canary service runs from its timer.
const ENABLED_UNITS = ["hares.service", "hares-canary.timer"];
// hares was called segwi. The installer recorded those units and that link, so it retires them (decision 0003).
const LEGACY_ENABLED_UNITS = ["segwi.service", "segwi-canary.timer"];

const sha256 = (text) => createHash("sha256").update(text).digest("hex");

/** The `hares` command's link: [destination, source, host], as the installer's other links. */
export function haresLink({ bin, checkout, platform = process.platform }) {
  const executable = platform === "win32" ? "server.cmd" : "server.mjs";
  return [path.join(bin, platform === "win32" ? "hares.cmd" : "hares"), path.join(checkout, "scripts", "hares", executable), "shared"];
}

/** The link hares had as segwi: `segwi` in ~/.local/bin, pointing at scripts/segwi. Only ever retired, never made. */
export function legacySegwiLink({ bin, checkout, platform = process.platform }) {
  const executable = platform === "win32" ? "server.cmd" : "server.mjs";
  return [path.join(bin, platform === "win32" ? "segwi.cmd" : "segwi"), path.join(checkout, "scripts", "segwi", executable), "shared"];
}

/**
 * The link to retire when hares is off: the one that still points into this
 * checkout (or the one being migrated from). A `hares` that points anywhere else
 * is the user's own and stays. `wrapper` renders the Windows .cmd text.
 * `linkFor` names which link to look for: the current one, or the legacy segwi one.
 */
export async function retiredHaresLink({ bin, checkouts, platform = process.platform, wrapper, linkFor = haresLink }) {
  for (const checkout of checkouts) {
    const [destination, source] = linkFor({ bin, checkout, platform });
    try {
      if (platform === "win32") {
        if (await readFile(destination, "utf8") === wrapper(source.replace(/\.cmd$/, ".mjs"))) return destination;
      } else if (path.resolve(bin, await readlink(destination)) === source) return destination;
    } catch (error) {
      if (!["ENOENT", "EINVAL", "UNKNOWN", "EISDIR"].includes(error.code)) throw error;
    }
  }
  return null;
}

// systemd reads `%` and `$` in a command line, and splits it on spaces.
function unitArgument(value) {
  const escaped = value.replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("%", "%%").replaceAll("$", "$$");
  return /[\s"'\\;]/.test(value) ? `"${escaped}"` : escaped;
}

/**
 * The PATH the units run with, from the one the installer ran with. node's own
 * directory comes first, so the service finds the node it was installed with and
 * the CLIs npm put beside it. Relative entries are dropped, and so are those under
 * `transient` roots: the session's runtime directory (where fnm keeps a per-shell
 * link that dies with the shell) and git's exec path, which git puts in front
 * when the post-merge hook reinstalls. Either would make the unit differ from
 * one install to the next and restart hares for nothing.
 */
export function serviceSearchPath({ searchPath, nodePath, transient = [] }) {
  const roots = transient.filter(Boolean).map((root) => path.resolve(root));
  const isTransient = (directory) => roots.some((root) => directory === root || directory.startsWith(`${root}/`));
  const directories = [path.dirname(nodePath), ...(searchPath ?? "").split(":")]
    .filter((directory) => path.isAbsolute(directory) && !isTransient(path.resolve(directory)));
  return [...new Set(directories)].join(":");
}

/**
 * An `Environment=PATH=...` line, or none when there is no PATH. Unlike a command
 * line, systemd gives `$` no meaning here, but still expands `%` specifiers and
 * unquotes C-style, so the whole assignment is quoted. A directory with a
 * control character is dropped: systemd rejects the whole value otherwise.
 */
export function pathEnvironment(searchPath) {
  const directories = (searchPath ?? "").split(":").filter((directory) => directory && !/[\x00-\x1f\x7f]/.test(directory));
  if (!directories.length) return [];
  const value = `PATH=${directories.join(":")}`.replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("%", "%%");
  return [`Environment="${value}"`];
}

/**
 * The three unit files as [name, content]. `searchPath` is the PATH the
 * installer ran with: a user service otherwise gets systemd's bare default,
 * which misses a node, claude, gh or ibni installed under the home directory.
 */
export function renderUnits({ checkout, nodePath, searchPath }) {
  const server = path.join(checkout, "scripts", "hares", "server.mjs");
  const command = (subcommand) => [nodePath, server, subcommand].map(unitArgument).join(" ");
  const environment = ["Environment=NODE_ENV=production", ...pathEnvironment(searchPath)];
  return [
    ["hares.service", [
      UNIT_HEADER,
      "[Unit]",
      "Description=hares, the mexxi run launcher (web app and MCP server on loopback)",
      "After=network.target",
      "",
      "[Service]",
      `ExecStart=${command("serve")}`,
      "Restart=on-failure",
      "RestartSec=5",
      ...environment,
      "# Hardening that cannot get in the agent's way. Filesystem sandboxing (ProtectHome,",
      "# ProtectSystem, PrivateTmp) is left out on purpose: a run works with your own access,",
      "# as a session you start by hand does (decision 0016).",
      "NoNewPrivileges=yes",
      "LockPersonality=yes",
      "UMask=0077",
      "",
      "[Install]",
      "WantedBy=default.target",
      "",
    ].join("\n")],
    ["hares-canary.service", [
      UNIT_HEADER,
      "[Unit]",
      "Description=hares canary, a small real run that checks the coding agent still behaves as expected",
      "",
      "[Service]",
      "Type=oneshot",
      `ExecStart=${command("canary")}`,
      ...environment,
      "UMask=0077",
      "",
    ].join("\n")],
    ["hares-canary.timer", [
      UNIT_HEADER,
      "[Unit]",
      "Description=Run the hares canary every night",
      "",
      "[Timer]",
      "OnCalendar=*-*-* 03:30",
      "RandomizedDelaySec=15m",
      "Persistent=true",
      "",
      "[Install]",
      "WantedBy=timers.target",
      "",
    ].join("\n")],
  ];
}

async function readText(file) {
  try {
    return await readFile(file, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

/**
 * Works out the units without touching anything. `drift` is what --check
 * reports, `conflicts` stops an install, `write` and `remove` are what an
 * install does, `owned` is the state it records and `commands` the systemctl
 * calls around the file changes.
 */
export async function planUnits({ unitsDir, stateFile, legacyStateFile = path.join(path.dirname(stateFile), "segwi-units.json"), wanted, checkout, nodePath, searchPath }) {
  const state = await readJson(stateFile, "its state file");
  const recordedIn = (value) => (Array.isArray(value?.units) ? value.units.filter((unit) => typeof unit?.path === "string") : []);
  const recorded = recordedIn(state);
  // Units recorded under the old segwi name are retired and the state moves to stateFile.
  const legacyState = await readJson(legacyStateFile, "its legacy state file");
  const legacyRecorded = recordedIn(legacyState).filter((entry) => !recorded.some((known) => known.path === entry.path));
  const hasLegacyState = legacyState !== null && legacyState !== undefined;
  const desired = wanted
    ? renderUnits({ checkout, nodePath, searchPath }).map(([name, content]) => ({ name, path: path.join(unitsDir, name), content, sha256: sha256(content) }))
    : [];
  const drift = [];
  const conflicts = [];
  const write = [];
  const remove = [];
  const rewritten = [];
  for (const unit of desired) {
    const current = await readText(unit.path);
    const isRecorded = recorded.some((entry) => entry.path === unit.path);
    if (current === null) {
      drift.push(`${unit.path} is missing`);
      write.push(unit);
    } else if (!isRecorded) {
      conflicts.push(`${unit.path} exists and mexxi did not write it; move it aside or remove it`);
    } else if (sha256(current) !== unit.sha256) {
      drift.push(`${unit.path} differs from what mexxi renders`);
      write.push(unit);
      rewritten.push(unit.name);
    }
  }
  for (const entry of recorded) {
    if (desired.some((unit) => unit.path === entry.path)) continue;
    drift.push(`${entry.path} was added by mexxi and config.json no longer asks for it`);
    remove.push(entry);
  }
  for (const entry of legacyRecorded) {
    drift.push(`${entry.path} was added by mexxi as segwi, which is now hares`);
    remove.push(entry);
  }
  const owned = { units: desired.map(({ path: unitPath, sha256: hash }) => ({ path: unitPath, sha256: hash })) };
  const commands = [];
  const stopping = remove.map((entry) => path.basename(entry.path)).filter((name) => [...ENABLED_UNITS, ...LEGACY_ENABLED_UNITS].includes(name));
  if (stopping.length) commands.push(["disable", "--now", ...stopping]);
  if (write.length || remove.length) commands.push(["daemon-reload"]);
  if (write.length) commands.push(["enable", "--now", ...ENABLED_UNITS]);
  // enable --now leaves a unit that is already running on its old definition, so
  // one whose file changed is restarted. A fresh unit was just started, and the
  // canary service is a oneshot that its next run picks up after daemon-reload.
  const restarting = ENABLED_UNITS.filter((name) => rewritten.includes(name));
  if (restarting.length) commands.push(["restart", ...restarting]);
  return {
    drift, conflicts, write, remove, owned, commands, unitsDir, stateFile, legacyStateFile, hasLegacyState,
    stateChanged: hasLegacyState || JSON.stringify(owned.units) !== JSON.stringify(recorded.map(({ path: unitPath, sha256: hash }) => ({ path: unitPath, sha256: hash }))),
  };
}

/** `systemctl --user`, or a report that it is not there. Tests inject their own. */
export function userSystemctl(args) {
  const result = spawnSync("systemctl", ["--user", ...args], { encoding: "utf8" });
  if (result.error) return { available: result.error.code !== "ENOENT", status: null, stderr: result.error.message };
  return { available: true, status: result.status, stderr: result.stderr };
}

export const noSystemctl = () => ({ available: false, status: null, stderr: "" });

export const commandLine = (args) => `systemctl --user ${args.join(" ")}`;

/**
 * Applies a plan: stops what is going, records and writes the files, then asks
 * systemd to reload and start. systemd being absent or failing never fails the
 * install, because the files are already right; the result says what to run.
 */
export async function applyUnits(plan, { systemctl }) {
  const outcome = { commands: plan.commands.map(commandLine), systemctl: plan.commands.length ? "ran" : "none", failed: [] };
  let available = true;
  const run = (args) => {
    if (!available) return;
    const result = systemctl(args);
    if (!result.available) {
      available = false;
      outcome.systemctl = "missing";
    } else if (result.status !== 0) {
      outcome.systemctl = "failed";
      outcome.failed.push(`${commandLine(args)}: ${result.stderr.trim() || `exit ${result.status}`}`);
    }
  };
  for (const args of plan.commands.filter(([verb]) => verb === "disable")) run(args);
  // The state goes first: a file written after a crash is then still recorded, never an orphan.
  if (plan.stateChanged) {
    await mkdir(path.dirname(plan.stateFile), { recursive: true });
    await writeFile(plan.stateFile, `${JSON.stringify(plan.owned, null, 2)}\n`);
  }
  for (const entry of plan.remove) {
    try {
      await unlink(entry.path);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
  // Only now, with hares-units.json written and the old units gone, is the old state file done with.
  if (plan.hasLegacyState) {
    try {
      await unlink(plan.legacyStateFile);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
  if (plan.write.length) await mkdir(plan.unitsDir, { recursive: true });
  for (const unit of plan.write) await writeFile(unit.path, unit.content);
  for (const args of plan.commands.filter(([verb]) => verb !== "disable")) run(args);
  return outcome;
}
