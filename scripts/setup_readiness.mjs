import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";
import { ROOT, load, stable, atomic_write, inside, object, ConfigError, operation_lock, barrier_recovery_hint } from "./common.mjs";
import { exists, is_file, sha256, instance_directory, instance_name, reconnect_file, project_directory, path_identity } from "./project_paths.mjs";
import { edt_connection, repository_projects } from "./directory_context.mjs";
import { setup_knowledge_status, edt_project_building } from "./setup_probe.mjs";
import { knowledge_evidence_revision, preparation_granted } from "./components.mjs";
import { verification_limits, sanitize_setup_result, register_diagnostic_secrets } from "./diagnostics.mjs";
import { project_profile } from "./profile.mjs";
import { which } from "./processes.mjs";
import { open_reader, reader_active } from "./reader_lease.mjs";
import { yaxunit_result, yaxunit_unchecked } from "./yaxunit_readiness.mjs";
import { read_regular_file } from "./bounded_file.mjs";

const maxReadinessFileBytes = 16 * 1024 * 1024;
const read_readiness_file = file => {
  // Publishing an exclusive marker links a complete temporary file and then
  // unlinks the temporary name. That last unlink can change ctime between
  // lstat and fstat without changing the marker. Retry the same strict read;
  // never accept a partial or changing file after the bounded retries.
  for (let attempt = 0; ; attempt++) {
    try {
      const result = read_regular_file(file, maxReadinessFileBytes);
      if (!result) throw Object.assign(new Error("Readiness input is missing"), { code: "ENOENT" });
      return result.bytes.toString("utf8");
    } catch (error) {
      if (error.code !== "LOCAL_FILE_CHANGED" || attempt === 4) throw error;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1);
    }
  }
};
const digest = file => {
  const actual = path_identity(file);
  if (!is_file(actual)) return "missing";
  const result = read_regular_file(actual, maxReadinessFileBytes);
  return result ? sha256(result.bytes) : "missing";
};
const receipt_file = (state, root) => path.join(instance_directory(state, root), instance_name() + ".readiness.json");
const observations_file = (state, root) => path.join(instance_directory(state, root), instance_name() + ".readiness-observations.json");
const flights_file = (state, root) => path.join(instance_directory(state, root), instance_name() + ".readiness-flights.json");
const checked_components = ["edt", "v8std", "openviking", "code-index", "bsl-ls", "yaxunit", "vanessa"];
const local_bsl = config => config.mcp.managed["bsl-ls"].mode !== "external";

// Shared across settings MCP sessions for the same project and instance. The
// generation prevents a delayed background child from starting after a newer
// foreground check; active leases make later background observations transient.
function priority_paths(state, root, instance) {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(instance)) throw new ConfigError("Некорректный идентификатор экземпляра.");
  const base = path.join(project_directory(state, root), "coordination");
  return { generation: inside(state, path.relative(state, path.join(base, instance + ".readiness-priority"))),
    claim: inside(state, path.relative(state, path.join(base, instance + ".readiness-claim"))),
    active: inside(state, path.relative(state, path.join(base, instance + ".readiness-active"))) };
}
function priority_revision(file) {
  try {
    const value = read_readiness_file(file);
    if (!/^[a-f0-9-]{36}$/.test(value)) throw new ConfigError("Некорректная ревизия проверки готовности.");
    return value;
  } catch (error) { if (error.code === "ENOENT") return ""; throw error; }
}
function valid_foreground_marker(record, id) {
  return object(record) && Number.isSafeInteger(record.pid) && record.pid > 0 &&
    (record.id === undefined || record.id === id) &&
    (record.finished === true || record.phase === undefined || ["starting", "active", "cleanup_unknown"].includes(record.phase));
}
export function assert_readiness_cleanup_known(state, root, instance) {
  const paths = priority_paths(state, root, instance); let names;
  try { names = fs.readdirSync(paths.active); }
  catch (error) { if (error.code === "ENOENT") return; throw error; }
  for (const name of names) {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(name)) continue;
    let record;
    try { record = JSON.parse(read_readiness_file(inside(state, path.relative(state, path.join(paths.active, name))))); }
    catch (error) { if (error.code === "ENOENT") continue; throw new ConfigError("Не удалось прочитать барьер предыдущей проверки готовности. " + barrier_recovery_hint(path.join(paths.active, name))); }
    const marker = path.join(paths.active, name);
    if (!valid_foreground_marker(record, name)) throw new ConfigError("Повреждён барьер предыдущей проверки готовности. " + barrier_recovery_hint(marker));
    if (record?.phase === "cleanup_unknown") throw new ConfigError("Не подтверждено завершение предыдущей проверки готовности; новая проверка заблокирована. " + barrier_recovery_hint(marker));
  }
}
export function begin_foreground_readiness(state, root, instance, id) {
  const paths = priority_paths(state, root, instance), marker = inside(state, path.relative(state, path.join(paths.active, id)));
  fs.mkdirSync(paths.active, { recursive: true });
  assert_readiness_cleanup_known(state, root, instance);
  const before = priority_revision(paths.claim);
  let observedActive = false, names;
  try { names = fs.readdirSync(paths.active); }
  catch (error) { if (error.code === "ENOENT") names = []; else throw error; }
  for (const name of names) {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(name)) continue;
    try {
      const record = JSON.parse(read_readiness_file(inside(state, path.relative(state, path.join(paths.active, name)))));
      if (!valid_foreground_marker(record, name)) throw new Error("invalid marker");
      if (record.phase === "active") observedActive = true;
    } catch (error) { if (error.code !== "ENOENT") throw new ConfigError("Не удалось прочитать барьер предыдущей проверки готовности."); }
  }
  const claimRevision = priority_revision(paths.claim);
  observedActive ||= before !== claimRevision;
  atomic_write(marker, JSON.stringify({ pid: process.pid, id, phase: "starting", claimRevision, observedActive }), false);
  try { assert_readiness_cleanup_known(state, root, instance); atomic_write(paths.generation, id); }
  catch (error) { fs.rmSync(marker, { force: true }); throw error; }
  return marker;
}
export async function activate_foreground_readiness(state, root, instance, marker, id) {
  let lease;
  try {
    lease = await open_reader(id);
    await operation_lock(state, async () => {
      const paths = priority_paths(state, root, instance);
      let own;
      try { own = JSON.parse(read_readiness_file(inside(state, path.relative(state, marker)))); }
      catch { throw Object.assign(new Error("Маркер проверки изменился до запуска."), { outcomeUnknown: true, markerChanged: true }); }
      if (!object(own) || own.id !== id || own.pid !== process.pid || own.phase !== "starting")
        throw Object.assign(new Error("Маркер проверки изменился до запуска."), { outcomeUnknown: true, markerChanged: true });
      if (typeof own.claimRevision !== "string" || own.claimRevision !== "" && !/^[a-f0-9-]{36}$/.test(own.claimRevision) || typeof own.observedActive !== "boolean")
        throw Object.assign(new Error("Маркер проверки изменился до запуска."), { outcomeUnknown: true, markerChanged: true });
      assert_readiness_cleanup_known(state, root, instance);
      if (own.observedActive || own.claimRevision !== priority_revision(paths.claim))
        throw Object.assign(new ConfigError("Проверка готовности уже выполнялась в другой MCP-сессии. " + barrier_recovery_hint(paths.active)), { code: "READINESS_BUSY" });
      for (const name of fs.readdirSync(paths.active)) {
        if (name === id || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(name)) continue;
        let record;
        try { record = JSON.parse(read_readiness_file(inside(state, path.relative(state, path.join(paths.active, name))))); }
        catch (error) { if (error.code === "ENOENT") continue; throw new ConfigError("Не удалось прочитать барьер предыдущей проверки готовности."); }
        if (!valid_foreground_marker(record, name)) throw new ConfigError("Повреждён барьер предыдущей проверки готовности.");
        if (record.finished === true || record.phase === "starting") continue;
        const active = await reader_active(name, { cleanupStale: false });
        if (active) throw Object.assign(new ConfigError("Проверка готовности уже выполняется в другой MCP-сессии."), { code: "READINESS_BUSY" });
        // An absent endpoint does not prove that the previous backend stopped.
        // Allow a concurrently completed owner to remove its marker first.
        try { read_readiness_file(inside(state, path.relative(state, path.join(paths.active, name)))); }
        catch (error) { if (error.code === "ENOENT") continue; throw error; }
        throw new ConfigError("Не подтверждено завершение предыдущей проверки готовности; новая проверка заблокирована. " + barrier_recovery_hint(path.join(paths.active, name)));
      }
      if (!retain_foreground_readiness(state, marker, id))
        throw Object.assign(new Error("Не удалось сохранить барьер проверки готовности."), { outcomeUnknown: true });
      atomic_write(inside(state, path.relative(state, marker)), JSON.stringify({ pid: process.pid, id, phase: "active" }));
      atomic_write(paths.claim, id);
      // Invalidates observations dispatched while the listener was starting.
      atomic_write(paths.generation, randomUUID());
    }, 10);
    return lease;
  } catch (error) {
    if (!lease) {
      if (error.outcomeUnknown && !retain_foreground_readiness(state, marker, id)) error.markerChanged = true;
      throw error;
    }
    try { await lease.close(); }
    catch (cleanup) { throw Object.assign(new Error("Не подтверждено закрытие владельца проверки готовности."), { outcomeUnknown: true, cause: cleanup }); }
    throw error;
  }
}
export async function foreground_readiness_active(state, root, instance) {
  const paths = priority_paths(state, root, instance); let names;
  try { names = fs.readdirSync(paths.active); }
  catch (error) { if (error.code === "ENOENT") return false; throw error; }
  for (const name of names) {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(name)) continue;
    let record;
    try { record = JSON.parse(read_readiness_file(inside(state, path.relative(state, path.join(paths.active, name))))); }
    catch (error) { if (error.code === "ENOENT") continue; return true; }
    if (!valid_foreground_marker(record, name)) return true;
    if (record?.finished === true) continue;
    if (record?.phase === "cleanup_unknown") return true;
    // The owner may bind its listener after this scan. Treat its reservation
    // as active before that happens so a background check cannot race it.
    if (record?.phase === "starting") return true;
    try { if (await reader_active(name, { cleanupStale: false })) return true; } catch { return true; }
    // A vanished endpoint alone does not prove that the backend and its
    // descendants exited. A concurrently removed marker is the only safe
    // indication here that its owner completed normal cleanup.
    try { read_readiness_file(inside(state, path.relative(state, path.join(paths.active, name)))); return true; }
    catch (error) { if (error.code !== "ENOENT") return true; }
  }
  return false;
}
export function retain_foreground_readiness(state, marker, id) {
  try {
    marker = inside(state, path.relative(state, marker));
    const prior = JSON.parse(read_readiness_file(marker));
    if (!object(prior) || prior.id !== id || prior.pid !== process.pid || !["starting", "active", "cleanup_unknown"].includes(prior.phase)) return false;
    atomic_write(marker, JSON.stringify({ pid: process.pid, id, phase: "cleanup_unknown" }));
    return true;
  } catch { return false; }
}
export function retain_readiness_scope(state, root, instance, id) {
  try {
    const paths = priority_paths(state, root, instance), marker = inside(state, path.relative(state, path.join(paths.active, id)));
    fs.mkdirSync(paths.active, { recursive: true });
    atomic_write(marker, JSON.stringify({ pid: process.pid, id, phase: "cleanup_unknown" }), false);
    return true;
  } catch { return false; }
}
export function release_foreground_readiness(state, marker) {
  try {
    marker = inside(state, path.relative(state, marker));
    try { fs.lstatSync(marker); } catch (error) { if (error.code === "ENOENT") return true; throw error; }
    // Until unlink succeeds, keep a durable barrier for other sessions.
    if (!retain_foreground_readiness(state, marker, path.basename(marker))) return false;
    try { fs.rmSync(marker, { force: true }); }
    catch { return false; }
    try { fs.rmdirSync(path.dirname(marker)); } catch {}
    return true;
  } catch { return false; }
}
export function capture_readiness_priority(state, root, instance) {
  return { revision: priority_revision(priority_paths(state, root, instance).generation) };
}
export function readiness_priority_current(state, root, instance, priority) {
  return priority_revision(priority_paths(state, root, instance).generation) === priority.revision;
}

// Vanessa's endpoint and expected manager base are stored in a separate local
// runtime file. Include its bounded contents in this component's evidence only.
export function vanessa_runtime_snapshot(root, profile) {
  let runtime = "missing";
  try {
    const relative = profile.testing?.vanessa_config?.runtime_profile;
    if (relative) {
      const file = inside(root, relative);
      const stat = fs.statSync(file);
      if (!stat.isFile()) runtime = "not-a-file";
      else if (stat.size > 65536) runtime = "too-large";
      else {
        const contents = read_regular_file(file, 65536);
        if (!contents) runtime = "missing";
        else {
          const content = contents.bytes, fileIdentity = fs.realpathSync.native(file);
          runtime = { digest: sha256(content), file: fileIdentity };
          try {
            const raw = JSON.parse(content.toString("utf8").replace(/^\uFEFF/, ""));
            const base = raw?.manager?.infobase;
            if (base?.type === "file" && typeof base.path === "string" && base.path) {
              const target = path.resolve(path.dirname(fileIdentity), base.path);
              try {
                const actual = fs.realpathSync.native(target), stat = fs.statSync(actual);
                runtime.managerBase = stat.isDirectory() ? { path: actual, device: stat.dev, inode: stat.ino } : "not-a-directory";
              } catch { runtime.managerBase = "unavailable"; }
            }
          } catch { /* Invalid runtime JSON cannot yield a confirmed manager. */ }
        }
      }
    }
  } catch (error) { runtime = error.code === "ENOENT" ? "missing" : "unavailable"; }
  return runtime;
}
export function vanessa_readiness_fingerprint(state, config, profile, fingerprint = readiness_fingerprint(state, config, profile), runtime = vanessa_runtime_snapshot(config.active_project, profile)) {
  return sha256(stable({ fingerprint, runtime }));
}

// Local API compatibility survives time passing and unrelated project changes.
// Inspect launch inputs without executing Java or starting the language server.
export function bsl_readiness_fingerprint(state, config) {
  const options = config.mcp.managed["bsl-ls"];
  const fileDigest = file => { try { return digest(file); } catch { return "unavailable"; } };
  // This is an invalidation key for an earlier verified observation, not an
  // integrity check. Runtime execution still verifies the lock's SHA-256.
  // A backend process is created for each request, so an in-memory digest
  // cache would re-read large binaries on every minute's status poll.
  const identity = file => {
    try {
      const actual = fs.realpathSync.native(file), stat = fs.statSync(actual, { bigint: true });
      if (!stat.isFile()) return "not-a-file";
      return [actual, ...[stat.dev, stat.ino, stat.mode, stat.size, stat.mtimeNs, stat.ctimeNs].map(String)];
    } catch (error) { return error.code === "ENOENT" ? "missing" : "unavailable"; }
  };
  const executable = command => { try { const file = which(command); return file ? identity(file) : null; } catch { return "unavailable"; } };
  let runtime = null;
  try {
    const entry = JSON.parse(read_readiness_file(path.join(state, "runtime-lock.json")))["bsl-ls"];
    if (entry) { const { candidate, previous, ...active } = entry; runtime = active; }
  } catch {}
  let jar = "missing";
  try { if (runtime?.path) jar = identity(inside(state, runtime.path)); } catch { jar = "invalid"; }
  let configuration = null;
  try {
    if (options.configuration) {
      const file = path.isAbsolute(options.configuration) ? options.configuration : inside(config.active_project, options.configuration);
      configuration = { file: path_identity(file), digest: fileDigest(file) };
    } else configuration = { project: fileDigest(path.join(config.active_project, ".bsl-language-server.json")),
      home: fileDigest(path.join(os.homedir(), ".bsl-language-server.json")) };
  }
  catch { configuration = "invalid"; }
  return sha256(stable({ root: config.active_project, instance: instance_name(), options, runtime, jar,
    java: executable(options.java || "java"), node: executable(options.node || process.execPath),
    configuration,
    javaOptions: ["JAVA_HOME", "JAVA_TOOL_OPTIONS", "_JAVA_OPTIONS", "JDK_JAVA_OPTIONS"].map(name => process.env[name] || null),
    adapter: fileDigest(inside(ROOT, "mcp/bsl-ls-proxy.mjs")) }));
}

export function bsl_api_observed(check, { external = false, live = false } = {}) {
  const { apiEvidenceVersion, ...previous } = check;
  const verified = live || apiEvidenceVersion === 1;
  return { ...previous, ready: verified, state: verified ? "ready" : "not_verified", apiCompatible: verified,
    ...(verified ? { apiEvidenceVersion: 1 } : {}),
    detail: !verified ? "Сохранённый результат не подтверждает актуальную проверку API BSL LS. Повторите проверку."
      : external ? "MCP API BSL LS отвечает и поддерживает рабочие области. JAR, Java и применённая конфигурация удалённого сервера не проверялись."
      : "Проверены JAR, запуск выбранной Java и совместимость MCP API. Применение конфигурации и работа диагностик этой проверкой не подтверждаются." };
}

function component_record(state, config, check, checkedAt, fingerprint) {
  if (check.id === "bsl-ls" && check.state === "ready") check = bsl_api_observed(check, { external: !local_bsl(config) });
  const { name, ready, ...result } = check;
  const durable = check.id === "bsl-ls" && local_bsl(config) &&
    (["ready", "error"].includes(check.state) || check.state === "not_verified" && check.apiCompatible === true);
  const observedAt = check.checkedAt || checkedAt;
  const inputRevision = durable ? check.inputRevision || bsl_readiness_fingerprint(state, config) : null;
  return { fingerprint: inputRevision || fingerprint, fingerprintVersion: 2, result: sanitize_setup_result({ ...result, checkedAt: observedAt,
    ...(durable ? { validity: "inputs", inputRevision, expiresAt: null } : {
      expiresAt: new Date(Math.min(Date.parse(observedAt) + (check.id === "vanessa" ? 60 * 1000 : 15 * 60 * 1000), Number.isFinite(Date.parse(check.expiresAt)) ? Date.parse(check.expiresAt) : Infinity)).toISOString() }) }) };
}

function last_reliable_observation(result) {
  const previous = Number.isFinite(Date.parse(result?.lastCheckedAt)) ? result.lastCheckedAt : null;
  const reliable = ["ready", "disabled", "stopped", "missing", "missing_config", "missing_project", "mismatch", "stale", "indexing", "building", "running"];
  const current = (result?.apiCompatible === true || reliable.includes(result?.state) || result?.state === "check_stale" && reliable.includes(result.lastState)) &&
    Number.isFinite(Date.parse(result.checkedAt)) ? result.checkedAt : null;
  return current && (!previous || Date.parse(current) > Date.parse(previous)) ? current : previous;
}

// Each observation is invalidated by the inputs its probe actually uses. The
// full setup receipt remains tied to readiness_fingerprint, which intentionally
// covers the whole environment. Never persist the header values themselves.
export function component_fingerprint(state, config, profile, id, { vanessaRuntimeSnapshot, indexSnapshot } = {}) {
  const root = config.active_project, instance = instance_name();
  if (!checked_components.includes(id)) throw new ConfigError("Выберите компонент для проверки.");
  try {
  if (id === "bsl-ls" && local_bsl(config)) return bsl_readiness_fingerprint(state, config);
  const connection = options => ({ options, credentials: Object.fromEntries(Object.entries(options?.headers_env || {}).map(([header, name]) => [header, process.env[name] || null])) });
  const policy = { edt_repository_ids: [...profile.policy?.edt_repository_ids || []].sort(), unbound_edt_repositories: [...profile.policy?.unbound_edt_repositories || []].sort() };
  const repositories = items => repository_projects(root, items);
  const edt = items => ({ connection: connection(config.mcp.required.edt), repositories: repositories(items), policy });
  let inputs;
  if (id === "edt") inputs = edt(profile.repositories.filter(item => !policy.unbound_edt_repositories?.includes(item.id)));
  else if (id === "v8std") inputs = connection(config.mcp.required.v8std);
  else if (id === "openviking") inputs = { options: config.mcp.optional.openviking, knowledge: profile.knowledge,
    evidence: knowledge_evidence_revision(config, root, profile, state) };
  else if (id === "yaxunit") {
    const test = profile.testing?.yaxunit_config || {}, ids = new Set([test.repository_id, test.framework_repository_id, ...(test.product_repository_ids || [])]);
    inputs = { connection: connection(config.mcp.required.edt), repositories: repositories(profile.repositories.filter(item => ids.has(item.id))),
      unbound: policy.unbound_edt_repositories.filter(id => ids.has(id)), testing: { yaxunit: profile.testing?.yaxunit, configured: Boolean(profile.testing?.yaxunit_config),
        repository_id: test.repository_id, framework_repository_id: test.framework_repository_id, product_repository_ids: [...test.product_repository_ids || []].sort(), launch_configuration: test.launch_configuration } };
  }
  else if (id === "vanessa") {
    const test = profile.testing?.vanessa_config;
    const relevant = sha256(stable({ root, instance, vanessa: profile.testing?.vanessa, configured: Boolean(test), runtime_profile: test?.runtime_profile, server_name: test?.server_name }));
    return vanessa_readiness_fingerprint(state, config, profile, relevant, vanessaRuntimeSnapshot);
  } else if (id === "code-index") {
    const home = path.join(project_directory(state, root), "code-index"), options = config.mcp.managed[id];
    let runtime = null;
    if (options.mode !== "external") try { runtime = JSON.parse(read_readiness_file(path.join(state, "runtime-lock.json")))[id] || null; } catch {}
    inputs = { connection: connection(options), repositories: indexSnapshot?.repositories || repositories(profile.repositories), policy,
      ...(options.mode !== "external" ? { runtime, preparation: preparation_granted(state, root, "code-index"),
        daemon: ["daemon.json", "owner.json", "daemon.toml"].map(file => indexSnapshot?.files?.[file]?.digest ?? digest(path.join(home, file))) } : {}) };
  } else if (id === "bsl-ls") inputs = connection(config.mcp.managed[id]);
  else throw new ConfigError("Выберите компонент для проверки.");
  return sha256(stable({ root, instance, id, inputs }));
  } catch (error) {
    // One broken manifest or path must not prevent observing unrelated
    // components. The error is itself an input; recovery changes the key.
    return sha256(stable({ root, instance, id, unavailable: { code: error.code || error.name, message: error.message } }));
  }
}
export function readiness_receipt_revision(state, root, components = null) {
  const file = receipt_file(state, root);
  if (!components) return digest(file);
  let receipt;
  try { receipt = JSON.parse(read_readiness_file(file)); }
  catch (error) {
    return error.code === "ENOENT" ? sha256(stable({ version: 3, components: {} })) : digest(file);
  }
  if (!object(receipt) || receipt.version !== 3 || receipt.components !== undefined && !object(receipt.components)) return digest(file);
  // Independent components may merge, but full setup and unknown receipt fields
  // must still match. A missing receipt is equivalent to an empty component cache.
  return sha256(stable({ ...receipt, components: Object.fromEntries(components
    .filter(id => Object.hasOwn(receipt.components || {}, id)).map(id => [id, receipt.components[id]])) }));
}

function component_receipt_revision(state, root, id) {
  const receipt = component_receipt(state, root);
  return sha256(stable(receipt.components?.[id] || null));
}

function component_flights(state, root) {
  try {
    const record = JSON.parse(read_readiness_file(flights_file(state, root)));
    if (record?.version !== 1 || !object(record.components)) throw new ConfigError("Некорректная запись совместной проверки компонентов.");
    const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
    for (const [id, item] of Object.entries(record.components))
      if (!checked_components.includes(id) || !object(item) || !["running", "completed", "superseded"].includes(item.state) ||
          !uuid.test(item.owner || "") || !uuid.test(item.ticket || "") || !/^[a-f0-9]{64}$/.test(item.fingerprint || "") ||
          typeof item.priority !== "string" || item.priority && !uuid.test(item.priority) ||
          item.state === "completed" && !/^[a-f0-9]{64}$/.test(item.receiptRevision || "") ||
          item.session !== undefined && !uuid.test(item.session) ||
          item.finishedAt !== undefined && !Number.isSafeInteger(item.finishedAt) ||
          item.external !== undefined && !object(item.external)) throw new ConfigError("Некорректная запись совместной проверки компонента.");
    return record.components;
  } catch (error) {
    if (error.code === "ENOENT") return {};
    throw new ConfigError("Не удалось прочитать координацию проверок компонентов; повторный запуск заблокирован.");
  }
}

// Capture the published tickets before the backend is dispatched. This lets a
// delayed backend distinguish a flight completed after the request from an
// older completed observation, without ordering events by the wall clock.
export function capture_component_flights(state, root) {
  return Object.fromEntries(Object.entries(component_flights(state, root)).map(([id, flight]) =>
    [id, { owner: flight.owner, ticket: flight.ticket, state: flight.state }]));
}

// These functions are called only under the short state lock. A flight's
// capability is opened before its reservation is published; a PID is never
// used as proof that an observation is still running.
export function reserve_component_flights(state, root, components, inputs, priority, owner, { automatic = false, session = null, observedFlights = null, config, profile } = {}) {
  const flights = component_flights(state, root), leaders = [], joined = {}, cache = { flights };
  for (const id of components) {
    const flight = flights[id];
    const same = flight?.fingerprint === inputs[id] && (flight.state !== "running" ||
      (cache.observations ||= component_observations(state, root))[id] === flight.ticket);
    const observed = observedFlights?.[id];
    const completedAfterCapture = observedFlights && flight?.state === "completed" &&
      (!observed || observed.owner !== flight.owner || observed.ticket !== flight.ticket || observed.state === "running");
    const prior = (automatic || completedAfterCapture) && session && flight?.session && flight.session !== session && flight.state === "completed"
      ? component_flight_result(state, root, config, profile, id, flight, cache) : null;
    const observedAt = prior?.check?.validity === "inputs" ? flight.finishedAt : Date.parse(prior?.check?.checkedAt);
    const expires = Date.parse(prior?.check?.expiresAt), now = Date.now();
    const recentlyObservedElsewhere = prior?.state === "completed" && Number.isFinite(observedAt) && observedAt <= now &&
      now < Math.min(observedAt + 60000, Number.isFinite(expires) ? expires : Infinity);
    if (same && (flight.state === "running" || recentlyObservedElsewhere)) joined[id] = flight;
    else leaders.push(id);
  }
  const observation = leaders.length ? begin_component_checks(state, root, leaders) : null;
  for (const id of leaders) flights[id] = { state: "running", owner, ticket: observation.id, fingerprint: inputs[id], priority, ...(session ? { session } : {}) };
  if (leaders.length) atomic_write(flights_file(state, root), JSON.stringify({ version: 1, components: flights }));
  return { leaders, joined, observation };
}

export function complete_component_flights(state, root, reservation, checks, external = {}) {
  if (!reservation.observation) return;
  const flights = component_flights(state, root), saved = new Map(checks.map(item => [item.id, item]));
  const receipt = component_receipt(state, root);
  for (const id of reservation.leaders) {
    const flight = flights[id];
    if (!flight || flight.ticket !== reservation.observation.id) continue;
    const revision = sha256(stable(receipt.components?.[id] || null));
    flights[id] = saved.has(id) && stable(receipt.components?.[id]?.result) === stable(saved.get(id))
      ? { ...flight, state: "completed", receiptRevision: revision, finishedAt: Date.now(), ...(external[id] ? { external: external[id] } : {}) }
      : { ...flight, state: "superseded" };
  }
  atomic_write(flights_file(state, root), JSON.stringify({ version: 1, components: flights }));
}

export function component_flight_result(state, root, config, profile, id, expected, cache = {}) {
  const current = (cache.flights ||= component_flights(state, root))[id];
  if (!current || current.ticket !== expected.ticket || current.owner !== expected.owner ||
      current.fingerprint !== expected.fingerprint || current.priority !== expected.priority) return { state: "superseded" };
  if (current.state === "running") return { state: "running" };
  const receipt = cache.receipt ||= component_receipt(state, root), entry = receipt.components?.[id];
  if (current.state !== "completed" || (cache.observations ||= component_observations(state, root))[id] !== current.ticket ||
      sha256(stable(entry || null)) !== current.receiptRevision || entry?.fingerprint !== current.fingerprint) return { state: "superseded" };
  const check = (cache.checks ||= read_component_checks(state, config, profile)).find(item => item.id === id);
  return check && check.state !== "check_stale" ? { state: "completed", check, ...(current.external ? { external: current.external } : {}) } : { state: "superseded" };
}

// Remove only the same reservation whose capability was just proven dead.
// The caller performs the capability check outside the state lock.
export function abandon_component_flight(state, root, id, expected) {
  const flights = component_flights(state, root), current = flights[id];
  if (current?.state !== "running" || current.owner !== expected.owner || current.ticket !== expected.ticket) return false;
  delete flights[id];
  atomic_write(flights_file(state, root), JSON.stringify({ version: 1, components: flights }));
  return true;
}

function component_observations(state, root) {
  try {
    const record = JSON.parse(read_readiness_file(observations_file(state, root)));
    if (record?.version !== 1 || !object(record.components)) return {};
    return Object.fromEntries(checked_components.filter(id => typeof record.components[id] === "string" && /^[a-f0-9-]{36}$/.test(record.components[id]))
      .map(id => [id, record.components[id]]));
  } catch { return {}; }
}

// Call while holding the shared state lock, both when reserving and committing.
// Tickets order observations across MCP processes without relying on wall clocks.
// Keep reservations outside the receipt: a superseded probe must not renew it.
export function begin_component_checks(state, root, components) {
  const ids = [...new Set(components)];
  if (!ids.length || ids.some(id => !checked_components.includes(id))) throw new ConfigError("Выберите компонент для проверки.");
  const id = randomUUID(), current = component_observations(state, root);
  for (const component of ids) current[component] = id;
  const receipt = component_receipt(state, root);
  const observation = { id, components: ids, root, instance: instance_name(), receiptRevision: readiness_receipt_revision(state, root, ids),
    componentRevisions: Object.fromEntries(ids.map(component => [component, sha256(stable(receipt.components?.[component] || null))])) };
  atomic_write(observations_file(state, root), JSON.stringify({ version: 1, components: current }));
  return observation;
}

export function component_check_current(state, root, observation, component, cache = {}) {
  if (root !== observation.root || instance_name() !== observation.instance || !observation.components.includes(component)) return false;
  const receipt = cache.receipt ||= component_receipt(state, root);
  return (cache.observations ||= component_observations(state, root))[component] === observation.id &&
    observation.componentRevisions[component] === sha256(stable(receipt.components?.[component] || null));
}

export function component_checks_current(state, root, observation) {
  if (root !== observation.root || instance_name() !== observation.instance) return false;
  const current = component_observations(state, root);
  return observation.components.every(id => current[id] === observation.id) &&
    observation.receiptRevision === readiness_receipt_revision(state, root, observation.components);
}
function passed(item, profile) {
  if (item.state === "ready") return true;
  if (item.state !== "disabled") return false;
  if (item.id === "yaxunit" && profile.testing?.yaxunit === true) return false;
  const authority = { "code-index": "code_index", "bsl-ls": "bsl_ls" }[item.id];
  return !authority || profile.authorities?.[authority] !== item.id;
}
function setup_states(checks, profile) {
  return { state: checks.every(item => passed(item, profile)) ? "ready" : "blocked",
    mainReadiness: { scope: "setup_main", state: checks.filter(item => !["yaxunit", "vanessa"].includes(item.id)).every(item => passed(item, profile)) ? "ready" : "blocked" } };
}

// Verify the installed workflow files, not whether a host/model has invoked a
// skill or trusted a hook. Those are separate from setup acceptance.
export function setup_assets(pluginRoot = ROOT) {
  const checks = [], files = new Set(["plugin.json", "mcp.json", "policy/default.json", "policy/read-only-mcp.mjs", "hooks/hooks.json", "hooks/guard.mjs", "hooks/session-start.mjs", "skills/catalog.yaml"]);
  try {
    const catalog = load(inside(pluginRoot, "skills/catalog.yaml"));
    if (!Array.isArray(catalog.active) || !catalog.active.length) throw new Error("Каталог навыков пуст.");
    for (const id of catalog.active) {
      if (typeof id !== "string" || !/^[a-z0-9][a-z0-9-]*$/.test(id)) throw new Error("Некорректное имя навыка.");
      const name = `skills/${id}/SKILL.md`, file = inside(pluginRoot, name);
      files.add(name);
      if (!is_file(file) || !read_readiness_file(file).trim()) throw new Error("Навык недоступен: " + id);
    }
    // Referenced workflow files are part of the checked installation too.
    const visit = directory => { for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) throw new Error("Ссылка в каталоге навыков.");
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(file); else if (/\.(md|yaml)$/.test(entry.name)) files.add(path.relative(pluginRoot, file));
    } };
    visit(inside(pluginRoot, "skills"));
    checks.push({ id: "skills", label: "Навыки", state: "ready", detail: "Доступно навыков: " + catalog.active.length });
  } catch (error) { checks.push({ id: "skills", label: "Навыки", state: "error", detail: error.message }); }
  try {
    const hooks = load(inside(pluginRoot, "hooks/hooks.json"));
    for (const [event, script] of [["SessionStart", "session-start.mjs"], ["PreToolUse", "guard.mjs"]])
      if (!hooks.hooks?.[event]?.some(group => group.hooks?.some(hook => hook.type === "command" && hook.command?.includes(script)))) throw new Error("Не настроен обработчик события " + event);
    for (const name of files) if (!is_file(inside(pluginRoot, name))) throw new Error("Нет файла: " + name);
    checks.push({ id: "source-guard", label: "Файлы защиты и подключения плагина", state: "ready", detail: "Файлы защиты, политики и подключений доступны. Работу защиты при вызове инструментов в Codex эта проверка не подтверждает." });
  } catch (error) { checks.push({ id: "source-guard", label: "Файлы защиты и подключения плагина", state: "error", detail: error.message }); }
  checks.push({ id: "node", label: "Среда Node.js", state: Number(process.versions.node.split(".")[0]) >= 22 ? "ready" : "error", detail: process.version });
  return { checks, fingerprint: sha256(Buffer.from(stable([...files].sort().map(name => [name, digest(inside(pluginRoot, name))])))) };
}

export function readiness_fingerprint(state, config, profile, assets = setup_assets(), { includeDaemonOwner = true, includeRuntime = true, includeReconnect = true } = {}) {
  return sha256(Buffer.from(stable({ root: config.active_project, instance: instance_name(), config, profile, assets: assets.fingerprint,
    ...(includeRuntime ? { runtime: digest(path.join(state, "runtime-lock.json")) } : {}), edt: edt_connection(config.active_project), descriptors: repository_projects(config.active_project, profile.repositories),
    ...(includeReconnect ? { reconnect: digest(reconnect_file(state, config.active_project)) } : {}),
    ...(includeDaemonOwner ? { daemonOwner: digest(path.join(project_directory(state, config.active_project), "code-index/owner.json")), daemon: digest(path.join(project_directory(state, config.active_project), "code-index/daemon.json")) } : {}),
    instructions: ["AGENTS.md", ".ai/PROJECT.md"].map(name => digest(inside(config.active_project, name))),
    knowledge: knowledge_evidence_revision(config, config.active_project, profile, state),
  })));
}

export function save_readiness(state, config, profile, managed, external, testing = [], { componentChecks = null, maxExpiresAt = Infinity } = {}) {
  register_diagnostic_secrets(config);
  managed = managed.map(item => {
    if (item.name !== "bsl-ls" || item.state === "disabled") return item;
    if (item.state && item.state !== "ready") return { ...item, ready: false };
    return item.ready ? bsl_api_observed(item, { external: !local_bsl(config) }) : item;
  });
  const assets = setup_assets();
  const knowledge = setup_knowledge_status(profile, config, config.active_project, external.openviking, state);
  const checks = [{ id: "profile", label: "Профиль и проекты", state: profile.repositories.length ? "ready" : "error", detail: "Настроено проектов: " + profile.repositories.length },
    { id: "knowledge", label: "Режим знаний", state: knowledge.state === "disabled" ? "disabled" : knowledge.state === "ready" ? "ready" : knowledge.state === "invalid" ? "error" : "not_verified", detail: knowledge.detail },
    ...managed.map(item => ({ id: item.name, label: ({ "code-index": "Индекс кода", "bsl-ls": "BSL LS", policy: "Политика" })[item.name] || item.name, state: item.state === "disabled" ? "disabled" : item.ready ? "ready" : item.state || "error", detail: item.detail,
      ...(item.name === "bsl-ls" && item.apiEvidenceVersion === 1 ? { apiEvidenceVersion: 1, apiCompatible: true } : {}),
      ...(item.repositories ? { repositories: item.repositories } : {}) })),
    ...Object.entries(external).map(([id, item]) => ({ id, label: id === "edt" ? "EDT и готовность проектов" : id, state: item.ready ? "ready" : id === "edt" && edt_project_building(item) ? "building" : item.connected ? "not_verified" : "error", ...(item.failure ? { failure: item.failure } : {}), ...(item.repositories ? { repositories: item.repositories } : {}), detail: item.detail || (!item.configured ? "Укажите адрес сервера в настройках подключений." : id === "edt" && item.projectReadiness !== "verified" ? "Не подтверждены точные пути, имена и готовность EDT-проектов." : "") })),
    { ...(testing.find(item => item.id === "yaxunit") || yaxunit_unchecked(profile)), label: "YaXUnit" },
    ...assets.checks];
  const result = { ...setup_states(checks, profile), checkedAt: new Date().toISOString(), checks, scope: "setup", knowledge,
    verificationLimits: verification_limits(knowledge.ready),
    workflowReadiness: { state: "not_checked", scope: "workflow", detail: "Проверка настройки не разрешает действия задачи и не подтверждает знания другой сессии." } };
  result.expiresAt = new Date(Math.min(Date.parse(result.checkedAt) + 15 * 60 * 1000,
    knowledge.ready ? Date.parse(knowledge.readiness.expiresAt) : Infinity, maxExpiresAt)).toISOString();
  const safe = sanitize_setup_result(result);
  const components = component_receipt(state, config.active_project).components || {};
  const fingerprint = readiness_fingerprint(state, config, profile, assets);
  let savedChecks;
  if (componentChecks) savedChecks = merge_component_checks(state, config, profile, components, componentChecks, safe.checkedAt);
  else {
    for (const id of [...managed.map(item => item.name), ...Object.keys(external)]) delete components[id];
    delete components.yaxunit;
    const bsl = managed.find(item => item.name === "bsl-ls");
    if (bsl && local_bsl(config) && (["ready", "error"].includes(bsl.state) || bsl.apiCompatible === true))
      components["bsl-ls"] = component_record(state, config, { ...bsl, id: "bsl-ls" }, safe.checkedAt);
  }
  atomic_write(receipt_file(state, config.active_project), JSON.stringify({ version: 3, fingerprint, result: safe, components }));
  return componentChecks ? { readiness: safe, componentChecks: savedChecks } : safe;
}

function component_receipt(state, root) {
  try {
    const receipt = JSON.parse(read_readiness_file(receipt_file(state, root)));
    if (receipt?.version !== 3) return {};
    if (!receipt.components || typeof receipt.components !== "object" || Array.isArray(receipt.components)) receipt.components = {};
    return receipt;
  }
  catch { return {}; }
}

// Addressed observations share the setup receipt and its project/instance and
// expiry rules, except local BSL LS compatibility which expires on input changes.
// Partial checks never turn into full setup acceptance.
export function save_component_checks(state, config, profile, checks) {
  register_diagnostic_secrets(config);
  const receipt = component_receipt(state, config.active_project), checkedAt = new Date().toISOString();
  receipt.version = 3; receipt.components ||= {};
  if (receipt.result?.knowledge?.ready === true && checks.some(check => check.id === "openviking" && check.state !== "ready")) receipt.knowledgeInvalidated = true;
  const saved = merge_component_checks(state, config, profile, receipt.components, checks, checkedAt);
  atomic_write(receipt_file(state, config.active_project), JSON.stringify(receipt));
  return saved;
}
function merge_component_checks(state, config, profile, components, checks, checkedAt) {
  for (const check of checks) {
    if (check.id === "bsl-ls" && local_bsl(config) && (check.validity === "inputs" && check.state === "check_stale" || check.preservePrevious === true && components["bsl-ls"]?.result?.validity === "inputs")) continue;
    const inputs = component_fingerprint(state, config, profile, check.id);
    const previous = components[check.id]?.result;
    const lastCheckedAt = check.state === "not_verified" && check.apiCompatible === true
      ? last_reliable_observation({ ...check, checkedAt: check.checkedAt || checkedAt, lastCheckedAt: last_reliable_observation(previous) })
      : ["not_checked", "not_verified", "check_stale", "error"].includes(check.state)
        ? last_reliable_observation(previous) : check.checkedAt || checkedAt;
    components[check.id] = component_record(state, config, { ...check, ...(lastCheckedAt ? { lastCheckedAt } : {}) }, checkedAt, inputs);
  }
  return checks.map(check => {
    if (check.id === "bsl-ls" && local_bsl(config) && (check.validity === "inputs" && check.state === "check_stale" || check.preservePrevious === true && components["bsl-ls"]?.result?.validity === "inputs")) {
      const { preservePrevious, ...result } = check; return sanitize_setup_result(result);
    }
    return components[check.id].result;
  });
}

export function read_component_checks(state, config, profile) {
  if (!config.active_project || profile.status && profile.status !== "loaded") return [];
  const entries = Object.values(component_receipt(state, config.active_project).components || {});
  if (!entries.length) return [];
  const data = profile.status ? project_profile(config.active_project) : profile;
  let legacyFingerprint;
  const bslFingerprint = entries.some(entry => entry?.result?.id === "bsl-ls" && entry.result.validity === "inputs") && local_bsl(config)
    ? bsl_readiness_fingerprint(state, config) : null;
  return entries.flatMap(entry => {
    if (!entry || typeof entry !== "object") return [];
    const { fingerprint: saved } = entry;
    let { result } = entry;
    if (!result || !checked_components.includes(result.id) || typeof result.state !== "string" || !Number.isFinite(Date.parse(result.checkedAt))) return [];
    if (result.id === "bsl-ls" && (result.state === "ready" || result.state === "not_verified" && result.apiCompatible === true))
      result = bsl_api_observed(result, { external: !local_bsl(config) });
    if (result.id === "bsl-ls" && result.validity === "inputs" && bslFingerprint) {
      const invalid = saved !== bslFingerprint || Date.now() < Date.parse(result.checkedAt);
      return [{ ...result, expiresAt: null, inputRevision: saved, currentInputRevision: bslFingerprint, ...(invalid ? { state: "check_stale", ready: false, lastState: result.state,
        detail: "Окружение или настройки BSL LS изменились. Повторите «Подготовить и проверить»." } : {}) }];
    }
    if (!Number.isFinite(Date.parse(result.expiresAt))) return [];
    let expected;
    if (entry.fingerprintVersion === 2) expected = component_fingerprint(state, config, data, result.id);
    else {
      legacyFingerprint ||= readiness_fingerprint(state, config, data);
      expected = result.id === "vanessa" ? vanessa_readiness_fingerprint(state, config, data, legacyFingerprint) : legacyFingerprint;
    }
    return [{ ...result, ...(saved !== expected || Date.now() < Date.parse(result.checkedAt) || Date.now() - Date.parse(result.checkedAt) > 15 * 60 * 1000 || Date.now() >= Date.parse(result.expiresAt)
      ? { ...(result.id === "yaxunit" ? yaxunit_result("check_stale", { target: undefined }) : { state: "check_stale", ...(result.id === "bsl-ls" ? { ready: false } : {}), detail: saved === expected && result.state === "check_stale" && result.detail ? result.detail : "Настройки или файлы изменились либо проверка устарела. Повторите проверку компонента." }), lastState: result.lastState || result.state } : {}) }];
  });
}

// The settings UI consumes this projection rather than deriving component
// status from the separately scoped full-setup receipt.
export function component_statuses(state, config, profile) {
  if (!config.active_project || profile.status && profile.status !== "loaded") return [];
  const data = profile.status ? project_profile(config.active_project) : profile;
  const saved = new Map(read_component_checks(state, config, data).map(item => [item.id, item]));
  return checked_components.map(id => {
    const lastCheckedAt = last_reliable_observation(saved.get(id));
    const previous = lastCheckedAt ? { lastCheckedAt } : {};
    let reason = "";
    if (id === "edt" || id === "v8std") {
      if (!config.mcp.required[id]?.url || config.mcp.required[id]?.enabled === false) reason = "Адрес MCP не задан или подключение отключено.";
    } else if (id === "openviking") {
      if (config.mcp.optional.openviking.enabled === false) return { id, state: "disabled", detail: "OpenViking отключён в настройках.", ...previous };
      if (!config.mcp.optional.openviking.url) reason = "Адрес MCP OpenViking не задан.";
    } else if (id === "code-index" || id === "bsl-ls") {
      if (config.mcp.managed[id].enabled === false) return { id, state: "disabled", detail: "Компонент отключён в настройках.", ...previous };
      if (config.mcp.managed[id].mode === "external" && !config.mcp.managed[id].url) reason = "Адрес внешнего MCP не задан.";
    } else {
      if (data.testing?.[id] !== true) return { id, state: "disabled", detail: "Возможность отключена в профиле.", ...previous };
      if (!data.testing?.[id + "_config"]) reason = "Настройки компонента отсутствуют в профиле.";
    }
    if (reason) return { id, state: "missing_config", detail: reason, ...previous };
    const observation = saved.get(id) && { ...saved.get(id), ...previous };
    if (observation) {
      if (observation.state === "not_checked" || observation.state === "not_verified" && !observation.detail)
        return { ...observation, state: "not_verified", detail: observation.detail || "Проверка компонента завершилась без данных, необходимых для подтверждения его состояния." };
      if (observation.state === "error" && !observation.detail)
        return { ...observation, detail: "Проверка компонента завершилась ошибкой без подробной диагностики." };
      return observation;
    }
    return { id, state: "awaiting_observation", detail: "Сохранённого наблюдения для этого профиля нет; выполняется автоматическое обновление." };
  });
}

export async function read_readiness(state, config, profile) {
  const empty = { state: "not_checked", mainReadiness: { scope: "setup_main", state: "not_checked" }, checks: [], scope: "setup", verificationLimits: verification_limits() };
  if (!config.active_project || profile.status && profile.status !== "loaded") return empty;
  const file = receipt_file(state, config.active_project);
  if (!exists(file)) return empty;
  try {
    const receipt = JSON.parse(read_readiness_file(file)), result = receipt.result;
    if (receipt.version !== 3) return { ...empty, reason: "Несовместимая версия readiness-подтверждения. Повторите setup-проверку; старые диагностические данные не загружаются." };
    if (result?.scope !== "setup" || !Number.isFinite(Date.parse(result.expiresAt)) || !Array.isArray(result?.checks) || !result.checks.length || !["ready", "blocked"].includes(result.state) || result.checks.some(item => !item || typeof item.id !== "string" || typeof item.label !== "string" || typeof item.state !== "string")) return empty;
    const age = Date.now() - Date.parse(result.checkedAt);
    const data = profile.status ? project_profile(config.active_project) : profile;
    if (!Number.isFinite(age) || age < 0 || typeof receipt.fingerprint !== "string" || !/^[a-f0-9]{64}$/.test(receipt.fingerprint))
      return { ...empty, reason: "Не удалось подтвердить сохранённую проверку готовности. Повторите проверку." };
    if (age > 15 * 60 * 1000 || Date.now() >= Date.parse(result.expiresAt) || receipt.knowledgeInvalidated || receipt.fingerprint !== readiness_fingerprint(state, config, data))
      return { ...result, state: "stale", mainReadiness: { scope: "setup_main", state: "stale" },
        ...(result.knowledge?.ready ? { knowledge: { ...result.knowledge, state: "not_verified", ready: false, koraReady: false, lifecycle: "configured", searchReadiness: "not_verified", readiness: { state: "not_verified" } } } : {}),
        checks: result.checks.map(item => item.id === "yaxunit" ? { ...yaxunit_result("check_stale"), label: item.label, lastState: item.state, checkedAt: result.checkedAt, expiresAt: result.expiresAt } : item.id === "knowledge" && result.knowledge?.ready ? { ...item, state: "not_verified", detail: "Подтверждение поиска требует повторной проверки." } : item.id === "bsl-ls" && item.state === "ready" ? bsl_api_observed(item, { external: !local_bsl(config) }) : item),
        verificationLimits: verification_limits(), reason: "Настройки или файлы изменились либо проверка устарела. Повторите проверку готовности." };
    if ((result.state === "ready") !== result.checks.every(item => passed(item, data)))
      return { ...empty, reason: "Сохранённый результат не соответствует обязательным компонентам. Повторите проверку готовности." };
    // Addressed EDT and YaXUnit checks can resolve (or introduce) their blockers.
    // Keep the original receipt's age and expiry: partial checks never renew it.
    const observations = read_component_checks(state, config, data);
    const saved = observations.find(item => item.id === "yaxunit");
    const previous = result.checks.find(item => item.id === "yaxunit");
    const yaxunit = data.testing?.yaxunit !== true ? yaxunit_unchecked(data) : saved && (!previous || Date.parse(saved.checkedAt) >= Date.parse(result.checkedAt)) ? saved : previous || yaxunit_unchecked(data);
    const replacement = { ...yaxunit, label: "YaXUnit" };
    const projected = new Map(observations.filter(item => ["edt", "v8std", "openviking", "code-index", "bsl-ls"].includes(item.id) && Date.parse(item.checkedAt) >= Date.parse(result.checkedAt)).map(item => [item.id, item]));
    const current = result.checks.map(item => {
      const check = projected.has(item.id) ? { ...projected.get(item.id), label: item.label } : item;
      return check.id === "bsl-ls" && check.state === "ready" ? bsl_api_observed(check, { external: !local_bsl(config) }) : check;
    });
    const checks = previous ? current.map(item => item.id === "yaxunit" ? replacement : item) : [...current, replacement];
    return { ...result, checks, ...setup_states(checks, data), verificationLimits: verification_limits(result.knowledge?.ready === true) };
  } catch { return empty; }
}
