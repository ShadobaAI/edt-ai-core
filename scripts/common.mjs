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
    throw Object.assign(new ConfigError(
      "Invalid YAML document (" + [...doc.errors, ...doc.warnings].map(error => error.code || "YAML_ERROR").join(", ") + "); source excerpt omitted",
    ), { code: "INVALID_DOCUMENT" });
  let value;
  try { value = doc.toJS({ maxAliasCount: 100 }); }
  catch { throw Object.assign(new ConfigError("Invalid YAML document; source excerpt omitted"), { code: "INVALID_DOCUMENT" }); }
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
  if (!validators.has(name)) {
    const schema = JSON.parse(fs.readFileSync(path.join(ROOT, "schemas", name), "utf8"));
    const versionField = ["schema_version", "version"].find(field => Object.hasOwn(schema.properties?.[field] || {}, "const"));
    validators.set(name, { validate: ajv.compile(schema), versionField,
      version: schema.properties?.[versionField]?.const, versionRequired: schema.required?.includes(versionField) });
  }
  const { validate, versionField, version, versionRequired } = validators.get(name);
  if (versionField && (versionRequired || object(data) && Object.hasOwn(data, versionField)) && data?.[versionField] !== version) {
    const received = data?.[versionField];
    throw Object.assign(new ConfigError(
      `Unsupported contract version for ${name}: ${versionField}=${typeof received === "string" ? /^\d+\.\d+(?:\.\d+)?$/.test(received) ? JSON.stringify(received) : "invalid" : received === undefined ? "missing" : typeof received}; expected ${JSON.stringify(version)}. Review the document contract before explicitly updating it; automatic migration is not performed.`,
    ), { code: "UNSUPPORTED_CONTRACT_VERSION", contract: name, expectedVersion: version });
  }
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
    if (overwrite) {
      // Windows can briefly deny replacement while another process has the
      // destination open. Retry without deleting it or weakening atomicity.
      for (let attempt = 0; ; attempt++) {
        try { fs.renameSync(tmp, file); break; }
        catch (error) {
          if (process.platform !== "win32" || !["EPERM", "EACCES", "EBUSY"].includes(error.code) || attempt === 5) throw error;
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10 * 2 ** attempt);
        }
      }
    }
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
  for (const [name, entry] of Object.entries({ ...config.mcp.required, ...config.mcp.managed }))
    if (entry.url) validate_url(entry.url, name);
  if (config.mcp.optional.openviking?.url)
    validate_openviking_url(config.mcp.optional.openviking.url);
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
export function validate_openviking_url(value) {
  validate_url(value, "OpenViking");
  if (new URL(value).search)
    throw new ConfigError("OpenViking endpoint query parameters are not supported; authorization must use headers_env.");
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
  const { create_diagnostic_logger, safe_error_message } = await import("./diagnostics.mjs");
  const diagnostic = create_diagnostic_logger("cli");
  const executable = path.basename(process.argv[1] || "");
  diagnostic.event("command_started", { executable });
  try {
    process.exitCode = (await main()) || 0;
    diagnostic.event("command_completed", { executable, exitCode: process.exitCode });
  } catch (error) {
    diagnostic.event("command_failed", { executable, error }, "error");
    console.log(JSON.stringify({ status: "error", error: safe_error_message(error) }));
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
