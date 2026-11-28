// Loads, validates and defaults ~/.config/mexxi/config.json against
// config.schema.json. Shared by the installer and ibni, so
// both read paths from one place. The validator covers only the JSON Schema
// subset config.schema.json uses; config.test.mjs fails if the schema reaches
// for a keyword this file does not understand.
import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const schemaFile = fileURLToPath(new URL("../../config.schema.json", import.meta.url));
// `why` and `scope` are annotations for the docs, like `description`: the
// problem a group solves, and who it applies to.
export const supportedKeywords = new Set([
  "$schema", "title", "description", "why", "scope", "type", "properties", "additionalProperties",
  "items", "enum", "pattern", "minimum", "maximum", "minLength", "default", "deprecated",
]);

export class ConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = "ConfigError";
  }
}

let cachedSchema;
export async function loadSchema() {
  cachedSchema ??= JSON.parse(await readFile(schemaFile, "utf8"));
  return cachedSchema;
}

// MEXXI_CONFIG lets tests and second installations use another file.
export function configPath({ env = process.env, home = os.homedir() } = {}) {
  return env.MEXXI_CONFIG ? path.resolve(env.MEXXI_CONFIG) : path.join(home, ".config", "mexxi", "config.json");
}

function typeOf(value) {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (Number.isInteger(value)) return "integer";
  return typeof value;
}

export function validate(value, schema, at = "config") {
  const errors = [];
  const types = [schema.type].flat().filter(Boolean);
  const actual = typeOf(value);
  if (types.length && !types.includes(actual) && !(actual === "integer" && types.includes("number"))) {
    return [`${at}: expected ${types.join(" or ")}, got ${actual}`];
  }
  if (schema.enum && !schema.enum.includes(value)) errors.push(`${at}: expected one of ${schema.enum.join(", ")}`);
  if (typeof value === "string") {
    if (schema.pattern && !new RegExp(schema.pattern, "u").test(value)) errors.push(`${at}: does not match ${schema.pattern}`);
    if (schema.minLength !== undefined && value.length < schema.minLength) errors.push(`${at}: shorter than ${schema.minLength}`);
  }
  if (typeof value === "number" && schema.minimum !== undefined && value < schema.minimum) {
    errors.push(`${at}: below ${schema.minimum}`);
  }
  if (typeof value === "number" && schema.maximum !== undefined && value > schema.maximum) {
    errors.push(`${at}: above ${schema.maximum}`);
  }
  if (actual === "array" && schema.items) {
    value.forEach((item, index) => errors.push(...validate(item, schema.items, `${at}[${index}]`)));
  }
  if (actual === "object") {
    for (const [key, item] of Object.entries(value)) {
      const property = schema.properties?.[key];
      if (property) errors.push(...validate(item, property, `${at}.${key}`));
      else if (schema.additionalProperties === false) errors.push(`${at}.${key}: unknown key`);
      // A map of free-form keys (forge.hosts) gives each value one schema.
      else if (typeof schema.additionalProperties === "object") errors.push(...validate(item, schema.additionalProperties, `${at}.${key}`));
    }
  }
  return errors;
}

// Objects merge key by key so a user sets only what differs; arrays and
// scalars, including an explicit null, replace the default.
export function withDefaults(value, schema) {
  if (schema.type !== "object" || !schema.properties) return value === undefined ? structuredClone(schema.default) : value;
  const result = {};
  for (const [key, property] of Object.entries(schema.properties)) {
    // A deprecated alias is read by withHaresKey and never takes a default of its own.
    if (key === "$schema" || property.deprecated) continue;
    result[key] = withDefaults(value?.[key], property);
  }
  return result;
}

export function expandHome(value, home = os.homedir()) {
  if (value === "~") return home;
  return value.startsWith("~/") ? path.join(home, value.slice(2)) : value;
}

export function abbreviateHome(value, home = os.homedir()) {
  const relative = path.relative(home, value);
  return relative && !relative.startsWith("..") && !path.isAbsolute(relative) ? `~/${relative.split(path.sep).join("/")}` : value;
}

// Keys hares's sandbox and permission modes used, retired by decision 0016. For one release a config that still
// names them loads: they are dropped before validation, and hares warns about each (see hares/lib/settings.mjs).
// Remove this shim, and let the schema refuse them again, after 2026-12-01.
const RETIRED_HARES_KEYS = ["permissions", "mcpPermissions", "branchPrefixes", "allowUnsandboxed", "allowedDomains"];
const RETIRED_REPOSITORY_KEYS = ["permissions", "allowedDomains"];
// segwi's own runner, its model, the nightly canary and the run timeouts, retired when herdr became the source of
// sessions (decision 0028): ħares drives the Claude Code sessions you have, so there is no runner to configure and
// no run to time out. The same shim: an old config loads, and the installer names each key to delete.
const RETIRED_HERDR_ERA_KEYS = ["runner", "model", "canary"];
const RETIRED_LIMIT_KEYS = ["maxTurns", "idleTimeoutMinutes", "hardTimeoutMinutes", "approvalTimeoutMinutes"];

const isObject = (value) => typeof value === "object" && value !== null && !Array.isArray(value);
const omit = (value, keys) => Object.fromEntries(Object.entries(value).filter(([key]) => !keys.includes(key)));

// Jev triage and cross-family review, retired by decision 0022. The same shim applies: an old config still
// loads, the keys are dropped, and the installer names each one to delete. Remove after 2027-01-15.
const RETIRED_MODEL_KEYS = ["crossFamilyReviewer"];

// hares was called segwi before it was renamed. For now the old `segwi` key still loads, as an alias of
// `hares`, with a one-time notice; setting both is ambiguous, so it is an error.
let noticePrinted = false;
export function withHaresKey(value, source = "config") {
  if (!isObject(value) || !("segwi" in value)) return value;
  if ("hares" in value) {
    throw new ConfigError(`${source} is invalid:\nconfig.segwi: \"segwi\" is the old name of \"hares\" and both are set; delete the segwi key`);
  }
  if (!noticePrinted) {
    noticePrinted = true;
    process.stderr.write(`mexxi: ${source} uses the deprecated "segwi" key. Rename the segwi key in config.json to hares.\n`);
  }
  const { segwi, ...rest } = value;
  return { ...rest, hares: segwi };
}

function withoutRetiredHaresKeys(value, retired) {
  // A file that still uses the old segwi key is told the paths under that key, which is what it must edit.
  const name = isObject(value) && !("hares" in value) && "segwi" in value ? "segwi" : "hares";
  const hares = isObject(value) ? value[name] : undefined;
  if (!isObject(hares)) return value;
  const before = retired.length;
  retired.push(...[...RETIRED_HARES_KEYS, ...RETIRED_HERDR_ERA_KEYS].filter((key) => key in hares).map((key) => `${name}.${key}`));
  const limits = isObject(hares.limits) ? omit(hares.limits, RETIRED_LIMIT_KEYS) : hares.limits;
  if (isObject(hares.limits)) retired.push(...RETIRED_LIMIT_KEYS.filter((key) => key in hares.limits).map((key) => `${name}.limits.${key}`));
  const repositories = Array.isArray(hares.repositories) ? hares.repositories.map((repository, index) => {
    if (!isObject(repository)) return repository;
    retired.push(...RETIRED_REPOSITORY_KEYS.filter((key) => key in repository).map((key) => `${name}.repositories[${index}].${key}`));
    return omit(repository, RETIRED_REPOSITORY_KEYS);
  }) : hares.repositories;
  if (retired.length === before) return value;
  return { ...value, [name]: { ...omit(hares, [...RETIRED_HARES_KEYS, ...RETIRED_HERDR_ERA_KEYS]), ...(repositories ? { repositories } : {}), ...(limits ? { limits } : {}) } };
}

function withoutRetiredReviewKeys(value, retired) {
  if (!isObject(value)) return value;
  let result = value;
  if ("jev" in result) {
    retired.push("jev");
    result = omit(result, ["jev"]);
  }
  if (!isObject(result.models)) return result;
  const models = { ...result.models };
  for (const [host, roles] of Object.entries(models)) {
    if (!isObject(roles)) continue;
    const found = RETIRED_MODEL_KEYS.filter((key) => key in roles);
    if (!found.length) continue;
    retired.push(...found.map((key) => `models.${host}.${key}`));
    models[host] = omit(roles, found);
  }
  return { ...result, models };
}

// The command fixer and its glob switch, retired by decision 0021: the guard now refuses unquoted globs on every
// host. Same shim and removal date as the review keys above.
function withoutRetiredCommandFixerKeys(value, retired) {
  if (!isObject(value)) return value;
  let result = value;
  if (isObject(result.guard) && "blockUnquotedGlobs" in result.guard) {
    retired.push("guard.blockUnquotedGlobs");
    result = { ...result, guard: omit(result.guard, ["blockUnquotedGlobs"]) };
  }
  if (Array.isArray(result.mods) && result.mods.includes("command-fixer")) {
    retired.push('mods: "command-fixer"');
    result = { ...result, mods: result.mods.filter((mod) => mod !== "command-fixer") };
  }
  return result;
}

/** The retired keys `value` still sets, as paths to delete, and `value` without them. */
export function withoutRetiredKeys(value) {
  const retired = [];
  const cleaned = withoutRetiredCommandFixerKeys(withoutRetiredReviewKeys(withoutRetiredHaresKeys(value, retired), retired), retired);
  return { value: retired.length ? cleaned : value, retired };
}

export async function resolveConfig(input, { home = os.homedir(), source = "config" } = {}) {
  const schema = await loadSchema();
  const { value } = withoutRetiredKeys(withHaresKey(input, source));
  const errors = validate(value, schema);
  if (errors.length) throw new ConfigError(`${source} is invalid:\n${errors.join("\n")}`);
  const config = withDefaults(value, schema);
  // The schema checks each bound alone; only together, after defaults, can
  // they describe an empty range.
  const { first, last } = config.workflow.ports;
  if (first > last) throw new ConfigError(`${source} is invalid:\nconfig.workflow.ports: first (${first}) is above last (${last})`);
  const { blockSize } = config.workflow.ports;
  if (last - first + 1 < blockSize) throw new ConfigError(`${source} is invalid:\nconfig.workflow.ports: ${first} to ${last} cannot hold one block of ${blockSize}`);
  for (const [repository, variables] of Object.entries(config.workflow.portVariables)) {
    for (const [name, offset] of Object.entries(variables)) {
      if (offset >= blockSize) throw new ConfigError(`${source} is invalid:\nconfig.workflow.portVariables.${repository}.${name}: offset ${offset} is outside a block of ${blockSize}`);
    }
  }
  config.paths.checkout = path.resolve(expandHome(config.paths.checkout, home));
  config.paths.worktreeRoot = path.resolve(expandHome(config.paths.worktreeRoot, home));
  config.retro.output = path.resolve(config.paths.checkout, expandHome(config.retro.output, home));
  // null leaves the browser to Playwright, so it stays null.
  if (config.browser.executablePath !== null) config.browser.executablePath = path.resolve(expandHome(config.browser.executablePath, home));
  config.browser.outputDir = path.resolve(expandHome(config.browser.outputDir ?? config.paths.worktreeRoot, home));
  return config;
}

// A missing file means every default applies; the installer is what writes it.
export async function loadConfig({ file = configPath(), home = os.homedir() } = {}) {
  let text;
  try {
    text = await readFile(file, "utf8");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    return { file, exists: false, config: await resolveConfig({}, { home, source: file }), retired: [] };
  }
  let value;
  try {
    value = JSON.parse(text);
  } catch (error) {
    throw new ConfigError(`${file} is not valid JSON: ${error.message}`);
  }
  // Retired keys are named as the file spells them (segwi.runner in a file still on the old key).
  return { file, exists: true, config: await resolveConfig(value, { home, source: file }), retired: withoutRetiredKeys(value).retired };
}

// What the installer writes on first run: only where the clone is, so every
// other key keeps tracking the schema's defaults.
export function minimalConfig({ checkout, home = os.homedir() }) {
  return {
    $schema: path.join(checkout, "config.schema.json"),
    paths: { checkout: abbreviateHome(path.resolve(checkout), home) },
  };
}
