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
  "items", "enum", "pattern", "minimum", "maximum", "minLength", "default",
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
    if (key === "$schema") continue;
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

// Keys segwi's sandbox and permission modes used, retired by decision 0016. For one release a config that still
// names them loads: they are dropped before validation, and segwi warns about each (see segwi/lib/settings.mjs).
// Remove this shim, and let the schema refuse them again, after 2026-12-01.
const RETIRED_SEGWI_KEYS = ["permissions", "mcpPermissions", "branchPrefixes", "allowUnsandboxed", "allowedDomains"];
const RETIRED_REPOSITORY_KEYS = ["permissions", "allowedDomains"];

const isObject = (value) => typeof value === "object" && value !== null && !Array.isArray(value);
const omit = (value, keys) => Object.fromEntries(Object.entries(value).filter(([key]) => !keys.includes(key)));

/** The retired keys `value` still sets, as paths to delete, and `value` without them. */
export function withoutRetiredKeys(value) {
  const segwi = isObject(value) ? value.segwi : undefined;
  if (!isObject(segwi)) return { value, retired: [] };
  const retired = RETIRED_SEGWI_KEYS.filter((key) => key in segwi).map((key) => `segwi.${key}`);
  const repositories = Array.isArray(segwi.repositories) ? segwi.repositories.map((repository, index) => {
    if (!isObject(repository)) return repository;
    retired.push(...RETIRED_REPOSITORY_KEYS.filter((key) => key in repository).map((key) => `segwi.repositories[${index}].${key}`));
    return omit(repository, RETIRED_REPOSITORY_KEYS);
  }) : segwi.repositories;
  if (!retired.length) return { value, retired };
  return { value: { ...value, segwi: { ...omit(segwi, RETIRED_SEGWI_KEYS), ...(repositories ? { repositories } : {}) } }, retired };
}

export async function resolveConfig(input, { home = os.homedir(), source = "config" } = {}) {
  const schema = await loadSchema();
  const { value } = withoutRetiredKeys(input);
  const errors = validate(value, schema);
  if (errors.length) throw new ConfigError(`${source} is invalid:\n${errors.join("\n")}`);
  const config = withDefaults(value, schema);
  // The schema checks each bound alone; only together, after defaults, can
  // they describe an empty range.
  const { first, last } = config.workflow.ports;
  if (first > last) throw new ConfigError(`${source} is invalid:\nconfig.workflow.ports: first (${first}) is above last (${last})`);
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
