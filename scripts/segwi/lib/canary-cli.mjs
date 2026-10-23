// `segwi canary [--config <file>] [--state-dir <dir>] [--data-dir <dir>] [--save-stream <file>]`:
// one line on stdout when the host passes, one line on stderr and a non-zero
// exit when it does not. The nightly timer runs it without --save-stream.
import path from "node:path";
import { runCanary } from "./canary.mjs";
import { dataDir as defaultDataDir, stateDir as defaultStateDir } from "./paths.mjs";
import { readSettings } from "./settings.mjs";

const USAGE = "usage: segwi canary [--config <file>] [--state-dir <dir>] [--data-dir <dir>] [--save-stream <file>]";
const FLAGS = { "--config": "config", "--state-dir": "stateDir", "--data-dir": "dataDir", "--save-stream": "saveStream" };

function flagsFrom(args) {
  const flags = {};
  for (let index = 0; index < args.length; index += 2) {
    const [name, value] = [args[index], args[index + 1]];
    if (!Object.hasOwn(FLAGS, name) || !value) throw new Error(USAGE);
    flags[FLAGS[name]] = path.resolve(value);
  }
  return flags;
}

/**
 * @param {string[]} args the arguments after `canary`
 * @param {{ stdout?: object, stderr?: object, host?: object, waits?: object, pushOptions?: object }} [io] `host`, `waits` and `pushOptions` are for tests
 */
export async function runCanaryCommand(args, { stdout = process.stdout, stderr = process.stderr, host, waits, pushOptions } = {}) {
  let flags;
  let settings;
  try {
    flags = flagsFrom(args);
    settings = await readSettings(flags.config ? { file: flags.config } : {});
  } catch (error) {
    stderr.write(`segwi: ${error.message}\n`);
    process.exitCode = 2;
    return null;
  }
  const state = await runCanary({
    settings, stateDir: flags.stateDir ?? defaultStateDir(), dataDir: flags.dataDir ?? defaultDataDir(), saveStream: flags.saveStream, host, waits, pushOptions,
  });
  if (state.ok) {
    stdout.write(`segwi canary: ok with Claude Code ${state.hostVersion} in ${Math.round(state.durationMs / 1000)} s\n`);
  } else {
    stderr.write(`segwi canary: failed with Claude Code ${state.hostVersion ?? "(version unknown)"}: ${state.problem}\n`);
    process.exitCode = 1;
  }
  return state;
}
