import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import { parseDocument, stringify, Ajv2020 } from "../vendor/deps.mjs";
import {
  ROOT,
  ConfigError,
  resolve,
  contained,
  exists,
} from "./project_paths.mjs";
export { ROOT, ConfigError };
export const object = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value);
export function parse(text) {
  const doc = parseDocument(text.replace(/^\uFEFF/, ""), {
    uniqueKeys: true,
    schema: "yaml-1.1",
    customTags: (tags) =>
      tags.map((tag) =>
        tag.tag === "tag:yaml.org,2002:float" &&
        !tag.format &&
        tag.test?.test(".")
          ? { ...tag, test: /^(?:[-+]?[0-9][0-9_]*\.[0-9_]*|[-+]?\.[0-9_]+)$/ }
          : tag,
      ),
  });
  if (doc.errors.length || doc.warnings.length)
    throw new ConfigError(
      [...doc.errors, ...doc.warnings].map((error) => error.message).join("; "),
    );
  const value = doc.toJS({ maxAliasCount: 100 });
  if (!object(value)) throw new ConfigError("Expected an object");
  return value;
}
export const load = (file) => parse(fs.readFileSync(file, "utf8"));
const ajv = new Ajv2020({
  allErrors: true,
  strict: false,
  ownProperties: true,
  validateFormats: false,
});
const validators = new Map();
export function check_schema(data, name) {
  if (!validators.has(name))
    validators.set(
      name,
      ajv.compile(
        JSON.parse(fs.readFileSync(path.join(ROOT, "schemas", name), "utf8")),
      ),
    );
  const validate = validators.get(name);
  if (!validate(data))
    throw new ConfigError(
      validate.errors
        .map((error) => `${error.instancePath || "$"}: ${error.message}`)
        .join("; "),
    );
}
export function atomic_write(file, text, overwrite = true) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = path.join(path.dirname(file), `.core-${randomUUID()}.tmp`);
  try {
    fs.writeFileSync(tmp, text, { flag: "wx", mode: 0o600 });
    if (overwrite) fs.renameSync(tmp, file);
    else fs.linkSync(tmp, file);
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}
export const dump = (data, file, overwrite = true) =>
  atomic_write(file, stringify(data, { schema: "yaml-1.1" }), overwrite);
export function inside(root, relative) {
  if (
    typeof relative !== "string" ||
    !relative ||
    path.isAbsolute(relative) ||
    path.win32.isAbsolute(relative)
  )
    throw new ConfigError(`Path must be relative to the project: ${relative}`);
  root = resolve(root);
  const target = resolve(path.join(root, relative));
  if (!contained(root, target))
    throw new ConfigError(`Path escapes project: ${relative}`);
  return target;
}
export function deep_merge(base, overlay) {
  const result = structuredClone(base);
  for (const [key, value] of Object.entries(overlay)) {
    if (["__proto__", "constructor", "prototype"].includes(key))
      throw new ConfigError("Unsafe object key: " + key);
    result[key] =
      object(value) && object(result[key])
        ? deep_merge(result[key], value)
        : structuredClone(value);
  }
  return result;
}
export function settings(file) {
  let base = load(path.join(ROOT, "settings/defaults.json"));
  const local =
    file ||
    process.env.EDT_AI_SETTINGS ||
    path.join(ROOT, "settings/local.yaml");
  if (exists(local)) base = deep_merge(base, load(local));
  return validate_settings(base);
}
export function validate_settings(config) {
  check_schema(config, "plugin-settings.schema.json");
  for (const [name, entry] of Object.entries(config.mcp.required))
    if (entry.url) validate_url(entry.url, name);
  if (config.mcp.optional.openviking?.url)
    validate_url(config.mcp.optional.openviking.url, "OpenViking");
  return config;
}
export function validate_url(value, name = "MCP") {
  try {
    const uri = new URL(value);
    if (
      !["http:", "https:"].includes(uri.protocol) ||
      !uri.hostname ||
      uri.hash ||
      uri.username ||
      uri.password ||
      uri.port === "0"
    )
      throw new Error();
  } catch {
    throw new ConfigError(
      `Invalid ${name} MCP URL: credentials, invalid port or scheme`,
    );
  }
  return value;
}
export function state_path(config, override) {
  let value =
    override ||
    process.env.EDT_AI_STATE_DIR ||
    config.state_dir.replaceAll(
      "${CODEX_HOME}",
      process.env.CODEX_HOME || path.join(os.homedir(), ".codex"),
    );
  if (value.includes("${"))
    throw new ConfigError("Unresolved variable in state_dir");
  if (value === "~" || value.startsWith("~/") || value.startsWith("~\\"))
    value = os.homedir() + value.slice(1);
  return resolve(value);
}
export const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
export async function operation_lock(state, action, timeout = 0) {
  fs.mkdirSync(state, { recursive: true });
  const lock = path.join(state, "operation.lock"),
    deadline = Date.now() + timeout * 1000;
  while (true) {
    try {
      fs.writeFileSync(lock, String(process.pid), { flag: "wx", mode: 0o600 });
      break;
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      if (Date.now() >= deadline)
        throw new ConfigError(
          `Another runtime operation holds ${lock}. Verify its PID before removing a stale lock.`,
        );
      await sleep(Math.min(100, Math.max(0, deadline - Date.now())));
    }
  }
  try {
    return await action();
  } finally {
    fs.rmSync(lock, { force: true });
  }
}
export const stable = (value) =>
  JSON.stringify(value, function (key, child) {
    return object(child)
      ? Object.fromEntries(
          Object.keys(child)
            .sort()
            .map((name) => [name, child[name]]),
        )
      : child;
  });
export const entrypoint = (url) =>
  process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === url;
export async function cli(main) {
  try {
    process.exitCode = (await main()) || 0;
  } catch (error) {
    console.log(JSON.stringify({ status: "error", error: error.message }));
    process.exitCode = 1;
  }
}
// Small strict parser shared by portable command-line entrypoints.
export function argumentsOf(
  argv = process.argv.slice(2),
  flags = [],
  options = null,
) {
  const result = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith("--")) {
      result._.push(argv[i]);
      continue;
    }
    const equal = argv[i].indexOf("="),
      raw = equal < 0 ? argv[i].slice(2) : argv[i].slice(2, equal),
      key = raw.replaceAll("-", "_");
    if (options && ![...flags, ...options].includes(key))
      throw new ConfigError("Unknown option: --" + raw);
    if (Object.hasOwn(result, key))
      throw new ConfigError("Duplicate option: " + argv[i]);
    if (flags.includes(key)) {
      if (equal >= 0) throw new ConfigError("Flag takes no value: --" + raw);
      result[key] = true;
    } else if (equal >= 0) result[key] = argv[i].slice(equal + 1);
    else {
      if (!argv[i + 1] || argv[i + 1].startsWith("--"))
        throw new ConfigError("Missing value: " + argv[i]);
      result[key] = argv[++i];
    }
  }
  return result;
}
