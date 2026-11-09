import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { stringify } from "../vendor/deps.mjs";
import { read_project_archive, write_project_archive } from "./archives.mjs";
import {
  ConfigError,
  barrier_recovery_hint,
  atomic_write,
  check_schema,
  deep_merge,
  dump,
  inside,
  load,
  operation_lock,
  settings,
  validate_settings,
  validate_url,
  validate_openviking_url,
  parse,
  parse_yaml_document,
  safe_profile_dictionary_path,
  object,
  stable,
  entrypoint,
} from "./common.mjs";
import {
  backup,
  profile_target,
  project_profile,
  merged_profile,
  create_profile,
  profile_state,
  scoped_paths,
} from "./profile.mjs";
import { effective_policy } from "./action_policy.mjs";
import {
  configuration_root,
  ProfileNotFound,
  ProfileAmbiguous,
  reconnect_file,
  instance_name,
  resolve,
  exists,
  contained,
  is_dir,
  sha256,
  locate_project,
  record_project_owner,
  path_identity,
} from "./project_paths.mjs";
import {
  resolved_settings,
  effective_settings,
  external_override_files,
  assert_settings_paths,
} from "./project_context.mjs";
import { managed_components, component_enabled, grant_preparation, preparation_identity, require_preparation, component_settings, native_environment } from "./components.mjs";
import { directory_context, edt_connection, edt_port_suggestion, index_repositories, repository_projects } from "./directory_context.mjs";
import { profile_history, profile_hidden, remember_profile, profile_summary } from "./profile_history.mjs";
import { read_readiness, save_readiness, read_component_checks, component_statuses, save_component_checks, begin_component_checks, component_checks_current, component_check_current, component_fingerprint, readiness_receipt_revision, readiness_fingerprint, bsl_readiness_fingerprint, bsl_api_observed, readiness_priority_current, foreground_readiness_active, reserve_component_flights, complete_component_flights, component_flight_result, capture_component_flights, abandon_component_flight, vanessa_runtime_snapshot } from "./setup_readiness.mjs";
import { open_reader, reader_active } from "./reader_lease.mjs";
import { capture_index_snapshot } from "./index_snapshot.mjs";
import { probe_yaxunit, yaxunit_result } from "./yaxunit_readiness.mjs";
import { project_directory } from "./project_paths.mjs";
import { knowledge_status } from "./knowledge.mjs";
import { alive, which } from "./processes.mjs";
import { read_regular_file } from "./bounded_file.mjs";
import { linux_require_parent } from "./unix_process.mjs";

function index_process_may_exist(home) {
  for (const name of ["daemon.json", "owner.json"]) {
    try {
      const data = JSON.parse(fs.readFileSync(path.join(home, name), "utf8"));
      if (!Number.isSafeInteger(data?.pid) || data.pid <= 0 || alive(data.pid)) return true;
    } catch (error) { if (error.code !== "ENOENT") return true; }
  }
  return false;
}
function index_observation_detail(state) {
  return ({ ready: "Сервис подтвердил актуальность индексов выбранных репозиториев.",
    indexing: "Индексация ещё выполняется.", stale: "Один или несколько индексов устарели.",
    missing: "Индекс для одного или нескольких репозиториев не найден.",
    missing_project: "Не найден или неоднозначно определён назначенный проект EDT.",
    mismatch: "Пути или псевдонимы репозиториев сервиса не совпадают с профилем.",
    error: "Сервис сообщил об ошибке одного или нескольких индексов.",
    not_checked: "API индекса не предоставил данные об актуальности каждого репозитория.",
    not_verified: "API индекса не подтвердил актуальность каждого репозитория." })[state] || "API индекса вернул неподдерживаемое состояние.";
}

// Ensure the local layer is ignored before writing it. Retain an existing
// exact rule unless a later negation might override it.
function local_ignore_plan(root) {
  const nominal = path.join(root, ".ai", ".gitignore"), target = inside(root, ".ai/.gitignore");
  const stat = fs.lstatSync(nominal, { throwIfNoEntry: false });
  if (stat && (!stat.isFile() || stat.isSymbolicLink())) throw new ConfigError("Файл .ai/.gitignore должен быть обычным файлом.");
  const previous = stat ? fs.readFileSync(target) : null;
  const original = previous?.toString("utf8") ?? "";
  if (previous && !Buffer.from(original, "utf8").equals(previous)) throw new ConfigError("Файл .ai/.gitignore должен быть в UTF-8.");
  let directory = root;
  while (!exists(path.join(directory, ".git")) && path.dirname(directory) !== directory) directory = path.dirname(directory);
  const repository = exists(path.join(directory, ".git")); let gitVerified = false;
  if (repository) {
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith("GIT_")));
    const result = spawnSync("git", ["--no-optional-locks", "-C", root, "ls-files", "--error-unmatch", "--", ".ai/project.local.yaml"], { env, windowsHide: true, shell: false, timeout: 2000, encoding: "utf8" });
    if (result.status === 0) throw new ConfigError(".ai/project.local.yaml уже отслеживается Git; правило игнорирования его не защитит. Уберите файл из индекса самостоятельно.");
    gitVerified = result.status === 1;
  }
  let protectedByRule = false;
  for (const line of original.split(/\r?\n/)) {
    if (line.startsWith("!")) protectedByRule = false;
    else if (/^\/?project\.local\.yaml *$/.test(line)) protectedByRule = true;
  }
  const next = protectedByRule ? original : original + (original && !original.endsWith("\n") ? "\n" : "") + "/project.local.yaml\n";
  return { target, previous, next, changed: next !== original,
    gitWarning: repository && !gitVerified ? "Не удалось проверить индекс Git: правило игнорирования не защищает уже отслеживаемый файл project.local.yaml. Проверьте индекс самостоятельно." : null };
}
function protect_local_layer(root, expected) {
  const plan = local_ignore_plan(root), current = fs.existsSync(plan.target) ? fs.readFileSync(plan.target) : null;
  const same = (a,b) => a === null ? b === null : b !== null && a.equals(b);
  if (!same(plan.previous, current) || expected && (!same(plan.previous, expected.previous) || plan.next !== expected.next)) throw new ConfigError("Файл .ai/.gitignore изменился во время сохранения.");
  if (plan.changed) atomic_write(plan.target, plan.next, plan.previous !== null);
  return plan;
}
function restore_local_ignore(plan) {
  if (!plan?.changed) return;
  const now = fs.existsSync(plan.target) ? fs.readFileSync(plan.target) : null;
  if (!now || !now.equals(Buffer.from(plan.next))) throw new ConfigError("Файл .ai/.gitignore изменился после сохранения и не был восстановлен.");
  restore(plan.target, plan.previous);
}
function rollback_layer(target, previous, expected, wrote, ignorePlan, error, backupPath) {
  const failed = [];
  if (wrote) try {
    const current = bytes(target);
    if (expected !== null && (current === null || !current.equals(Buffer.from(expected)))) throw new Error("changed");
    restore(target, previous);
  } catch { failed.push(target); }
  try { restore_local_ignore(ignorePlan); } catch { failed.push(ignorePlan.target); }
  if (failed.length) throw new ConfigError("Не удалось восстановить файлы: " + failed.join(", ") + (backupPath ? ". Резервная копия: " + backupPath : ""));
  throw error;
}
import { diagnostic_failure, environment_compatibility, safe_error_message, sanitize_setup_result } from "./diagnostics.mjs";

// Field edits operate on the supplied draft. Unrelated source is kept intact.
// Shared aliases are detached when necessary so editing one field cannot
// silently change another field that happens to reference the same anchor.
export function patch_yaml_draft(text, operation) {
  if (typeof text !== "string" || Buffer.byteLength(text) > 2 * 1024 * 1024) throw new ConfigError("Документ превышает 2 МиБ.");
  const bom = text.startsWith("\uFEFF") ? "\uFEFF" : "", source = bom ? text.slice(1) : text;
  const data = parse(source), doc = parse_yaml_document(source), keys = operation?.path;
  if (!Array.isArray(keys) || !keys.length || keys.length > 64 || keys.some((key, index) =>
    !(typeof key === "string" || Number.isSafeInteger(key)) ||
    ["__proto__", "prototype", "constructor"].includes(key) &&
      !(index === keys.length - 1 && safe_profile_dictionary_path(keys) &&
        (operation.kind === "remove" || operation.kind === "set" && typeof operation.value === "string"))))
    throw new ConfigError("Некорректный путь поля.");
  const prefix = (a,b) => a.length <= b.length && a.every((part,index) => String(part) === String(b[index]));
  const anchors = new Set(), anchorPaths = new Map(), aliases = [];
  const walk = (node, current) => {
    if (!node || typeof node !== "object") return;
    if (node.anchor) { anchorPaths.set(node.anchor,current); if (prefix(current,keys) || prefix(keys,current)) anchors.add(node.anchor); }
    if (node.constructor?.name === "Alias") aliases.push({ node, path: current });
    else if (Array.isArray(node.items)) node.items.forEach((item,index) => item.key ? walk(item.value,[...current,item.key.value]) : walk(item,[...current,index]));
  };
  walk(doc.contents, []);
  const detach = aliases.filter(alias => prefix(alias.path,keys) || anchors.has(alias.node.source));
  if (detach.length) {
    let expanded = source;
    for (const alias of detach.sort((a,b) => b.node.range[0]-a.node.range[0])) {
      let value = data; for (const part of alias.path) value = value?.[part];
      // Merge aliases are not represented as a `<<` property by toJS.
      if (value === undefined && anchorPaths.has(alias.node.source)) { value = data; for (const part of anchorPaths.get(alias.node.source)) value = value?.[part]; }
      let replacement; try { replacement = JSON.stringify(value); } catch { throw new ConfigError("Не удалось безопасно отделить циклическую YAML-ссылку."); }
      if (replacement === undefined) throw new ConfigError("Не удалось безопасно отделить YAML-ссылку.");
      expanded = expanded.slice(0,alias.node.range[0]) + replacement + expanded.slice(alias.node.range[1]);
    }
    const result = patch_yaml_draft(bom + expanded, operation);
    return { ...result, reformatted: true };
  }
  let parent = data;
  for (const key of keys.slice(0, -1)) {
    if (!parent || typeof parent !== "object" || !Object.hasOwn(parent, key)) throw new ConfigError("Поле больше не существует.");
    parent = parent[key];
  }
  const key = keys.at(-1), existsKey = parent && typeof parent === "object" && Object.hasOwn(parent, key);
  if (!parent || typeof parent !== "object") throw new ConfigError("Некорректная структура поля.");
  let targetPath = keys, next;
  // A merge key can provide a value with no node of its own. Writing the
  // property must add an explicit override without changing the anchor.
  const inheritedSet = operation.kind === "set" && existsKey && !doc.getIn(keys,true);
  const inheritedRemove = operation.kind === "remove" && existsKey && !doc.getIn(keys,true);
  if (inheritedSet) {
    Object.defineProperty(parent,key,{ value: operation.value, enumerable:true, configurable:true, writable:true });
    targetPath = keys.slice(0,-1); next = parent;
  }
  else if (inheritedRemove) { delete parent[key]; targetPath = keys.slice(0,-1); next = parent; }
  else if (operation.kind === "set" && existsKey) next = operation.value;
  else {
    targetPath = keys.slice(0, -1);
    if (operation.kind === "set" && !Array.isArray(parent)) Object.defineProperty(parent, key, { value: operation.value, enumerable: true, configurable: true, writable: true });
    else if (operation.kind === "remove" && existsKey) Array.isArray(parent) ? parent.splice(Number(key), 1) : delete parent[key];
    else if (operation.kind === "append" && Array.isArray(parent) && Number(key) === parent.length) parent.push(operation.value);
    else if (operation.kind === "move" && Array.isArray(parent) && existsKey && Number.isInteger(operation.to) && operation.to >= 0 && operation.to < parent.length) parent.splice(operation.to, 0, parent.splice(Number(key), 1)[0]);
    else throw new ConfigError("Недопустимое изменение поля.");
    next = parent;
  }
  if (operation.kind === "remove" && existsKey && !inheritedRemove && !Array.isArray(parent)) {
    const parentNode = keys.length > 1 ? doc.getIn(keys.slice(0,-1),true) : doc.contents;
    if (parentNode?.items?.some(item => item.key?.source === "<<" && typeof item.key.value === "symbol")) {
      // Removing an explicit override reveals the merged value, rather than
      // removing the effective key from the document altogether.
      const after = parse_yaml_document(source); after.deleteIn(keys);
      let effective = parse(after.toString()); for (const part of keys.slice(0,-1)) effective = effective?.[part];
      if (effective && Object.hasOwn(effective,key)) Object.defineProperty(parent,key,{value:effective[key],enumerable:true,configurable:true,writable:true});
    }
  }
  const node = targetPath.length ? doc.getIn(targetPath, true) : doc.contents;
  if (!node?.range) throw new ConfigError("Это значение можно изменить в режиме YAML.");
  if (node.constructor?.name === "Alias") throw new ConfigError("Не удалось безопасно отделить YAML-ссылку.");
  const [start, end] = node.range, old = source.slice(start, end);
  const matches = candidate => { try { return stable(parse(candidate)) === stable(data); } catch { return false; } };
  const patchCollectionAst = () => {
    const changed = parse_yaml_document(source), collection = targetPath.length ? changed.getIn(targetPath,true) : changed.contents;
    if (!collection || !Array.isArray(collection.items)) throw new ConfigError("Не удалось изменить коллекцию YAML.");
    if (operation.kind === "move") collection.items.splice(operation.to,0,collection.items.splice(Number(key),1)[0]);
    else if (inheritedRemove) {
      // YAML merge has no syntax for excluding a key: materialize the
      // remaining inherited values as explicit properties in this map.
      collection.items = collection.items.filter(item => !(item.key?.source === "<<" && typeof item.key.value === "symbol"));
      for (const [name,value] of Object.entries(parent)) if (!collection.has(name)) collection.set(name,value);
    }
    else if (operation.kind === "remove") changed.deleteIn(keys);
    else if (operation.kind === "append") collection.add(changed.createNode(operation.value));
    else if (operation.kind === "set") changed.setIn(keys,operation.value);
    else throw new ConfigError("Недопустимое изменение поля.");
    const rendered = changed.toString(), parsed = parse_yaml_document(rendered), renderedNode = targetPath.length ? parsed.getIn(targetPath,true) : parsed.contents;
    if (!renderedNode?.range) throw new ConfigError("Не удалось подготовить коллекцию YAML.");
    const [newStart,newEnd] = renderedNode.range, lineStart = (value,offset) => value.lastIndexOf("\n",offset-1)+1;
    const oldIndent = source.slice(lineStart(source,start),start).match(/^ */)?.[0] || "", newIndent = rendered.slice(lineStart(rendered,newStart),newStart).match(/^ */)?.[0] || "";
    let replacement = rendered.slice(newStart,newEnd);
    if (oldIndent !== newIndent) replacement = replacement.replace(/\n( *)/g,(_,spaces) => "\n" + oldIndent + spaces.slice(newIndent.length));
    if (source.includes("\r\n")) replacement = replacement.replace(/(?<!\r)\n/g,"\r\n");
    const lineEnd = old.match(/(?:\r\n|\r|\n)$/)?.[0];
    if (lineEnd && !/(?:\r\n|\r|\n)$/.test(replacement)) replacement += lineEnd;
    // Preserve comments the YAML serializer associates with a removed item.
    // They are moved immediately before the affected collection and the UI
    // explicitly reports that the edited block was reformatted.
    const comments = [], collectComments = item => {
      if (!item || typeof item !== "object") return;
      for (const value of [item.commentBefore,item.comment]) if (typeof value === "string") for (const line of value.split("\n")) comments.push("#" + line);
      if (item.key) { collectComments(item.key); collectComments(item.value); }
      if (Array.isArray(item.items)) item.items.forEach(collectComments);
    };
    collectComments(node); const missing = [];
    for (const comment of comments) if (old.includes(comment) && !replacement.includes(comment) && !missing.includes(comment)) missing.push(comment);
    const beginning = lineStart(source,start), newline = source.includes("\r\n") ? "\r\n" : "\n";
    const prefixComments = missing.map(comment => oldIndent + comment + newline).join("");
    const result = bom + source.slice(0,beginning) + prefixComments + source.slice(beginning,start) + replacement + source.slice(end);
    if (!matches(result)) throw new ConfigError("Не удалось безопасно изменить коллекцию YAML.");
    return { text: result, reformatted: true };
  };
  if (inheritedSet || inheritedRemove) return patchCollectionAst();
  // For flow collections, keep each original entry and its surrounding
  // separators instead of rewriting all siblings as JSON.
  if (targetPath.length !== keys.length && node.flow && Array.isArray(node.items) && !/[#&*]/.test(old)) {
    const ranges = node.items.map(item => item.key
      ? [item.key.range?.[0], item.value?.range?.[1] ?? item.key.range?.[1]]
      : [item.range?.[0], item.range?.[1]]);
    if (ranges.every(([a, b]) => Number.isInteger(a) && Number.isInteger(b) && a >= start && b <= end && a <= b)) {
      let body = source.slice(start, end), replacement;
      if (operation.kind === "append" || operation.kind === "set" && !existsKey) {
        const addition = operation.kind === "append" ? JSON.stringify(operation.value) : JSON.stringify(key) + ": " + JSON.stringify(operation.value);
        const close = body.length - 1;
        replacement = body.slice(0, close) + (ranges.length ? ", " : "") + addition + body.slice(close);
      } else if (ranges.length) {
        const index = Array.isArray(parent) ? Number(key) : node.items.findIndex(item => item.key?.value === key);
        if (index >= 0 && index < ranges.length) {
          const entries = ranges.map(([a, b]) => source.slice(a, b));
          const separators = ranges.slice(1).map(([a], i) => source.slice(ranges[i][1], a));
          if (operation.kind === "remove") {
            entries.splice(index, 1);
            separators.splice(index === 0 ? 0 : index - 1, 1);
          } else if (operation.kind === "move") entries.splice(operation.to, 0, entries.splice(index, 1)[0]);
          if (operation.kind === "remove" || operation.kind === "move") {
            replacement = source.slice(start, ranges[0][0]) + entries.map((entry, i) => (i ? separators[i - 1] : "") + entry).join("") + source.slice(ranges.at(-1)[1], end);
          }
        }
      }
      if (replacement !== undefined) {
        const result = bom + source.slice(0, start) + replacement + source.slice(end);
        if (matches(result)) return { text: result, reformatted: false };
      }
    }
  }
  // Work on complete block entries instead of serializing their parent. This
  // keeps spelling, indentation and comments on every untouched entry.
  if (targetPath.length !== keys.length && !node.flow && Array.isArray(node.items) && node.items.length) {
    const lineStart = offset => source.lastIndexOf("\n", offset - 1) + 1;
    const starts = node.items.map(item => lineStart((item.key || item).range?.[0] ?? -1));
    // A standalone comment immediately before an entry travels with that
    // entry when a sequence is reordered.
    for (let i = 1; i < starts.length; i++) {
      let cursor = starts[i];
      while (cursor > starts[i-1]) {
        const previous = lineStart(cursor - 1), line = source.slice(previous,cursor);
        if (!/^\s*#/.test(line)) break;
        starts[i] = previous; cursor = previous;
      }
    }
    const firstLine = lineStart(start), indent = source.slice(firstLine, start);
    if (/^ *$/.test(indent) && starts.every((offset, index) => offset >= firstLine && (index === 0 || offset > starts[index - 1]))) {
      const newline = source.includes("\r\n") ? "\r\n" : "\n";
      let result;
      if (operation.kind === "append" || operation.kind === "set" && !existsKey) {
        const separator = /(?:\r\n|\n|\r)$/.test(old) ? "" : newline;
        const addition = operation.kind === "append" ? "- " + JSON.stringify(operation.value) : JSON.stringify(key) + ": " + JSON.stringify(operation.value);
        result = bom + source.slice(0, end) + separator + indent + addition + newline + source.slice(end);
      } else {
        const index = Array.isArray(parent) ? Number(key) : node.items.findIndex(item => item.key?.value === key);
        if (index >= 0 && index < starts.length && starts.length > 1) {
          const parts = starts.map((offset, i) => source.slice(offset, starts[i + 1] ?? end));
          let relocated = false;
          if (operation.kind === "remove") {
            // Standalone comments may belong to a neighbouring entry; retain
            // them even when deleting this entry.
            let comments = parts[index].split(/(?<=\n)/).filter(line => /^\s*#/.test(line)).join("");
            const collect = item => {
              if (!item || typeof item !== "object") return;
              for (const value of [item.commentBefore,item.comment]) if (typeof value === "string") for (const line of value.split("\n")) if (!comments.includes("#"+line)) { comments += indent+"#"+line+newline; relocated = true; }
              if (item.key) { collect(item.key); collect(item.value); }
              if (Array.isArray(item.items)) item.items.forEach(collect);
            };
            collect(node.items[index]);
            parts.splice(index, 1, comments);
          } else if (operation.kind === "move") parts.splice(operation.to, 0, parts.splice(index, 1)[0]);
          if (operation.kind === "remove" || operation.kind === "move") {
            result = bom + source.slice(0, starts[0]) + parts.join("") + source.slice(end);
            if (matches(result)) return { text: result, reformatted: relocated };
          }
        }
      }
      if (result && matches(result)) return { text: result, reformatted: false };
    }
  }
  if (next !== null && typeof next === "object" && /[#&*]/.test(old)) {
    // Adding a member to a block collection does not require reserializing its
    // existing members or their comments. Other structural edits remain
    // conservative until their source ranges can be retained safely.
    if (!node.flow && (operation.kind === "append" || operation.kind === "set" && !existsKey)) {
      const lineStart = source.lastIndexOf("\n", start - 1) + 1, indent = source.slice(lineStart, start);
      if (/^ *$/.test(indent)) {
        const newline = source.includes("\r\n") ? "\r\n" : "\n", separator = /(?:\r\n|\n|\r)$/.test(old) ? "" : newline;
        const addition = operation.kind === "append" ? "- " + JSON.stringify(operation.value) : JSON.stringify(key) + ": " + JSON.stringify(operation.value);
        const result = bom + source.slice(0, end) + separator + indent + addition + newline + source.slice(end);
        if (matches(result)) return { text: result, reformatted: false };
      }
    }
    return patchCollectionAst();
  }
  const replacement = JSON.stringify(next);
  if (replacement === undefined) throw new ConfigError("Некорректное значение поля.");
  const trailingLineEnd = old.match(/(?:\r\n|\r|\n)$/)?.[0] || "";
  const result = bom + source.slice(0, start) + replacement + trailingLineEnd + source.slice(end);
  // Reject surprising YAML constructs rather than silently editing a different value.
  const expected = structuredClone(data);
  if (operation.kind === "set" && existsKey) {
    let target = expected;
    for (const part of keys.slice(0, -1)) target = target[part];
    Object.defineProperty(target, key, { value: operation.value, enumerable: true, configurable: true, writable: true });
  }
  if (stable(parse(result)) !== stable(expected)) throw new ConfigError("Это изменение неоднозначно в YAML. Используйте текстовый режим.");
  return { text: result, reformatted: next !== null && typeof next === "object" };
}

export const FIELDS = {
  projectRoot: ["active_project"],
  edtUrl: ["mcp", "required", "edt", "url"],
  v8stdUrl: ["mcp", "required", "v8std", "url"],
  codeIndexEnabled: ["mcp", "managed", "code-index", "enabled"],
  bslLsEnabled: ["mcp", "managed", "bsl-ls", "enabled"],
  codeIndexVersion: ["mcp", "managed", "code-index", "version"],
  codeIndexAllowPrerelease: ["mcp", "managed", "code-index", "allow_prerelease"],
  bslLsVersion: ["mcp", "managed", "bsl-ls", "version"],
  bslLsAllowPrerelease: ["mcp", "managed", "bsl-ls", "allow_prerelease"],
  bslLsJava: ["mcp", "managed", "bsl-ls", "java"],
  openvikingEnabled: ["mcp", "optional", "openviking", "enabled"],
  openvikingUrl: ["mcp", "optional", "openviking", "url"],
  openvikingTimeout: ["mcp", "optional", "openviking", "timeout_seconds"],
  openvikingMaxResponseBytes: ["mcp", "optional", "openviking", "max_response_bytes"],
  openvikingConnectionId: ["mcp", "optional", "openviking", "connection_id"],
};
const bytes = (file) => (file && exists(file) ? fs.readFileSync(file) : null);
const revision_bytes = file => {
  const content = bytes(file);
  return content === null ? Buffer.from("missing\0") : Buffer.concat([Buffer.from(`present:${content.length}\0`), content]);
};
const restore = (file, previous) => {
  if (previous === null) fs.rmSync(file, { force: true });
  else atomic_write(file, previous);
};
function patch_yaml_document(original, desired) {
  if (original === null) return stringify(desired, { schema: "yaml-1.1" });
  let text = original ?? "{}\n";
  const visit = (before, after, keys = []) => {
    if (object(before) && object(after)) {
      for (const key of Object.keys(before)) if (!Object.hasOwn(after, key)) {
        text = patch_yaml_draft(text, { kind: "remove", path: [...keys, key] }).text;
        // Removing an explicit property may reveal a merged value. Scoped
        // reset means the property must be absent from the effective layer.
        let current = parse(text); for (const part of keys) current = current?.[part];
        if (current && Object.hasOwn(current,key)) text = patch_yaml_draft(text, { kind: "remove", path: [...keys, key] }).text;
      }
      for (const [key, value] of Object.entries(after)) {
        if (!Object.hasOwn(before, key)) text = patch_yaml_draft(text, { kind: "set", path: [...keys, key], value }).text;
        else visit(before[key], value, [...keys, key]);
      }
    } else if (stable(before) !== stable(after)) {
      if (!keys.length) throw new ConfigError("Измените документ в режиме YAML.");
      text = patch_yaml_draft(text, { kind: "set", path: keys, value: after }).text;
    }
  };
  visit(parse(text), desired);
  if (stable(parse(text)) !== stable(desired)) throw new ConfigError("Не удалось подготовить изменение YAML.");
  return text;
}
function backup_local_settings(state, root, previous) {
  if (previous === null) return null;
  const saved = path.join(state, "backups", `settings-${randomUUID()}.yaml`), actual = resolve(saved);
  if (contained(resolve(root), actual)) throw new ConfigError("Резервная копия локальных настроек должна находиться вне проекта и Git-репозитория.");
  for (let directory = path.dirname(actual); ; directory = path.dirname(directory)) {
    if (exists(path.join(directory, ".git"))) throw new ConfigError("Резервная копия локальных настроек должна находиться вне проекта и Git-репозитория.");
    if (path.dirname(directory) === directory) break;
  }
  atomic_write(saved, previous, false);
  return saved;
}
function layer_changes(before, after) {
  const changes = [];
  let truncated = false;
  const visit = (oldValue, newValue, keys, present = true) => {
    if (stable(oldValue) === stable(newValue) && present) return;
    if (object(oldValue) && object(newValue) && present) {
      for (const key of [...new Set([...Object.keys(oldValue), ...Object.keys(newValue)])].sort())
        visit(oldValue[key], newValue[key], [...keys, key], Object.hasOwn(newValue, key));
    } else if (changes.length < 100) changes.push({ path: keys.join("."), ...(present ? { value: newValue } : { removed: true }) });
    else truncated = true;
  };
  visit(before, after, []);
  return { changes, truncated };
}
function validate_override_urls(document) {
  // Validate the document itself: a higher-priority override can hide an
  // invalid or credential-bearing URL from effective-settings validation.
  for (const [name, entry] of Object.entries(document.connections || {}))
    if (entry.url) name === "openviking" ? validate_openviking_url(entry.url) : validate_url(entry.url, name);
  for (const [name, entry] of Object.entries(document.components || {}))
    if (entry.url) validate_url(entry.url, name);
}
function connection_url(name, value) {
  if (!value) return "";
  return name === "openviking" ? validate_openviking_url(value) : validate_url(value, name);
}
function import_compatibility(profile, root) {
  if (!profile || !root) return { missingPaths: [], edtMappings: [] };
  const missingPaths = [...new Set(scoped_paths(profile))].filter(relative => !exists(inside(root, relative)));
  const repositories = profile.repositories.filter(repo => repo.edt_project);
  const edtMappings = repositories.map(repo => {
    let status = "unavailable";
    try {
      const count = repository_projects(root, [repo])[0].projects.length;
      status = count === 1 ? "detected" : count > 1 ? "ambiguous" : "not_detected";
    } catch { /* Keep unavailable distinct from missing. */ }
    return { repository: repo.id, project: repo.edt_project, status };
  });
  return { missingPaths, edtMappings };
}
export const preparation_scope = (root) =>
  root ? `${root}#${instance_name()}` : null;
export const session_guidance = "Профиль определяется по папке текущего чата. Если подключения не видят проект, сообщите агенту путь к его папке в этом чате. Привязка подключений к проекту действует только в текущем чате. Для подготовки сервисов нажмите «Подготовить и проверить».";
export function authorize_preparation(request, root) {
  const auth = request.authorization;
  if (
    !object(auth) ||
    Object.keys(auth).sort().join(",") !== "effects,evidence,scope" ||
    stable(auth.effects) !== '["launch"]' ||
    typeof auth.evidence !== "string" ||
    !auth.evidence.trim()
  )
    throw new ConfigError(
      "Подготовка MCP требует разрешения запуска сервисов.",
    );
  if (auth.scope !== preparation_scope(root))
    throw new ConfigError(
      "Разрешение подготовки относится к другой папке или экземпляру.",
    );
}
function bsl_configuration_error(config) {
  const selected = config.mcp.managed["bsl-ls"].configuration;
  if (!selected) return null;
  try {
    const file = path.isAbsolute(selected) ? selected : inside(config.active_project, selected);
    const actual = fs.realpathSync.native(file), input = read_regular_file(actual, 16 * 1024 * 1024);
    if (!input) return "Файл конфигурации BSL LS недоступен. Проверьте путь в настройках.";
    let value;
    try { value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(input.bytes).replace(/^\uFEFF/, "")); }
    catch { return "В файле конфигурации BSL LS некорректный JSON. Исправьте синтаксис и повторите проверку."; }
    return value && typeof value === "object" && !Array.isArray(value) ? null : "Конфигурация BSL LS должна быть JSON-объектом.";
  } catch { return "Файл конфигурации BSL LS недоступен или его нельзя безопасно прочитать. Проверьте путь и права."; }
}
async function bsl_check_inputs(state, config, runtime, allowInstall, refresh = false) {
  const configurationError = bsl_configuration_error(config);
  if (configurationError) throw new ConfigError(configurationError);
  const jar = await runtime.installed_runtime(state, config, "bsl-ls", refresh, allowInstall, allowInstall ? 120 : 1);
  return operation_lock(state, () => {
    if (runtime.artifact(state, "bsl-ls") !== jar) throw Object.assign(new ConfigError("Версия BSL LS изменилась. Повторите проверку."), { inputsChanged: true });
    return { jar, inputRevision: bsl_readiness_fingerprint(state, config) };
  });
}
export class SettingsBackend {
  constructor(
    state = process.env.EDT_AI_STATE_DIR,
    config = process.env.EDT_AI_SETTINGS,
    { observeIndex = null } = {},
  ) {
    this.STATE = state;
    this.CONFIG = config;
    this.observeIndex = observeIndex;
    if (!state || !config)
      throw new ConfigError(
        "Сервису настроек нужны пути состояния и настроек",
      );
  }
  current(allowAmbiguous = false) {
    const config = settings(this.CONFIG);
    config.state_dir = this.STATE;
    // EDT is bound per project or instance, never by a saved global URL.
    config.mcp.required.edt.url = "";
    const normalize = directory => {
      try { return configuration_root(directory); }
      catch (error) {
        if (allowAmbiguous && error instanceof ProfileAmbiguous) return resolve(directory);
        throw error;
      }
    };
    if (process.env.EDT_AI_PROJECT_ROOT) {
      const selected = normalize(process.env.EDT_AI_PROJECT_ROOT);
      config.active_project = selected;
    } else if (Object.hasOwn(process.env, "EDT_AI_PROJECT_ROOT")) {
      config.active_project = null;
      config.mcp.required.edt.url = "";
    } else if (config.active_project && is_dir(config.active_project))
      config.active_project = normalize(config.active_project);
    return config;
  }
  effective(config, override = null, profile = null, with_sources = false) {
    let fieldSources = {};
    let sources = Object.fromEntries(
      Object.entries(config.mcp.required).map(([name, item]) => [
        name,
        name !== "edt" && item.url ? "settings" : "unconfigured",
      ]),
    );
    if (config.active_project) {
      let root,
        data = profile;
      try {
        root = locate_project(config.active_project);
        if (data === null)
          data = project_profile(root);
      } catch (error) {
        if (!(error instanceof ProfileNotFound)) throw error;
        root = configuration_root(config.active_project);
      }
      [config, sources, fieldSources] = resolved_settings(config, root, data, override);
    }
    return with_sources ? [config, sources, fieldSources] : config;
  }
  values(config, applyEffective = true) {
    if (applyEffective) config = this.effective(config);
    return Object.fromEntries(
      Object.entries(FIELDS).map(([name, parts]) => {
        let item = config;
        for (const part of parts) item = object(item) ? item[part] : null;
        return [name, item == null ? "" : structuredClone(item)];
      }),
    );
  }
  checked(config) {
    validate_settings(config);
    if (config.active_project && !is_dir(config.active_project))
      throw new ConfigError(
        "Папка проекта не найдена. Укажите папку на этом компьютере.",
      );
    return config;
  }
  setting_scope_data(config, profile, effective = null, sources = {}, fieldSources = {}) {
    const root = config.active_project;
    if (!root || profile.status !== "loaded") return { layerValues: {}, localOverridePaths: [] };
    const files = { profile: profile_target(root), project_local: inside(root, ".ai/project.local.yaml") };
    const layers = {}, localOverridePaths = [];
    for (const [scope, file] of Object.entries(files)) {
      const document = exists(file) ? load(file) : {}, fields = {};
      if (scope !== "profile" && exists(file)) {
        check_schema(document, "project-local.schema.json");
        validate_override_urls(document);
      }
      for (const [key, parts] of Object.entries(FIELDS)) {
        const name = key.startsWith("openviking") ? "openviking" : key === "edtUrl" ? "edt" : key === "v8stdUrl" ? "v8std" : null;
        const entry = name ? document.connections?.[name] : parts[1] === "managed" ? document.components?.[parts[2]] : null;
        if (entry && Object.hasOwn(entry, parts.at(-1))) fields[key] = structuredClone(entry[parts.at(-1)]);
      }
      layers[scope] = fields;
      if (scope === "project_local") {
        const collect = (value, parts = []) => {
          if (value === null || typeof value !== "object" || Array.isArray(value) || parts.at(-1) === "headers_env") localOverridePaths.push(parts);
          else for (const [key, child] of Object.entries(value)) collect(child, [...parts, key]);
        };
        collect(document);
      }
    }
    layers.global = Object.fromEntries(Object.entries(FIELDS).filter(([, parts]) => parts[1] === "managed").map(([key, parts]) => [key, structuredClone(config.mcp.managed[parts[2]]?.[parts.at(-1)])]).filter(([, value]) => value !== undefined));
    if (!effective) return { layerValues: layers, localOverridePaths };
    // Read-only presentation metadata. Resolution stays in project_profile and
    // resolved_settings; the form never computes its own effective settings.
    const configurationValues = structuredClone(project_profile(root));
    const configurationSources = {};
    const prefix = (a, b) => a.length <= b.length && a.every((part, index) => String(part) === String(b[index]));
    const collectSources = (value, parts = [], source = null) => {
      const origin = source || (localOverridePaths.some(path => prefix(path, parts)) ? "project_local" : "profile");
      configurationSources[JSON.stringify(parts)] = origin;
      if (value && typeof value === "object")
        for (const [key, child] of Object.entries(value)) collectSources(child, [...parts, Array.isArray(value) ? Number(key) : key], source);
    };
    collectSources(configurationValues);
    const schema = JSON.parse(fs.readFileSync(new URL("../schemas/project-profile.schema.json", import.meta.url), "utf8"));
    for (const section of ["connections", "components"]) {
      for (const [name, definition] of Object.entries(schema.properties[section].properties)) {
        const entry = section === "components" ? effective.mcp.managed[name]
          : name === "openviking" ? effective.mcp.optional[name] : effective.mcp.required[name];
        for (const key of Object.keys(definition.properties)) {
          const variable = section === "connections" && key === "url_env" && Object.hasOwn(fieldSources.connectionVariables || {}, name);
          if (!variable && (!entry || !Object.hasOwn(entry, key))) continue;
          const value = variable ? fieldSources.connectionVariables[name] : entry[key];
          configurationValues[section] ||= {};
          configurationValues[section][name] ||= {};
          configurationValues[section][name][key] = structuredClone(value);
          const source = section === "connections" && key === "url" ? sources[name]
            : fieldSources[section]?.[name]?.[key];
          collectSources(value, [section, name, key], source || "settings");
        }
      }
    }
    return { layerValues: layers, localOverridePaths, configurationValues, configurationSources };
  }
  store_shared_settings(config) {
    const saved = settings(this.CONFIG);
    saved.state_dir = this.STATE;
    // Persist the resolved sections exactly: merging into the old values would
    // resurrect overrides removed by the manual editor.
    saved.mcp.managed = structuredClone(config.mcp.managed);
    saved.mcp.optional = structuredClone(config.mcp.optional);
    atomic_write(this.CONFIG, JSON.stringify(saved, null, 2) + "\n");
  }
  edit_revision() {
    const config = this.current();
    return this.revision(config, config.active_project ? profile_target(config.active_project) : null);
  }
  revision(config, target = null, payload = "") {
    if (config.active_project) {
      // A valid current profile defines the source boundary even when a
      // candidate profile would remove it. Invalid profiles remain repairable.
      let profile;
      try { profile = project_profile(config.active_project); }
      catch {
        // A broken local layer must remain repairable without losing the
        // independently valid shared profile's source boundaries.
        try { profile = load(profile_target(config.active_project)); check_schema(profile, "project-local.schema.json"); } catch { /* No usable shared profile. */ }
      }
      if (profile) assert_settings_paths(config, config.active_project, profile, this.STATE, this.CONFIG);
    }
    const chunks = [
      Buffer.from(stable(config)),
      Buffer.from(payload),
      revision_bytes(this.CONFIG),
    ];
    if (target)
      chunks.push(
        Buffer.from(resolve(target)),
        revision_bytes(target),
      );
    if (config.active_project) {
      // Track source revisions even when a higher-priority value masks them or
      // the imported document does not replace the current profile.
      for (const name of [".ai/project.yaml", ".ai/project.local.yaml"]) {
        const file = inside(config.active_project, name);
        chunks.push(Buffer.from(file), revision_bytes(file));
      }
      for (const file of external_override_files())
        chunks.push(Buffer.from(file), revision_bytes(file));
    }
    if (config.active_project)
      chunks.push(Buffer.from(stable(edt_connection(config.active_project))));
    return sha256(Buffer.concat(chunks));
  }
  lockedRoot() {
    return process.env.EDT_AI_SETTINGS_ROOT_LOCKED !== "0"
      ? process.env.EDT_AI_PROJECT_ROOT
      : null;
  }
  async update_scoped(changes, scope, expectedRevision, unset = []) {
    if (!["profile", "project_local", "global"].includes(scope))
      throw new ConfigError("Неизвестная область сохранения.");
    const connectionFields = ["edtUrl", "v8stdUrl", "openvikingEnabled", "openvikingUrl", "openvikingTimeout", "openvikingMaxResponseBytes", "openvikingConnectionId"];
    const componentFields = ["codeIndexEnabled", "bslLsEnabled", "bslLsJava", "codeIndexVersion", "bslLsVersion"];
    const allowed = scope === "global" ? ["bslLsJava", "codeIndexVersion", "bslLsVersion"] : [...connectionFields, ...componentFields];
    if ([...Object.keys(changes), ...unset].some(key => !allowed.includes(key)))
      throw new ConfigError("Эти настройки нельзя сохранить в выбранную область.");
    return operation_lock(this.STATE, () => {
      const config = this.current(), root = config.active_project;
      if (!root) throw new ConfigError("Выберите папку проекта.");
      let profile;
      try { profile = project_profile(root); } catch (error) { if (!(error instanceof ProfileNotFound)) throw error; }
      if (profile) assert_settings_paths(config, root, profile, this.STATE, this.CONFIG);
      const target = scope === "profile" ? profile_target(root) : scope === "project_local" ? inside(root, ".ai/project.local.yaml") : this.CONFIG;
      const previous = bytes(target), previousText = previous?.toString("utf8") ?? null;
      if (previous !== null && !Buffer.from(previousText, "utf8").equals(previous)) throw new ConfigError("Файл настроек должен быть в корректной кодировке UTF-8.");
      if (expectedRevision && expectedRevision !== this.revision(config, profile_target(root)))
        throw new ConfigError("Настройки изменились после загрузки. Обновите сведения и повторите сохранение.");
      let document;
      if (scope === "profile") document = previousText === null ? load(target) : parse(previousText);
      else if (scope === "global") document = config;
      else {
        document = previousText === null ? {} : parse(previousText);
        if (previousText !== null) check_schema(document, "project-local.schema.json");
      }
      for (const [key, value] of Object.entries(changes)) {
        const member = FIELDS[key].at(-1);
        if (connectionFields.includes(key)) {
          const name = key.startsWith("openviking") ? "openviking" : key === "edtUrl" ? "edt" : "v8std";
          // YAML aliases can share an object in memory. Copy the path being
          // edited so a scoped change does not mutate another connection.
          document.connections = { ...document.connections };
          const connection = document.connections[name] = { ...document.connections[name] };
          connection[member] = member === "url" ? connection_url(name, value) : structuredClone(value);
        } else if (scope === "global") {
          const parts = FIELDS[key]; let item = document;
          for (const part of parts.slice(0, -1)) item = item[part];
          item[parts.at(-1)] = value;
        } else {
          const name = key.startsWith("codeIndex") ? "code-index" : "bsl-ls";
          document.components = { ...document.components };
          document.components[name] = { ...document.components[name], [member]: value };
        }
      }
      for (const key of unset) {
        const member = FIELDS[key].at(-1);
        if (scope === "global") {
          let item = document;
          for (const part of FIELDS[key].slice(0, -1)) item = item?.[part];
          if (object(item)) delete item[member];
        } else {
          const section = connectionFields.includes(key) ? "connections" : "components";
          const name = section === "connections" ? key.startsWith("openviking") ? "openviking" : key === "edtUrl" ? "edt" : "v8std"
            : key.startsWith("codeIndex") ? "code-index" : "bsl-ls";
          if (!document[section]?.[name]) continue;
          document[section] = { ...document[section], [name]: { ...document[section][name] } };
          delete document[section][name][member];
          if (!Object.keys(document[section][name]).length) delete document[section][name];
        }
      }
      if (scope === "profile") merged_profile(root, document, exists(inside(root, ".ai/project.local.yaml")) ? load(inside(root, ".ai/project.local.yaml")) : {});
      else if (scope === "global") this.checked(document);
      else { check_schema(document, "project-local.schema.json"); validate_override_urls(document); if (scope === "project_local") merged_profile(root, load(profile_target(root)), document); }
      const nextText = scope === "global" ? null : patch_yaml_document(previousText, document);
      const savedBackup = scope === "profile" && previous !== null ? backup(target) : scope === "project_local" ? backup_local_settings(this.STATE, root, previous) : null;
      const current = bytes(target);
      if (previous === null ? current !== null : current === null || !previous.equals(current)) throw new ConfigError("Настройки изменились во время сохранения.");
      let wrote = false, ignorePlan;
      try {
        if (scope === "global") this.store_shared_settings(document);
        else { if (scope === "project_local") ignorePlan = protect_local_layer(root); atomic_write(target, nextText, previous !== null); }
        wrote = true;
        const persisted = load(target);
        if (scope === "global") {
          if (stable(persisted.mcp.managed) !== stable(document.mcp.managed) || stable(persisted.mcp.optional) !== stable(document.mcp.optional))
            throw new ConfigError("Не удалось подтвердить сохранение настроек.");
        } else if (stable(persisted) !== stable(document)) throw new ConfigError("Не удалось подтвердить сохранение настроек.");
        const savedConfig = this.current(), effective = this.effective(savedConfig);
        return { values: this.values(effective, false), savedTo: target, scope, backup: savedBackup, gitWarning: ignorePlan?.gitWarning || null,
          settingsRevision: this.revision(savedConfig, profile_target(root)) };
      } catch (error) {
        rollback_layer(target, previous, scope === "global" ? null : nextText, wrote, ignorePlan, error, savedBackup);
      }
    });
  }
  prepare_layer(request) {
    if (request.layerScope !== "project_local") throw new ConfigError("Выберите локальный файл проекта.");
    if (request.includeMachineSettings !== undefined) throw new ConfigError("Параметры импорта не относятся к редактору локальных настроек.");
    if (typeof request.text !== "string" || Buffer.byteLength(request.text) > 2 * 1024 * 1024) throw new ConfigError("Документ превышает 2 МиБ.");
    const config = this.current(), root = config.active_project;
    if (!root) throw new ConfigError("Выберите папку проекта.");
    if (request.projectRoot !== undefined && configuration_root(request.projectRoot) !== root) throw new ConfigError("Редактор относится к другой папке.");
    if (!request.baseRevision || request.baseRevision !== this.edit_revision()) throw new ConfigError("Настройки изменились после загрузки. Загрузите документ заново.");
    const document = parse(request.text);
    check_schema(document, "project-local.schema.json");
    validate_override_urls(document);
    const shared = load(profile_target(root));
    const profile = merged_profile(root, shared, document), target = inside(root, ".ai/project.local.yaml");
    const [effective] = resolved_settings(config, root, profile, null, this.STATE, document);
    validate_settings(effective);
    const ignorePlan = local_ignore_plan(root);
    const payload = stable({ text: request.text, mode: "layer", baseRevision: request.baseRevision, layerScope: request.layerScope, gitignore: ignorePlan.previous?.toString("base64") ?? null });
    let previous = {};
    try { if (exists(target)) previous = load(target); } catch { previous = null; }
    const diff = previous === null ? { changes: [{ path: "Документ", replacedInvalid: true }], truncated: false } : layer_changes(previous, document);
    const summary = { projectRoot: root, profileId: profile.profile_id,
      repositories: profile.repositories.map(({ id, path, alias }) => ({ id, path, alias })), missingPaths: [], replacesProfile: false,
      connectionUrls: Object.fromEntries(Object.entries(effective.mcp.required).map(([name, item]) => [name, item.url])),
      openviking: structuredClone(effective.mcp.optional.openviking), writesInstanceConnections: false,
      sharedRuntimeChanges: {}, sharedOptionalChanges: {}, layerPath: target, layerScope: request.layerScope, layerChanges: diff.changes, layerChangesTruncated: diff.truncated,
      textChanged: (bytes(target)?.toString("utf8") ?? "") !== request.text,
      gitignoreChange: ignorePlan.changed ? { path: ignorePlan.target, beforeText: ignorePlan.previous?.toString("utf8") ?? "", afterText: ignorePlan.next } : null,
      gitWarning: ignorePlan.gitWarning,
      revision: this.revision(effective, target, payload) };
    return { config, root, document, target, summary, payload, ignorePlan };
  }
  prepare_project_transfer(request) {
    const config = this.current(), root = config.active_project, documents = request.documents;
    if (!root) throw new ConfigError("Выберите папку проекта.");
    if (request.projectRoot !== undefined && configuration_root(request.projectRoot) !== root) throw new ConfigError("Импорт относится к другой папке.");
    if (!object(documents) || !Object.keys(documents).length || Object.keys(documents).some(key => !["profile", "project_local"].includes(key)))
      throw new ConfigError("Выберите общий или локальный файл проекта.");
    if (!request.baseRevision || request.baseRevision !== this.edit_revision()) throw new ConfigError("Настройки изменились. Загрузите файлы заново.");
    const paths = { profile: profile_target(root), project_local: inside(root, ".ai/project.local.yaml") }, parsed = {};
    for (const scope of ["profile", "project_local"]) {
      const text = Object.hasOwn(documents, scope) ? documents[scope] : bytes(paths[scope])?.toString("utf8");
      if (text === undefined && scope === "project_local") { parsed[scope] = {}; continue; }
      if (typeof text !== "string" || Buffer.byteLength(text) > 2 * 1024 * 1024) throw new ConfigError("Документ отсутствует или превышает 2 МиБ.");
      parsed[scope] = parse(text);
    }
    const profile = merged_profile(root, parsed.profile, parsed.project_local);
    assert_settings_paths(config, root, profile, this.STATE, this.CONFIG);
    validate_settings(resolved_settings(config, root, profile, null, this.STATE, parsed.project_local)[0]);
    const previews = Object.entries(documents).map(([scope, text]) => {
      const beforeText = bytes(paths[scope])?.toString("utf8") ?? "";
      let previous = {};
      try { if (exists(paths[scope])) previous = load(paths[scope]); } catch { previous = null; }
      const diff = previous === null ? { changes: [{ path: "Документ", replacedInvalid: true }], truncated: false } : layer_changes(previous, parsed[scope]);
      return { scope, path: paths[scope], exists: exists(paths[scope]), changes: diff.changes, changesTruncated: diff.truncated, textChanged: beforeText !== text,
        ...(beforeText !== text ? { beforeText, afterText: text } : {}) };
    });
    const ignorePlan = Object.hasOwn(documents, "project_local") ? local_ignore_plan(root) : null;
    const revision = this.revision(config, paths.profile, stable({ documents, baseRevision: request.baseRevision, gitignore: ignorePlan?.previous?.toString("base64") ?? null }));
    const gitignoreChange = ignorePlan?.changed ? { path: ignorePlan.target, beforeText: ignorePlan.previous?.toString("utf8") ?? "", afterText: ignorePlan.next } : null;
    return { root, paths, parsed, documents, ignorePlan, summary: { projectRoot: root, files: previews, revision, gitignoreChange, gitWarning: ignorePlan?.gitWarning || null, ...import_compatibility(profile, root) } };
  }
  prepare_document_layer(request) {
    if (request.layerScope !== "profile") throw new ConfigError("Выберите общий профиль проекта.");
    const input = { projectRoot: request.projectRoot, baseRevision: request.baseRevision, documents: { profile: request.text } };
    if (input.projectRoot === undefined) delete input.projectRoot;
    const prepared = this.prepare_project_transfer(input), config = this.current(), root = prepared.root;
    const profile = merged_profile(root, prepared.parsed.profile, prepared.parsed.project_local);
    const [effective] = resolved_settings(config, root, profile, null, this.STATE, prepared.parsed.project_local);
    const file = prepared.summary.files[0], compatibility = import_compatibility(profile, root);
    return { input, summary: { projectRoot: root, profileId: profile.profile_id, projectId: profile.project.id,
      repositories: profile.repositories.map(({ id, path, alias }) => ({ id, path, alias })),
      missingPaths: compatibility.missingPaths, edtMappings: compatibility.edtMappings,
      connectionUrls: Object.fromEntries(Object.entries(effective.mcp.required).map(([name, value]) => [name, value.url])),
      openviking: structuredClone(effective.mcp.optional.openviking), replacesProfile: file.exists,
      layerScope: "profile", layerPath: file.path, textChanged: file.textChanged, layerChanges: file.changes,
      layerChangesTruncated: file.changesTruncated, revision: prepared.summary.revision } };
  }
  async main(request, reportProgress = () => {}, { includeYaxunit = false, observationContext = null, flightRecoveryBudget = 1 } = {}) {
    const action = request.action;
    if (action === "transfer_context") {
      const config = this.current(), root = config.active_project;
      if (!root || request.projectRoot !== undefined && configuration_root(request.projectRoot) !== root) throw new ConfigError("Выберите проект текущего чата.");
      return { projectRoot: root, baseRevision: this.edit_revision() };
    }
    if (action === "transfer_decode") {
      if (typeof request.base64 !== "string" || request.base64.length > Math.ceil(4 * 1024 * 1024 / 3) * 4 ||
          !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(request.base64)) throw new ConfigError("Некорректный архив.");
      const files = read_project_archive(Buffer.from(request.base64, "base64"));
      return { documents: { profile: files[".ai/project.yaml"], project_local: files[".ai/project.local.yaml"] } };
    }
    if (action === "transfer_export") {
      if (!["profile", "project_local", "both"].includes(request.scope)) throw new ConfigError("Выберите область экспорта.");
      const config = this.current(), root = config.active_project;
      if (!root) throw new ConfigError("Выберите папку проекта.");
      if (request.projectRoot !== undefined && configuration_root(request.projectRoot) !== root) throw new ConfigError("Экспорт относится к другой папке.");
      const revision = this.edit_revision(), profile = project_profile(root);
      assert_settings_paths(config, root, profile, this.STATE, this.CONFIG);
      const paths = { profile: profile_target(root), project_local: inside(root, ".ai/project.local.yaml") }, output = {};
      const selected = request.scope === "both" ? ["profile", "project_local"] : [request.scope];
      const secrets = Object.entries(process.env).filter(([key, value]) => /password|passwd|secret|token|credential|api.?key|private.?key/i.test(key) && value.length >= 4).map(([, value]) => value);
      const inspect = (value, key = "") => {
        if (key === "headers_env") return; // Values are environment variable names, not credentials.
        if (typeof value === "string") {
          if (secrets.some(secret => value.includes(secret)) || /(?:bearer\s+\S+|(?:password|passwd|secret|token|api[_-]?key|authorization)\s*[=:]\s*\S+)/i.test(value))
            throw new ConfigError("В настройках обнаружены возможные секреты. Удалите их перед экспортом.");
        } else if (Array.isArray(value)) {
          if (value.some(item => typeof item === "string" && (/^--?[^\s=]*(?:password|passwd|pwd|secret|token|credential|api[-_]?key|authorization)(?:=|$)/i.test(item) || /^-p(?:$|[^-])/i.test(item) || /^(?:-u|--user)(?:=|$)/i.test(item))))
            throw new ConfigError("В команде обнаружен параметр возможного секрета. Удалите его перед экспортом.");
          value.forEach(item => inspect(item));
        }
        else if (object(value)) for (const [name, child] of Object.entries(value)) inspect(child, name);
      };
      for (const scope of selected) {
        const content = bytes(paths[scope]), raw = content === null ? "{}\n" : content.toString("utf8");
        if (content !== null && !Buffer.from(raw, "utf8").equals(content)) throw new ConfigError("Файл профиля должен быть в корректной кодировке UTF-8.");
        const document = parse(raw);
        check_schema(document, "project-local.schema.json");
        if (request.includeCommandsAndComments !== true && Array.isArray(document.testing?.commands)) document.testing.commands = [];
        inspect(document);
        // Comments are included in the export and may themselves contain a
        // credential. Inspect them too before preserving the source text.
        if (request.includeCommandsAndComments === true) {
          for (const line of raw.split(/\r?\n/)) { const comment = line.match(/(?:^|\s)#(.*)$/); if (comment) { inspect(comment[1]); if (/\b(?:password|passwd|pwd|secret|token|credential|api[-_]?key|authorization)\s+\S+/i.test(comment[1])) throw new ConfigError("В комментарии обнаружен возможный секрет. Удалите его перед экспортом."); } }
          output[scope] = raw;
        } else output[scope] = stringify(document, { schema: "yaml-1.1" });
      }
      if (revision !== this.edit_revision()) throw new ConfigError("Настройки изменились во время экспорта.");
      if (request.scope === "both") return { filename: "1c-ai-core-project.zip", base64: Buffer.from(write_project_archive({ ".ai/project.yaml": output.profile, ".ai/project.local.yaml": output.project_local })).toString("base64") };
      return { filename: request.scope === "profile" ? "project.yaml" : "project.local.yaml", text: output[request.scope] };
    }
    if (action === "transfer_preview") return this.prepare_project_transfer(request).summary;
    if (action === "transfer_apply") return operation_lock(this.STATE, () => {
      const prepared = this.prepare_project_transfer(request), { root, paths, parsed, documents, summary, ignorePlan } = prepared;
      if (request.replace !== true) throw new ConfigError("Подтвердите замену файлов.");
      if (!request.revision || request.revision !== summary.revision) throw new ConfigError("Настройки изменились после предпросмотра.");
      const previous = Object.fromEntries(Object.keys(documents).map(scope => [scope, bytes(paths[scope])])), backups = [];
      for (const scope of Object.keys(documents)) if (previous[scope] !== null) {
        if (scope === "profile") backups.push({ scope, path: backup(paths[scope]) });
        else {
          const saved = path.join(this.STATE, "backups", `import-${randomUUID()}.yaml`), actual = resolve(saved);
          if (contained(resolve(root), actual)) throw new ConfigError("Резервная копия локального профиля должна находиться вне проекта и Git-репозитория.");
          for (let directory = path.dirname(actual); ; directory = path.dirname(directory)) {
            if (exists(path.join(directory, ".git"))) throw new ConfigError("Резервная копия локального профиля должна находиться вне проекта и Git-репозитория.");
            if (path.dirname(directory) === directory) break;
          }
          atomic_write(saved, previous[scope], false); backups.push({ scope, path: saved });
        }
      }
      const written = []; let savedIgnore;
      try {
        if (ignorePlan) savedIgnore = protect_local_layer(root, ignorePlan);
        for (const scope of Object.keys(documents)) {
          const now = bytes(paths[scope]), old = previous[scope];
          if (old === null ? now !== null : now === null || !old.equals(now)) throw new ConfigError("Файл изменился во время импорта: " + paths[scope]);
          atomic_write(paths[scope], documents[scope], old !== null); written.push(scope);
          if (stable(load(paths[scope])) !== stable(parsed[scope])) throw new ConfigError("Не удалось подтвердить импорт: " + paths[scope]);
        }
      } catch (error) {
        const failed = [];
        for (const scope of written.reverse()) try {
          const now = bytes(paths[scope]);
          if (now === null || !now.equals(Buffer.from(documents[scope]))) throw new Error("changed");
          restore(paths[scope], previous[scope]);
        } catch { failed.push(paths[scope]); }
        try { restore_local_ignore(savedIgnore); } catch { failed.push(savedIgnore.target); }
        if (failed.length) throw new ConfigError("Не удалось восстановить файлы: " + failed.join(", ") + ". Резервные копии: " + backups.map(item => item.path).join(", "));
        throw error;
      }
      return { status: "imported", summary, backups };
    });
    if (action === "document_fields") {
      if (!["profile", "project_local"].includes(request.layerScope)) throw new ConfigError("Выберите проектный профиль.");
      if (typeof request.text !== "string" || Buffer.byteLength(request.text) > 2 * 1024 * 1024) throw new ConfigError("Документ превышает 2 МиБ.");
      const file = request.layerScope === "profile" ? "project-profile.schema.json" : "project-local.schema.json";
      return { schema: JSON.parse(fs.readFileSync(new URL("../schemas/" + file, import.meta.url), "utf8")), value: parse(request.text) };
    }
    if (action === "document_patch") return patch_yaml_draft(request.text, request.operation);
    if (action === "edit" && request.format === "yaml") {
      if (!["profile", "project_local"].includes(request.layerScope)) throw new ConfigError("YAML доступен только для проектных профилей.");
      const config = this.current(), root = config.active_project;
      if (!root) throw new ConfigError("Выберите папку проекта.");
      const baseRevision = this.edit_revision();
      const target = request.layerScope === "profile" ? profile_target(root) : inside(root, ".ai/project.local.yaml");
      let text = "{}\n";
      if (exists(target)) {
        const stat = fs.statSync(target);
        if (!stat.isFile() || stat.size > 2 * 1024 * 1024) throw new ConfigError("Документ недоступен или превышает 2 МиБ.");
        const content = fs.readFileSync(target);text = content.toString("utf8");
        if (!Buffer.from(text, "utf8").equals(content)) throw new ConfigError("Файл профиля должен быть в корректной кодировке UTF-8.");
      } else if (request.layerScope === "profile") throw new ConfigError("Профиль проекта не найден.");
      if (baseRevision !== this.edit_revision()) throw new ConfigError("Настройки изменились во время загрузки. Загрузите документ заново.");
      return { text, baseRevision, layerScope: request.layerScope, path: target, format: "yaml" };
    }
    if (["preview", "apply"].includes(action) && request.mode === "layer") {
      if (request.layerScope === "profile") {
        const prepared = this.prepare_document_layer(request);
        if (action === "preview") return prepared.summary;
        if (request.revision !== prepared.summary.revision) throw new ConfigError("Настройки изменились после предпросмотра. Проверьте документ заново.");
        const result = await this.main({ action: "transfer_apply", ...prepared.input, revision: request.revision, replace: request.replace });
        return { status: "saved", summary: prepared.summary, savedTo: prepared.summary.layerPath,
          backup: result.backups.find(item => item.scope === "profile")?.path || null, sessionGuidance: session_guidance };
      }
      if (action === "preview") return this.prepare_layer(request).summary;
      return operation_lock(this.STATE, () => {
        const { config, root, document, target, summary, ignorePlan } = this.prepare_layer(request);
        if (request.revision !== summary.revision) throw new ConfigError("Настройки изменились после предпросмотра. Проверьте документ заново.");
        const previous = bytes(target);
        // Local documents may contain machine-specific information. Never put
        // their backups in the project, including projects with an old ignore file.
        const savedBackup = previous !== null ? path.join(this.STATE, "backups", `settings-${randomUUID()}.yaml`) : null;
        if (savedBackup) {
          // Check the resolved destination, including redirected directories,
          // against the project and any enclosing Git worktree.
          const actual = resolve(savedBackup);
          if (contained(resolve(root), actual))
            throw new ConfigError("Резервная копия локальных настроек должна находиться вне проекта и Git-репозитория.");
          for (let directory = path.dirname(actual); ; directory = path.dirname(directory)) {
            if (exists(path.join(directory, ".git")))
              throw new ConfigError("Резервная копия локальных настроек должна находиться вне проекта и Git-репозитория.");
            if (path.dirname(directory) === directory) break;
          }
          atomic_write(savedBackup, previous, false);
        }
        let wrote = false, savedIgnore;
        try {
          savedIgnore = protect_local_layer(root, ignorePlan);
          atomic_write(target, request.text, previous !== null);
          wrote = true;
          if (stable(load(target)) !== stable(document)) throw new ConfigError("Не удалось подтвердить сохранение настроек.");
          const effective = this.effective(this.current()); validate_settings(effective);
          return { status: "saved", summary, savedTo: target, backup: savedBackup, values: this.values(effective, false), sessionGuidance: session_guidance };
        } catch (error) { rollback_layer(target, previous, request.text, wrote, savedIgnore, error, savedBackup); }
      });
    }
    if (action === "java_probe") {
      const { java_info, java_in_directory } = await import("./runtime.mjs");
      let config, environment;
      try { config = this.effective(this.current()); }
      catch { environment = {}; } // Keep repair diagnostics usable without inheriting unknown credentials.
      return request.directory ? java_in_directory(request.directory, config, environment, { state: this.STATE }) : java_info(request.command || "java", config, environment, { state: this.STATE });
    }
    if (action === "rename_profile") {
      return operation_lock(this.STATE, () => {
        const config = this.current(), root = config.active_project;
        if (!root) throw new ConfigError("Выберите папку проекта.");
        const sharedTarget = profile_target(root), target = inside(root, ".ai/project.local.yaml");
        if (path_identity(target) === path_identity(sharedTarget)) throw new ConfigError("Локальный файл не должен перенаправляться в общий профиль проекта.");
        if (request.expectedRevision !== this.revision(config, sharedTarget)) throw new ConfigError("Профиль изменился. Обновите сведения перед переименованием.");
        const previous = bytes(target), original = previous?.toString("utf8") ?? null;
        if (previous !== null && !Buffer.from(original, "utf8").equals(previous)) throw new ConfigError("Файл настроек должен быть в корректной кодировке UTF-8.");
        if (typeof request.projectId !== "string" || !request.projectId.trim()) throw new ConfigError("Укажите идентификатор проекта.");
        const previousId = project_profile(root).project.id;
        if (previousId === request.projectId.trim()) return { status: "unchanged", profile: profile_state(root) };
        const document = original === null ? {} : parse(original);
        document.project = { ...document.project, id: request.projectId.trim() };
        check_schema(document, "project-local.schema.json");
        merged_profile(root, load(sharedTarget), document);
        const nextText = patch_yaml_document(original, document), ignorePlan = local_ignore_plan(root);
        const savedBackup = backup_local_settings(this.STATE, root, previous);
        const current = bytes(target);
        if ((previous === null ? current !== null : current === null || !current.equals(previous)) || request.expectedRevision !== this.revision(config, sharedTarget))
          throw new ConfigError("Профиль изменился во время переименования.");
        let wrote = false, savedIgnore;
        try {
          savedIgnore = protect_local_layer(root, ignorePlan);
          atomic_write(target, nextText, previous !== null);
          wrote = true;
          if (stable(load(target)) !== stable(document)) throw new ConfigError("Не удалось подтвердить переименование профиля.");
          project_profile(root);
        } catch (error) { rollback_layer(target, previous, nextText, wrote, savedIgnore, error, savedBackup); }
        remember_profile(this.STATE, root, profile_state(root));
        return { status: "renamed", profile: profile_state(root), backup: savedBackup, gitWarning: savedIgnore.gitWarning,
          detail: "Разрешения Vanessa, привязанные к прежнему идентификатору проекта, потребуется получить заново." };
      });
    }
    if (action === "probe") {
      const config = observationContext ? structuredClone(observationContext.config) : this.effective(this.current()), root = config.active_project;
      if (!root) throw new ConfigError("Выберите папку проекта.");
      const component = request.component;
      if (component !== undefined && !["edt", "v8std", "openviking", ...managed_components, "yaxunit", "vanessa"].includes(component)) throw new ConfigError("Выберите компонент для проверки.");
      if (component && Object.keys(request.connections || {}).some(name => name !== component)) throw new ConfigError("Адресная проверка принимает настройки только выбранного компонента.");
      const profile = observationContext ? structuredClone(observationContext.profile) : project_profile(root), original = stable(config);
      const observedComponents = component ? includeYaxunit && component === "edt" ? ["edt", "yaxunit"] : [component] : ["edt", "v8std", "openviking"];
      const vanessaSnapshot = component === "vanessa" ? observationContext?.vanessaSnapshot ?? vanessa_runtime_snapshot(root, profile) : undefined;
      let indexSnapshot = observationContext?.indexSnapshot;
      if (component === "code-index" && component_settings(config, component).mode !== "external" && indexSnapshot === undefined)
        try { indexSnapshot = capture_index_snapshot(this.STATE, root, profile); } catch { indexSnapshot = null; }
      const indexGrantIdentity = component === "code-index" && component_settings(config, component).mode !== "external"
        ? observationContext?.indexGrantIdentity ?? preparation_identity(this.STATE, root) : null;
      const initialInputs = Object.fromEntries(observedComponents.map(id => [id, component_fingerprint(this.STATE, config, profile, id,
        { vanessaRuntimeSnapshot: id === "vanessa" ? vanessaSnapshot : undefined, indexSnapshot: id === "code-index" ? indexSnapshot : undefined })]));
      let indexTransition = null;
      const initialReceipt = readiness_receipt_revision(this.STATE, root, observedComponents), instance = instance_name();
      if (request.connections !== undefined) {
        if (!object(request.connections) || Object.keys(request.connections).some(name => !["edt", "v8std", "openviking"].includes(name)))
          throw new ConfigError("Некорректные подключения для проверки.");
        for (const [name, url] of Object.entries(request.connections)) {
          if (name === "openviking") {
            check_schema({ connections: { openviking: url } }, "project-local.schema.json");
            config.mcp.optional.openviking = { ...config.mcp.optional.openviking, ...structuredClone(url) };
            validate_settings(config);
            continue;
          }
          if (typeof url !== "string") throw new ConfigError("Адрес подключения должен быть строкой.");
          config.mcp.required[name].url = url ? validate_url(url, name) : "";
        }
      }
      const draft = original !== stable(config);
      const observation = !request.collectOnly && !draft ? await operation_lock(this.STATE, () => begin_component_checks(this.STATE, root, observedComponents), 1) : null;
      let result, checks;
      if (managed_components.includes(component)) {
        const runtime = await import("./runtime.mjs"), options = component_settings(config, component);
        const readiness = request.collectOnly ? { state: "not_checked", checks: [] } : await read_readiness(this.STATE, config, profile);
        const saved = read_component_checks(this.STATE, config, profile).find(item => item.id === component);
        const setupCheck = saved?.validity === "inputs" ? null : ["ready", "blocked", "stale"].includes(readiness.state) ? readiness.checks.find(item => item.id === component) : null;
        const apiStates = ["ready", "error", "stale", "missing", "mismatch", "missing_project", "indexing"];
        const prior = [setupCheck && { ...setupCheck, ...(readiness.state === "stale" ? { state: "check_stale", lastState: setupCheck.state } : {}), checkedAt: readiness.checkedAt, expiresAt: readiness.expiresAt },
          saved]
          .filter(item => item && apiStates.includes(item.lastState || item.state)).sort((a, b) => Date.parse(b.checkedAt) - Date.parse(a.checkedAt))[0];
        const retainedNotice = "Сохранён актуальный результат последней проверки API; новый запуск сервиса не выполнялся.";
        const retained = prior && ["ready", "error", "stale", "missing", "mismatch", "missing_project", "indexing"].includes(prior.state)
          ? { ...prior, detail: prior.detail?.includes(retainedNotice) ? prior.detail : (prior.detail ? prior.detail + " " : "") + retainedNotice } : null;
        const expired = prior?.state === "check_stale" ? { ...prior, id: component, state: "check_stale", lastState: prior.lastState, checkedAt: prior.checkedAt, expiresAt: prior.expiresAt,
          detail: prior.validity === "inputs" ? prior.detail : (component === "code-index" ? "Процесс индекса работает, но подтверждение актуальности индекса устарело." : "Подтверждение API BSL LS устарело; автоматическое обновление не запускает новую JVM.") + " Для новой проверки используйте «Подготовить и проверить»." } : null;
        let check = { id: component, state: "not_verified", detail: "Работоспособность не проверена: требуется разрешённая подготовка и запуск компонента." };
        if (!component_enabled(config, component)) check = { id: component, state: "disabled", detail: "Компонент отключён." };
        else if (options.mode === "external") {
          try {
            const observed = await runtime.smoke(this.STATE, config, root, profile, component, 30, false, null, false, 25);
            const state = observed.index_ready === false ? observed.index_state || "not_verified" : "ready";
            check = component === "bsl-ls" && state === "ready" ? bsl_api_observed({ id: component, state }, { external: true, live: true }) :
              { id: component, state: state === "not_checked" ? "not_verified" : state, repositories: observed.index?.repositories,
                ...(component === "code-index" ? { detail: index_observation_detail(state) } : {}) };
          } catch (error) { check = { id: component, state: "error", detail: safe_error_message(error) }; }
        } else if (component === "code-index") {
          let platformError;
          try { runtime.platform_build(); } catch (error) { platformError = error; }
          const home = path.join(project_directory(this.STATE, root), "code-index"), health = platformError || indexSnapshot === null ? null : await runtime.daemon_health(home, indexSnapshot);
          const uncertain = !health && index_process_may_exist(home);
          // Liveness alone cannot prove that a retained API result belongs to
          // this process: an OS may reuse a PID after a daemon replacement.
          check = platformError ? { id: component, state: "error", detail: safe_error_message(platformError) } : indexSnapshot === null
            ? { id: component, state: "not_verified", detail: "Не удалось зафиксировать конфигурацию и состав проектов индекса. Проверьте доступ к файлам." } :
            { ...check, state: health ? expired || retained ? "not_verified" : "running" : uncertain ? "not_verified" : "stopped", detail: health ? expired || retained ? "Процесс работает, но актуальность индекса не подтверждена. Нажмите «Подготовить и проверить»." : "Процесс работает. Актуальность индекса этой проверкой не подтверждена." : uncertain ? "Не удалось подтвердить ответ сервиса индекса; процесс может работать. Повторим проверку автоматически." : "Сервис индекса недоступен. Нажмите «Подготовить и проверить»." };
          let prepared = false;
          try { require_preparation(this.STATE, root, component); prepared = true; } catch { /* Observation never grants preparation permission. */ }
          if (prepared && !platformError && indexSnapshot !== null) {
            try {
              const observed = this.observeIndex
                ? await this.observeIndex({ config, root, profile, snapshot: indexSnapshot })
                : await runtime.observe_index(this.STATE, config, root, profile, indexSnapshot);
              if (observed?.observationSnapshot) {
                const latest = this.effective(this.current()), latestProfile = project_profile(root), currentSnapshot = capture_index_snapshot(this.STATE, root, latestProfile);
                const priorInputs = component_fingerprint(this.STATE, latest, latestProfile, component,
                  { indexSnapshot: { ...currentSnapshot, files: indexSnapshot.files } });
                const nextInputs = component_fingerprint(this.STATE, config, profile, component, { indexSnapshot: observed.observationSnapshot });
                if (latest.active_project !== root || priorInputs !== initialInputs[component] ||
                    nextInputs !== component_fingerprint(this.STATE, latest, latestProfile, component, { indexSnapshot: currentSnapshot }))
                  throw Object.assign(new ConfigError("Настройки индекса изменились во время запуска."), { inputsChanged: true });
                indexTransition = { before: initialInputs[component], after: nextInputs };
                initialInputs[component] = nextInputs;
                indexSnapshot = observed.observationSnapshot;
              }
              check = observed ? { id: component, state: observed.index_state === "not_checked" ? "not_verified" : observed.index_state, repositories: observed.index.repositories,
                detail: index_observation_detail(observed.index_state) }
                : { id: component, state: "not_verified", detail: "Не удалось подтвердить ответ сервиса индекса; процесс может работать. Повторим проверку автоматически." };
            } catch (error) {
              if (error.cleanupUnconfirmed) throw error;
              const busy = error.remote !== true && error.code === "RUNTIME_BUSY";
              const unknownDaemon = !health && uncertain && !error.inputsChanged;
              check = { id: component, state: busy ? "preparing" : unknownDaemon ? "not_verified" : "error",
                detail: busy ? "Подготовка окружения выполняется…" : unknownDaemon ? "Не удалось подтвердить состояние демона индекса; процесс может работать. " + safe_error_message(error) : safe_error_message(error),
                ...(error.inputsChanged ? { observationInputsChanged: true } : {}) };
            }
          }
        } else if (request.collectOnly) {
          // Observation must not start Java, install a runtime or scan arbitrary
          // jars. Only the active lock entry may identify the installed artifact.
          try {
            const jar = runtime.artifact(this.STATE, component, "active", { verify: false });
            const java = which(options.java || "java");
            const configurationError = bsl_configuration_error(config);
            if (!jar) check = { id: component, state: "missing", detail: "JAR BSL LS отсутствует в установленном runtime. Нажмите «Подготовить и проверить» для установки." };
            else if (!java) check = { id: component, state: "error", detail: "Java не найдена. Укажите доступную Java в настройках BSL LS." };
            else if (configurationError)
              check = { id: component, state: "error", detail: configurationError };
            else if (saved?.validity === "inputs" && (["ready", "error"].includes(saved.state) || saved.state === "not_verified" && saved.apiCompatible === true))
              check = saved.state === "ready"
                ? { ...saved, detail: `${saved.detail} Новая JVM не запускалась.` }
                : saved;
            else check = { id: component, state: "not_verified", detail: "JAR и Java найдены; для подтверждения целостности JAR и совместимости API нажмите «Подготовить и проверить»." };
          } catch (error) { check = { id: component, state: "error", detail: safe_error_message(error) }; }
        } else if (saved?.validity === "inputs" && (saved.state === "ready" || saved.state === "not_verified" && saved.apiCompatible === true)) check = retained || saved;
        else {
          let prepared = false;
          try { require_preparation(this.STATE, root, component); prepared = true; } catch { /* Do not grant launch permission during observation. */ }
          if (expired || saved?.state === "error") check = { id: component, state: "not_verified", detail: "Актуальность API BSL LS не подтверждена. Для проверки требуется подготовленный runtime и разрешение проекта.",
            ...(saved?.validity === "inputs" && saved.state === "check_stale" ? { preservePrevious: true, inputRevision: bsl_readiness_fingerprint(this.STATE, config) } : {}) };
          if (prepared) {
            let inputRevision = null;
            try {
              const inputs = await bsl_check_inputs(this.STATE, config, runtime, false);
              const { jar } = inputs; inputRevision = inputs.inputRevision;
              await runtime.smoke(this.STATE, config, root, profile, component, 30, false, jar, false, 25);
              check = bsl_api_observed({ id: component, state: "ready", inputRevision }, { live: true });
            } catch (error) {
              const busy = error.remote !== true && error.code === "RUNTIME_BUSY";
              check = { id: component, state: error.inputsChanged ? "check_stale" : busy ? "preparing" : "error", ...(error.inputsChanged ? { validity: "inputs" } : {}), inputRevision,
                detail: busy ? "Подготовка окружения выполняется…" : safe_error_message(error) };
            }
            if (inputRevision && inputRevision !== bsl_readiness_fingerprint(this.STATE, config))
              check = { ...check, state: "check_stale", validity: "inputs", expiresAt: null, detail: "Окружение BSL LS изменилось во время проверки. Повторите проверку." };
          }
        }
        checks = [check]; result = { managed: [{ name: component, ...check, ready: check.state === "ready" }], external: {} };
      } else if (component === "yaxunit") {
        checks = [await probe_yaxunit(config, root, profile)];
        result = { managed: [], external: {} };
      } else if (component === "vanessa") {
        const { probe_vanessa } = await import("./vanessa_readiness.mjs");
        checks = [await probe_vanessa(root, profile, { runtimeSnapshot: vanessaSnapshot })];
        result = { managed: [], external: {} };
      } else {
        const { probe_connections, edt_project_building } = await import("./setup_probe.mjs");
        result = await probe_connections(config, root, profile, this.STATE, component, includeYaxunit);
        checks = Object.entries(result.external).map(([id, item]) => ({ id, state: item.state === "disabled" ? "disabled" : item.ready === true ? "ready" : item.configured === false ? "missing_config" : id === "edt" && edt_project_building(item) ? "building" : item.connected ? "not_verified" : "error", detail: item.detail, repositories: item.repositories, checkedAt: item.checkedAt, expiresAt: item.readiness?.expiresAt,
          ...(id === "openviking" ? { readiness: item.readiness, access: item.access, publicationEvidence: item.publicationEvidence } : {}) }));
        checks.push(...(result.componentChecks || []));
      }
      checks = checks.map(check => check.checkedAt ? check : { ...check, checkedAt: new Date().toISOString() });
      const indexBindingChanged = checks.some(item => item.observationInputsChanged) ||
        indexGrantIdentity !== null && indexGrantIdentity !== preparation_identity(this.STATE, root);
      checks = checks.map(({ observationInputsChanged, ...item }) => item);
      if (request.collectOnly) {
        if (indexBindingChanged) initialInputs[component] = "changed";
        const collected = sanitize_setup_result({ ...result, component, componentChecks: checks, draft, projectRoot: root, instance });
        // Internal-only evidence of the inputs at actual probe dispatch. It is
        // never serialized into the public MCP result or persisted receipt.
        Object.defineProperty(collected, "observationInputs", { value: initialInputs });
        Object.defineProperty(collected, "indexTransition", { value: indexTransition });
        return collected;
      }
      let superseded, supersededComponents = [];
      const componentChecks = await operation_lock(this.STATE, () => {
        const latest = this.effective(this.current());
        const scopeChanged = latest.active_project !== root || instance_name() !== instance ||
          (!observation && initialReceipt !== readiness_receipt_revision(this.STATE, root, observedComponents));
        const latestProfile = scopeChanged ? null : project_profile(root);
        supersededComponents = observedComponents.filter(id => scopeChanged ||
          (indexBindingChanged || indexGrantIdentity !== null && indexGrantIdentity !== preparation_identity(this.STATE, root)) && id === component ||
          observation && !component_check_current(this.STATE, root, observation, id) ||
          initialInputs[id] !== component_fingerprint(this.STATE, latest, latestProfile, id));
        superseded = supersededComponents.length === observedComponents.length;
        if (superseded || draft) return checks;
        return save_component_checks(this.STATE, latest, latestProfile, checks.filter(item => !supersededComponents.includes(item.id)));
      });
      return sanitize_setup_result({ ...result, component, componentChecks, draft, superseded, ...(supersededComponents.length ? { supersededComponents } : {}), projectRoot: root, instance });
    }
    if (action === "read" || action === "status") {
      const { installed_versions } = await import("./runtime.mjs");
      const config = this.current(true), profile = profile_state(config.active_project);
      // A broken profile must not prevent opening its repair/import screen.
      const [effective, sources, fieldSources = {}] = ["invalid", "ambiguous"].includes(profile.status)
        ? [config, {}] : this.effective(config, null, null, true);
      const actual = this.values(effective, false);
      if (request.remember) remember_profile(this.STATE, config.active_project, profile);
      const directoryContext = directory_context(process.env.EDT_AI_PROJECT_ROOT || config.active_project, { includeDisplayName: true });
      const profileDirectoryContext = config.active_project && directoryContext?.directory !== config.active_project
        ? directory_context(config.active_project, { includeDisplayName: true }) : directoryContext;
      if (profile.status === "loaded") {
        try { profile.indexRepositories = index_repositories(config.active_project, profile).map(repo => repo.id); }
        catch { profile.indexRepositories = []; }
      }
      const readiness = await read_readiness(this.STATE, effective, profile);
      const knowledge = profile.status === "loaded" ? knowledge_status(project_profile(config.active_project), effective) : null;
      const componentChecks = read_component_checks(this.STATE, effective, profile);
      let componentStatuses = component_statuses(this.STATE, effective, profile);
      const installedVersions = installed_versions(this.STATE, config.active_project, { verify: false });
      if (profile.status === "loaded" && component_enabled(effective, "bsl-ls") &&
          component_settings(effective, "bsl-ls").mode !== "external" && !installedVersions["bsl-ls"]) {
        componentStatuses = componentStatuses.map(item => item.id !== "bsl-ls" ? item : { id: item.id, state: "missing",
          detail: "JAR BSL LS отсутствует или его запись в runtime-lock недоступна. Нажмите «Подготовить и проверить» для установки.",
          ...(item.lastCheckedAt ? { lastCheckedAt: item.lastCheckedAt } : {}) });
      }
      const summary = await profile_summary(this.STATE, effective, profile, readiness, knowledge, componentStatuses);
      return {
        values: actual,
        ...(["invalid", "ambiguous"].includes(profile.status) ? { configurationError: true } : {}),
        installedVersions,
        profile,
        directoryContext,
        profileDirectoryContext,
        edtPortSuggestion: edt_port_suggestion(actual.edtUrl, profileDirectoryContext?.edt?.connection),
        readiness,
        componentChecks,
        componentStatuses,
        testing: profile.status === "loaded" ? Object.fromEntries(Object.entries(project_profile(config.active_project).testing).filter(([key]) => ["yaxunit", "vanessa", "yaxunit_config", "vanessa_config"].includes(key))) : null,
        knowledge,
        environmentCompatibility: environment_compatibility({ projectRoot: config.active_project }),
        sessionGuidance: session_guidance,
        instance: instance_name(),
        connectionSources: sources,
        valueSources: Object.fromEntries(Object.entries(FIELDS).filter(([key]) => key.startsWith("openviking"))
          .map(([key, parts]) => [key, fieldSources.openviking?.[parts.at(-1)] || "settings"])),
        managedValueSources: Object.fromEntries(Object.entries(FIELDS).filter(([key]) => key.startsWith("codeIndex") || key.startsWith("bslLs"))
          .map(([key, parts]) => [key, fieldSources.components?.[parts.at(-2)]?.[parts.at(-1)] || "settings"])),
        settingsRevision: config.active_project && profile.status === "loaded" ? this.revision(config, profile_target(config.active_project)) : null,
        writePaths: config.active_project ? { profile: profile_target(config.active_project), project_local: inside(config.active_project, ".ai/project.local.yaml"), global: this.CONFIG } : {},
        ...this.setting_scope_data(config, profile, effective, sources, fieldSources),
        preparationScope: preparation_scope(actual.projectRoot),
        profileHistory: profile_history(this.STATE, actual.projectRoot),
        profileHistoryHidden: profile_hidden(this.STATE, actual.projectRoot),
        summary,
      };
    }
    if (["create", "load"].includes(action)) {
      return operation_lock(this.STATE, () => {
        const config = this.current(), selected = this.lockedRoot();
        if (request.projectRoot !== undefined) {
          const proposed = request.projectRoot ? configuration_root(request.projectRoot) : null;
          if (selected && proposed !== configuration_root(selected))
            throw new ConfigError("Каталог задаётся текущим чатом. Выберите другой проект в Codex.");
          if (config.active_project !== proposed) config.mcp.required.edt.url = "";
          config.active_project = proposed;
        }
        this.checked(config);
        if (!config.active_project) throw new ConfigError("Выберите папку проекта в Codex.");
        const root = configuration_root(config.active_project);
        const creation = action === "create" ? create_profile(root) : null;
        project_profile(root); // Validate before signalling any bound session.
        record_project_owner(this.STATE, root);
        remember_profile(this.STATE, root, profile_state(root));
        const actual = this.values(config);
        atomic_write(reconnect_file(this.STATE, root), JSON.stringify({ id: randomUUID() }));
        return { values: actual, profile: profile_state(root), instance: instance_name(),
          ...(creation ? { projectInstructions: creation.projectInstructions } : {}),
          sessionGuidance: session_guidance, reload: "requested", readiness: "not_checked" };
      });
    }
    if (action === "reset_connection") {
      if (!["edt", "v8std", "openviking"].includes(request.connection)) throw new ConfigError("Неизвестное подключение.");
      return operation_lock(this.STATE, () => {
        const config = this.current(), root = config.active_project;
        if (!root) throw new ConfigError("Выберите папку проекта.");
        let profile;
        try { profile = project_profile(root); } catch (error) { if (!(error instanceof ProfileNotFound)) throw error; }
        if (profile) assert_settings_paths(config, root, profile, this.STATE, this.CONFIG);
        if (request.expectedRevision && request.expectedRevision !== this.revision(config, profile_target(root)))
          throw new ConfigError("Настройки изменились после загрузки. Обновите сведения и повторите сохранение.");
        const file = inside(root, ".ai/project.local.yaml"); let gitWarning = null;
        if (exists(file)) {
          const previous = bytes(file), original = previous.toString("utf8");
          if (!Buffer.from(original, "utf8").equals(previous)) throw new ConfigError("Файл настроек должен быть в корректной кодировке UTF-8.");
          const local = parse(original);
          check_schema(local, "project-local.schema.json");
          if (local.connections?.[request.connection]) {
            local.connections = { ...local.connections, [request.connection]: { ...local.connections[request.connection] } };
            delete local.connections[request.connection].url;
            if (!Object.keys(local.connections[request.connection]).length) delete local.connections[request.connection];
          }
          check_schema(local, "project-local.schema.json");
          this.effective(config, local);
          const nextText = patch_yaml_document(original, local);
          backup_local_settings(this.STATE, root, previous);
          if (!bytes(file)?.equals(previous)) throw new ConfigError("Настройки изменились во время сохранения.");
          let wrote = false, ignorePlan;
          try {
            ignorePlan = protect_local_layer(root);
            gitWarning = ignorePlan.gitWarning;
            atomic_write(file, nextText);
            wrote = true;
            if (stable(load(file)) !== stable(local)) throw new ConfigError("Не удалось подтвердить восстановление наследования.");
            this.effective(this.current());
          } catch (error) { rollback_layer(file, previous, nextText, wrote, ignorePlan, error); }
        }
        return { values: this.values(config), settingsRevision: this.revision(config, profile_target(root)), gitWarning };
      });
    }
    if (action === "update") {
      const changes = request.set === undefined ? {} : request.set;
      const unset = request.unset === undefined ? [] : request.unset;
      if (
        !object(changes) ||
        !Array.isArray(unset) ||
        !Object.keys(changes).length && !unset.length ||
        Object.keys(changes).some((key) => !Object.hasOwn(FIELDS, key)) ||
        unset.some(key => typeof key !== "string" || !Object.hasOwn(FIELDS, key) || Object.hasOwn(changes, key)) ||
        new Set(unset).size !== unset.length
      )
        throw new ConfigError("Некорректное изменение настроек.");
      for (const [key, value] of Object.entries(changes))
        if (
          typeof value !== (key.endsWith("Enabled") || key.endsWith("AllowPrerelease") ? "boolean"
            : ["openvikingTimeout", "openvikingMaxResponseBytes"].includes(key) ? "number"
            : "string")
        )
          throw new ConfigError("Некорректный тип настройки: " + key);
      if (request.scope !== undefined) return this.update_scoped(changes, request.scope, request.expectedRevision, unset);
      if (unset.length) throw new ConfigError("Для удаления переопределения укажите область сохранения.");
      if (request.expectedRevision !== undefined) throw new ConfigError("Для проверки ревизии укажите область сохранения.");
      const selected = this.lockedRoot();
      if (
        selected &&
        Object.hasOwn(changes, "projectRoot") &&
        (!changes.projectRoot ||
          configuration_root(changes.projectRoot) !==
            configuration_root(selected))
      )
        throw new ConfigError(
          "Каталог задаётся текущей сессией; выберите другой проект в Codex.",
        );
      let gitWarning = null;
      const config = await operation_lock(this.STATE, () => {
        const config = this.current(),
          instanceChanges = {};
        let globalChanged = false,
          root;
        for (const key of Object.keys(changes).sort(
          (a, b) => Number(b === "projectRoot") - Number(a === "projectRoot"),
        )) {
          let value = changes[key];
          if (key === "projectRoot") {
            value = value ? configuration_root(value) : null;
            if (config.active_project !== value)
              config.mcp.required.edt.url = "";
            config.active_project = value;
            continue;
          }
          if (["edtUrl", "v8stdUrl"].includes(key) || key.startsWith("openviking")) {
            if (!config.active_project)
              throw new ConfigError(
                "Для настройки подключений выберите папку проекта.",
              );
            root = configuration_root(config.active_project);
            const name = key.startsWith("openviking") ? "openviking" : key === "edtUrl" ? "edt" : "v8std";
            const connections = instanceChanges.connections ||= {};
            const member = FIELDS[key].at(-1);
            connections[name] = { ...connections[name],
              [member]: member === "url" ? connection_url(name, value) : value };
            continue;
          }
          if (["codeIndexEnabled", "bslLsEnabled"].includes(key)) {
            if (!config.active_project) throw new ConfigError("Выберите папку проекта.");
            root = configuration_root(config.active_project);
            (instanceChanges.components ||= {})[key === "codeIndexEnabled" ? "code-index" : "bsl-ls"] = { enabled: value };
            continue;
          }
          globalChanged = true;
          let target = config;
          const parts = FIELDS[key];
          for (const part of parts.slice(0, -1)) target = target[part] ||= {};
          target[parts.at(-1)] = value;
        }
        this.checked(config);
        if (config.active_project) {
          let profile;
          try { profile = project_profile(config.active_project); } catch { /* No usable profile yet. */ }
          if (profile) assert_settings_paths(config, config.active_project, profile, this.STATE, this.CONFIG);
        }
        let file = null,
          overrides;
        if (instanceChanges.connections || instanceChanges.components) {
          file = inside(root, ".ai/project.local.yaml");
          overrides = exists(file) ? load(file) : { connections: {} };
          check_schema(overrides, "project-local.schema.json");
          overrides = deep_merge(overrides, instanceChanges);
          check_schema(overrides, "project-local.schema.json");
          validate_override_urls(overrides);
          effective_settings(
            config,
            root,
            exists(path.join(root, ".ai/project.yaml"))
              ? project_profile(root)
              : null,
            overrides,
          );
        }
        const previousOverride = bytes(file),
          previousConfig = bytes(this.CONFIG);
        const oldText = previousOverride?.toString("utf8") ?? null;
        if (previousOverride !== null && !Buffer.from(oldText, "utf8").equals(previousOverride)) throw new ConfigError("Файл настроек должен быть в корректной кодировке UTF-8.");
        const overrideText = file ? patch_yaml_document(oldText, overrides) : null;
        if (file) backup_local_settings(this.STATE, root, previousOverride);
        let wroteOverride = false, ignorePlan;
        try {
          if (file) { ignorePlan = protect_local_layer(root); gitWarning = ignorePlan.gitWarning; atomic_write(file, overrideText, previousOverride !== null); wroteOverride = true; }
          if (globalChanged) this.store_shared_settings(config);
        } catch (error) {
          const failed = [];
          if (wroteOverride) try { const now = bytes(file); if (!now || !now.equals(Buffer.from(overrideText))) throw new Error("changed"); restore(file, previousOverride); } catch { failed.push(file); }
          try { restore_local_ignore(ignorePlan); } catch { failed.push(ignorePlan.target); }
          try { if (globalChanged) restore(this.CONFIG, previousConfig); } catch { failed.push(this.CONFIG); }
          if (failed.length) throw new ConfigError("Не удалось восстановить файлы: " + failed.join(", "));
          throw error;
        }
        return config;
      });
      return { values: this.values(config), gitWarning };
    }
    if (action === "updates") {
      const runtime = await import("./runtime.mjs"), config = this.effective(this.current());
      const component = request.component;
      if (component !== undefined && !managed_components.includes(component)) throw new ConfigError("Выберите компонент.");
      if (Object.hasOwn(request, "version") && request.operation !== "install") throw new ConfigError("Версия задаётся только для установки.");
      if (request.operation === "check") return { components: await Promise.all((component ? [component] : managed_components).map(async id => {
        try { return await runtime.check_updates(this.STATE, config, id); }
        catch (error) { return { component: id, state: "error", detail: safe_error_message(error) }; }
      })), projectRoot: config.active_project };
      if (!managed_components.includes(component)) throw new ConfigError("Выберите компонент.");
      let projectRoot;
      const result = await runtime.update_component(this.STATE, null, null, null, component, request.operation, {
        load_context: () => {
          const shared = this.current();
          if (Object.hasOwn(request, "version")) {
            shared.mcp.managed[component].version = request.version;
            shared.mcp.managed[component].allow_prerelease = false;
            this.checked(shared);
          }
          const config = this.effective(shared);
          if (Object.hasOwn(request, "version") && config.mcp.managed[component].version !== request.version)
            throw new ConfigError("Версия компонента закреплена локальными настройками проекта или экземпляра. Измените локальную версию перед установкой.");
          const [root, data] = runtime.project(config.active_project, config, component === "code-index");
          authorize_preparation(request, root);
          if (["install", "apply", "rollback"].includes(request.operation)) grant_preparation(this.STATE, root, [component]);
          projectRoot = root;
          return { config, root, data };
        },
        commit: release => {
          if (request.operation !== "rollback" && !Object.hasOwn(request, "version")) return;
          const shared = this.current(), version = request.operation === "rollback" ? release : request.version;
          shared.mcp.managed[component].version = version;
          shared.mcp.managed[component].allow_prerelease = false;
          this.checked(shared);
          if (this.effective(shared).mcp.managed[component].version !== version)
            throw new ConfigError("Локальные настройки версии изменились во время установки. Рабочая версия сохранена.");
          const previousConfig = bytes(this.CONFIG);
          this.store_shared_settings(shared);
          return () => restore(this.CONFIG, previousConfig);
        },
      });
      return { ...result, projectRoot };
    }
    if (action === "rebuild_index" || action === "restart_index") {
      if (action === "rebuild_index" && (Object.hasOwn(request, "all") && request.all !== true || (request.all === true) === Object.hasOwn(request, "repository")))
        throw new ConfigError("Выберите один EDT-проект или все EDT-проекты.");
      const runtime = await import("./runtime.mjs"), config = this.effective(this.current()), [root, data] = runtime.project(config.active_project, config, true);
      authorize_preparation(request, root);
      grant_preparation(this.STATE, root, ["code-index"]);
      const io = { progress: reportProgress };
      return action === "rebuild_index" ? request.all === true ? runtime.rebuild_all_indexes(this.STATE, config, root, data, io) : runtime.rebuild_index(this.STATE, config, root, data, request.repository, io) : runtime.restart_index(this.STATE, config, root, data, io);
    }
    if (action === "refresh_readiness") {
      const config = this.effective(this.current()), root = config.active_project;
      if (!root || request.scope !== preparation_scope(root)) throw new ConfigError("Проверка относится к другой папке или экземпляру.");
      const components = request.component ? [request.component] : ["edt", "v8std", "openviking", ...managed_components, "yaxunit", "vanessa"];
      if (request.connections !== undefined) throw new ConfigError("Обновление состояния использует сохранённые настройки.");
      const profile = project_profile(root), instance = instance_name();
      const vanessaSnapshot = components.includes("vanessa") ? vanessa_runtime_snapshot(root, profile) : undefined;
      let indexSnapshot;
      if (components.includes("code-index") && component_settings(config, "code-index").mode !== "external")
        try { indexSnapshot = capture_index_snapshot(this.STATE, root, profile); } catch { indexSnapshot = null; }
      const indexGrantIdentity = components.includes("code-index") && component_settings(config, "code-index").mode !== "external"
        ? preparation_identity(this.STATE, root) : null;
      const initialInputs = Object.fromEntries(components.map(id => [id, component_fingerprint(this.STATE, config, profile, id,
        { vanessaRuntimeSnapshot: id === "vanessa" ? vanessaSnapshot : undefined, indexSnapshot: id === "code-index" ? indexSnapshot : undefined })]));
      if (request.dispatchId !== undefined && (typeof request.dispatchId !== "string" || !/^[a-f0-9-]{36}$/.test(request.dispatchId))) throw new ConfigError("Некорректный идентификатор обновления.");
      if (request.observerSession !== undefined && (typeof request.observerSession !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(request.observerSession))) throw new ConfigError("Некорректный идентификатор сеанса наблюдения.");
      const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
      if (request.observedFlights !== undefined && (!object(request.observedFlights) || Object.entries(request.observedFlights).some(([id, value]) =>
        !["edt", "v8std", "openviking", "code-index", "bsl-ls", "yaxunit", "vanessa"].includes(id) || !object(value) ||
        Object.keys(value).sort().join(",") !== "owner,state,ticket" || !uuid.test(value.owner || "") || !uuid.test(value.ticket || "") ||
        !["running", "completed", "superseded"].includes(value.state)))) throw new ConfigError("Некорректный снимок общих проверок.");
      if (request.automatic !== undefined && typeof request.automatic !== "boolean") throw new ConfigError("Некорректный режим обновления.");
      const cancelled = () => request.dispatchId && exists(inside(this.STATE, path.join(".settings-refresh-cancel", request.dispatchId)));
      const priority = request.priority;
      if (priority && (priority.root !== path_identity(root) || priority.instance !== instance || typeof priority.revision !== "string" || priority.revision !== "" && !/^[a-f0-9-]{36}$/.test(priority.revision))) throw new ConfigError("Обновление относится к другому проекту или экземпляру.");
      const priorityChanged = () => priority && !readiness_priority_current(this.STATE, root, instance, priority);
      let transient = request.transient === true || Boolean(priority && await foreground_readiness_active(this.STATE, root, instance));
      // The UI does not publish transient evidence while preparation or an
      // explicit probe owns the foreground. Starting the same network checks
      // here would only duplicate that work and could not update the receipt.
      if (transient && !cancelled() && !priorityChanged()) return { projectRoot: root, instance, component: request.component,
        componentChecks: [], managed: [], external: {}, draft: false, transient: true, superseded: true,
        detail: "Проверка отложена до завершения текущей операции. " + barrier_recovery_hint(path.join(project_directory(this.STATE, root), "coordination", instance + ".readiness-active")) };
      const initialTransientReceipt = transient ? readiness_receipt_revision(this.STATE, root) : null;
      const ownerId = randomUUID(), owner = transient ? null : await open_reader(ownerId);
      try {
      const reservation = transient ? null : await operation_lock(this.STATE, () => {
        if (cancelled() || priorityChanged()) { transient = true; return null; }
        return reserve_component_flights(this.STATE, root, components, initialInputs, priority?.revision || "", ownerId,
          { automatic: request.automatic === true, session: request.observerSession, observedFlights: request.observedFlights || null, config, profile });
      }, 10);
      if (cancelled() || priorityChanged()) return { projectRoot: root, instance, component: request.component, componentChecks: [], managed: [], external: {}, draft: false, transient, superseded: true, supersededComponents: components };
      const observation = reservation?.observation, leaders = reservation?.leaders || components;
      const combined = leaders.includes("edt") && leaders.includes("yaxunit");
      const componentResults = Promise.all(leaders.filter(component => !combined || component !== "yaxunit")
        .map(async component => {
          try { return await this.main({ action: "probe", component, collectOnly: true }, reportProgress, { includeYaxunit: combined && component === "edt", observationContext: { config, profile, vanessaSnapshot, indexSnapshot, indexGrantIdentity } }); }
          catch (error) {
            if (error.cleanupUnconfirmed) throw error;
            const code = ["EACCES", "EPERM", "ENOENT", "ETIMEDOUT", "ECONNREFUSED", "RUNTIME_BUSY"].includes(error?.code) ? " (" + error.code + ")" : "";
            const detail = "Не удалось получить данные компонента" + code + ". Подробности находятся в диагностике.", checkedAt = new Date().toISOString();
            const check = { id: component, state: "not_verified", detail, checkedAt };
            return { componentChecks: [check, ...(combined && component === "edt" ? [{ ...yaxunit_result("request_failed"), checkedAt }] : [])],
              managed: managed_components.includes(component) ? [{ name: component, ...check, ready: false }] : [], external: {} };
          }
        }));
      // Wait outside the lock for exactly the owners observed during reservation.
      // A dead or unidentifiable owner never produces a successful shared result.
      const waitForJoined = async () => {
        const joined = reservation?.joined || {}, pending = new Map(Object.entries(joined)), completed = {};
        const deadline = performance.now() + 60000;
        const recoverIndex = async () => {
          if (!flightRecoveryBudget) return null;
          const recovered = await this.main({ ...request, component: "code-index" }, reportProgress, { flightRecoveryBudget: flightRecoveryBudget - 1 });
          if (recovered.superseded || !recovered.componentChecks?.length) return null;
          return operation_lock(this.STATE, () => {
            const latest = this.effective(this.current());
            if (cancelled() || priorityChanged() || latest.active_project !== root || instance_name() !== instance) return null;
            const latestProfile = project_profile(root), flight = capture_component_flights(this.STATE, root)["code-index"];
            if (flight?.state !== "completed") return null;
            const expected = { ...flight, fingerprint: component_fingerprint(this.STATE, latest, latestProfile, "code-index"), priority: priority?.revision || "" };
            const outcome = component_flight_result(this.STATE, root, latest, latestProfile, "code-index", expected);
            return outcome.state === "completed" ? { ...outcome, recoveredExpected: expected } : null;
          }, 10);
        };
        while (pending.size && performance.now() < deadline) {
          const states = await operation_lock(this.STATE, () => {
            const latest = this.effective(this.current());
            if (cancelled() || latest.active_project !== root || instance_name() !== instance)
              return Object.fromEntries([...pending.keys()].map(id => [id, { state: "superseded" }]));
            const latestProfile = project_profile(root), cache = {};
            return Object.fromEntries([...pending].map(([id, expected]) => [id, component_flight_result(this.STATE, root, latest, latestProfile, id, expected, cache)]));
          }, 10);
          for (const [id, outcome] of Object.entries(states)) if (outcome.state !== "running") {
            const expected = pending.get(id);
            pending.delete(id);
            if (outcome.state === "completed") completed[id] = outcome;
            else if (id === "code-index" && flightRecoveryBudget && await reader_active(expected.owner).catch(() => null) === false) {
              const recovered = await recoverIndex();
              if (recovered) completed[id] = recovered;
            }
          }
          if (!pending.size) break;
          const owners = [...new Set([...pending.values()].map(item => item.owner))];
          const live = new Map(await Promise.all(owners.map(async id => [id, await reader_active(id).catch(() => null)])));
          for (const [id, expected] of pending) if (live.get(expected.owner) === false) {
            // The leader may have committed between our last read and its
            // listener closing. Recheck its exact ticket before reclaiming.
            const outcome = await operation_lock(this.STATE, () => {
              const latest = this.effective(this.current());
              if (cancelled() || latest.active_project !== root || instance_name() !== instance) return { state: "superseded" };
              const checked = component_flight_result(this.STATE, root, latest, project_profile(root), id, expected);
              if (checked.state === "running") abandon_component_flight(this.STATE, root, id, expected);
              return checked;
            }, 10);
            pending.delete(id);
            if (outcome.state === "completed") completed[id] = outcome;
            else if (id === "code-index") {
              const recovered = await recoverIndex();
              if (recovered) completed[id] = recovered;
            }
          }
          if (pending.size) await new Promise(done => setTimeout(done, 150));
        }
        return completed;
      };
      const [results, joinedChecks] = await Promise.all([componentResults, waitForJoined()]);
      const dispatchedInputs = Object.assign({}, ...results.map(item => item.observationInputs || {}));
      const indexTransition = results.find(item => item.indexTransition)?.indexTransition;
      let superseded, supersededComponents = [];
      const componentChecks = await operation_lock(this.STATE, () => {
        const latest = this.effective(this.current());
        const scopeChanged = Boolean(cancelled()) || latest.active_project !== root || instance_name() !== instance ||
          transient && initialTransientReceipt !== readiness_receipt_revision(this.STATE, root);
        const latestProfile = scopeChanged ? null : project_profile(root), cache = {};
        const updatedFingerprints = {};
        if (!scopeChanged && indexTransition && indexSnapshot && indexTransition.before === initialInputs["code-index"]) {
          const currentSnapshot = capture_index_snapshot(this.STATE, root, latestProfile);
          const baseline = component_fingerprint(this.STATE, latest, latestProfile, "code-index", { indexSnapshot: { ...currentSnapshot, files: indexSnapshot.files } });
          const current = component_fingerprint(this.STATE, latest, latestProfile, "code-index", { indexSnapshot: currentSnapshot });
          if (baseline === indexTransition.before && current === indexTransition.after) {
            initialInputs["code-index"] = current;
            updatedFingerprints["code-index"] = current;
          }
        }
        const joinedIndex = joinedChecks["code-index"];
        if (!scopeChanged && joinedIndex && reservation?.joined["code-index"]?.fingerprint === initialInputs["code-index"]) {
          const current = component_fingerprint(this.STATE, latest, latestProfile, "code-index");
          let baseline = initialInputs["code-index"];
          if (joinedIndex.recoveredExpected && indexSnapshot) {
            const currentSnapshot = capture_index_snapshot(this.STATE, root, latestProfile);
            baseline = component_fingerprint(this.STATE, latest, latestProfile, "code-index", { indexSnapshot: { ...currentSnapshot, files: indexSnapshot.files } });
          }
          if (baseline === initialInputs["code-index"] && joinedIndex.fingerprint === current) {
            initialInputs["code-index"] = current;
            if (joinedIndex.recoveredExpected) reservation.joined["code-index"] = joinedIndex.recoveredExpected;
          }
        }
        supersededComponents = components.filter(id => scopeChanged ||
          id === "code-index" && indexGrantIdentity !== null && indexGrantIdentity !== preparation_identity(this.STATE, root) ||
          !transient && leaders.includes(id) && !component_check_current(this.STATE, root, observation, id, cache) ||
          leaders.includes(id) && dispatchedInputs[id] !== undefined && dispatchedInputs[id] !== initialInputs[id] ||
          !transient && !leaders.includes(id) && (!joinedChecks[id] || component_flight_result(this.STATE, root, latest, latestProfile, id, reservation.joined[id], cache).state !== "completed") ||
          initialInputs[id] !== component_fingerprint(this.STATE, latest, latestProfile, id));
        superseded = supersededComponents.length === components.length;
        const now = Date.now(), checkedAt = new Date(now).toISOString();
        const checks = [...results.flatMap(item => item.componentChecks), ...Object.values(joinedChecks).map(item => item.check)].map(item => {
          if (item.state !== "ready" || item.id === "vanessa" || item.validity === "inputs") return item;
          const observed = Date.parse(item.checkedAt), expires = Number.isFinite(Date.parse(item.expiresAt)) ? Date.parse(item.expiresAt) : observed + 15 * 60 * 1000;
          if (Number.isFinite(observed) && expires > now) return item;
          const detail = "Подтверждение устарело до завершения проверки. Повторим автоматически.";
          return item.id === "yaxunit" ? yaxunit_result("not_checked", { checkedAt, lastState: "ready", detail }) : { ...item, state: "not_verified", lastState: "ready", checkedAt, expiresAt: undefined, detail };
        });
        const accepted = checks.filter(item => !supersededComponents.includes(item.id));
        if (superseded) { if (reservation) complete_component_flights(this.STATE, root, reservation, []); return checks; }
        if (transient) return accepted;
        const own = accepted.filter(item => leaders.includes(item.id));
        const saved = own.length ? save_component_checks(this.STATE, latest, latestProfile, own) : [];
        if (reservation) complete_component_flights(this.STATE, root, reservation, saved, Object.assign({}, ...results.map(item => item.external)), updatedFingerprints);
        return [...saved, ...accepted.filter(item => !leaders.includes(item.id))];
      }, 10);
      const readiness = superseded || transient ? null : await read_readiness(this.STATE, config, profile);
      return sanitize_setup_result({ projectRoot: root, instance, component: request.component,
        componentChecks, managed: [...results.flatMap(item => item.managed || []), ...Object.values(joinedChecks).map(item => item.check).filter(item => managed_components.includes(item.id)).map(item => ({ name: item.id, ...item, ready: item.state === "ready" }))].filter(item => !supersededComponents.includes(item.name)),
        external: Object.fromEntries(Object.entries(Object.assign({}, ...results.map(item => item.external), ...Object.entries(joinedChecks).filter(([, item]) => item.external).map(([id, item]) => ({ [id]: item.external })))).filter(([id]) => !supersededComponents.includes(id))),
        ...(["ready", "blocked", "stale"].includes(readiness?.state) ? { readiness } : {}),
        draft: false, transient, superseded, ...(supersededComponents.length ? { supersededComponents } : {}) });
      } finally { await owner?.close(); }
    }
    if (action === "check") {
      const runtime = await import("./runtime.mjs"),
        policy = await import("./policy_runtime.mjs");
      const config = this.effective(this.current()),
        [root, data] = runtime.project(config.active_project, config, component_enabled(config, "code-index"));
      authorize_preparation(request, root);
      grant_preparation(this.STATE, root, managed_components.filter(component => component_enabled(config, component)));
      const check_component = async component => {
        if (!component_enabled(config, component)) return { name: component, ready: true, state: "disabled", detail: "Компонент отключён; установка и запуск пропущены." };
        const localBsl = component === "bsl-ls" && component_settings(config, component).mode !== "external";
        let inputRevision = null, selectedArtifact = null;
        if (localBsl && request.refresh !== true) {
          const saved = read_component_checks(this.STATE, config, data).find(item => item.id === component && item.validity === "inputs" &&
            (item.state === "ready" || item.state === "not_verified" && item.apiCompatible === true));
          if (saved) return { ...saved, name: component, ready: saved.state === "ready" };
        }
        try {
          if (localBsl) {
            const inputs = await bsl_check_inputs(this.STATE, config, runtime, true, request.refresh === true);
            selectedArtifact = inputs.jar; inputRevision = inputs.inputRevision;
          }
          const item = await runtime.smoke(
              this.STATE,
              config,
              root,
              data,
              component,
              90,
              localBsl ? false : request.refresh === true,
              selectedArtifact,
              true,
            ),
            ready = item.index_ready !== false;
          const result = {
            name: component,
            ready,
            state: ready ? "ready" : item.index_state || "not_checked",
            ...(localBsl ? { inputRevision: inputRevision || bsl_readiness_fingerprint(this.STATE, config) } : {}),
            ...(item.index ? { repositories: item.index.repositories, ...(item.index.missingProjects?.length ? { detail: "Не найден или неоднозначен .project для: " + item.index.missingProjects.join(", ") } : {}), ...(item.index.retryable ? { retryable: true, detail: "Индекс найден; сервис ещё не подтвердил актуальность данных." } : {}) } : {}),
            version: item.server?.version,
          };
          return component === "bsl-ls" && ready ? bsl_api_observed(result, { external: !localBsl, live: true }) : result;
        } catch (error) {
          const busy = error.remote !== true && error.code === "RUNTIME_BUSY";
          return {
            name: component,
            ready: false,
            state: error.inputsChanged ? "check_stale" : busy ? "preparing" : "error",
            ...(inputRevision ? { inputRevision } : {}),
            detail: busy ? "Подготовка окружения выполняется…" : safe_error_message(error),
          };
        }
      };
      const check_policy = async () => { try {
        const item = await policy.smoke(config);
        return {
          name: "policy",
          ready: true,
          state: "ready",
          version: item.server.version,
        };
      } catch (error) {
        return {
          name: "policy",
          ready: false,
          state: "error",
          detail: safe_error_message(error),
        };
      } };
      const { probe_connections, edt_project_building } = await import("./setup_probe.mjs");
      atomic_write(reconnect_file(this.STATE, root), JSON.stringify({ id: randomUUID() }));
      const instance = instance_name();
      // Preparation may legitimately create runtime/daemon files. Project
      // bindings and descriptors, however, must stay unchanged throughout it.
      const stableInputs = { includeDaemonOwner: false, includeRuntime: false, includeReconnect: false };
      const { initialReceipt, initialProjectInputs, observation } = await operation_lock(this.STATE, () => ({
        initialReceipt: readiness_receipt_revision(this.STATE, root),
        initialProjectInputs: readiness_fingerprint(this.STATE, config, data, undefined, stableInputs),
        observation: begin_component_checks(this.STATE, root, [...managed_components, "edt", "v8std", "openviking", "yaxunit"]),
      }), 1);
      const [components, policyResult, probes] = await Promise.all([
        (async () => { const items = []; for (const component of managed_components) { const item = await check_component(component); item.checkedAt ||= new Date().toISOString(); items.push(item); } return items; })(),
        (async () => ({ ...(await check_policy()), checkedAt: new Date().toISOString() }))(), probe_connections(config, root, data, this.STATE, null, true),
      ]);
      const managed = [...components, policyResult], external = probes.external;
      const bsl = managed.find(item => item.name === "bsl-ls");
      if (bsl?.inputRevision && bsl.inputRevision !== bsl_readiness_fingerprint(this.STATE, config)) {
        bsl.ready = false; bsl.state = "check_stale"; bsl.detail = "Окружение BSL LS изменилось во время проверки. Повторите проверку.";
      }
      const inputs = readiness_fingerprint(this.STATE, config, data), testing = probes.componentChecks;
      let superseded = false;
      const readiness = await operation_lock(this.STATE, () => {
        const latest = this.effective(this.current());
        const latestProfile = project_profile(root);
        superseded = latest.active_project !== root || instance_name() !== instance || !component_checks_current(this.STATE, root, observation) || initialReceipt !== readiness_receipt_revision(this.STATE, root) || inputs !== readiness_fingerprint(this.STATE, latest, latestProfile) || initialProjectInputs !== readiness_fingerprint(this.STATE, latest, latestProfile, undefined, stableInputs);
        if (superseded) return null;
        const now = Date.now(), checkedAt = new Date(now).toISOString(), limits = [];
        const fresh = item => {
          if (item.state === "disabled" || item.validity === "inputs" || item.name === "bsl-ls" && item.inputRevision && component_settings(config, "bsl-ls").mode !== "external") return true;
          const observed = Date.parse(item.checkedAt), declared = Date.parse(item.expiresAt);
          const expires = Math.min(observed + 15 * 60 * 1000, Number.isFinite(declared) ? declared : Infinity);
          if (!Number.isFinite(observed) || observed > now || expires <= now) return false;
          limits.push(expires); return true;
        };
        for (const item of managed) if (!fresh(item)) Object.assign(item, { ready: false, state: "not_verified", checkedAt, expiresAt: undefined, detail: "Подтверждение устарело до завершения проверки. Повторим автоматически." });
        for (const [id, item] of Object.entries(external)) if (!fresh(item)) external[id] = { ...item, ready: false, connected: true, checkedAt, expiresAt: undefined, detail: "Подтверждение устарело до завершения проверки. Повторим автоматически." };
        for (let i = 0; i < testing.length; i++) if (!fresh(testing[i])) testing[i] = yaxunit_result("not_checked", { checkedAt, lastState: testing[i].state, detail: "Подтверждение устарело до завершения проверки. Повторим автоматически." });
        const checks = [...managed.filter(item => item.name !== "policy").map(item => ({ ...item, id: item.name })),
          ...Object.entries(external).map(([id, item]) => ({ id, state: item.ready ? "ready" : !item.configured ? "missing_config" : id === "edt" && edt_project_building(item) ? "building" : item.connected ? "not_verified" : "error", detail: item.detail, repositories: item.repositories, checkedAt: item.checkedAt, expiresAt: item.readiness?.expiresAt,
            ...(id === "openviking" ? { readiness: item.readiness, access: item.access, publicationEvidence: item.publicationEvidence } : {}) })), ...testing];
        return save_readiness(this.STATE, config, data, managed, external, testing, { componentChecks: checks, maxExpiresAt: Math.min(...limits) });
      });
      if (superseded) return sanitize_setup_result({ managed, external, componentChecks: testing, superseded, projectRoot: root, instance, fullReadiness: "not_verified" });
      const savedBsl = read_component_checks(this.STATE, config, data).find(item => item.id === "bsl-ls" && item.validity === "inputs");
      if (savedBsl && bsl) Object.assign(bsl, savedBsl, { ready: savedBsl.state === "ready" });
      return sanitize_setup_result({
        managed,
        projectRoot: root,
        instance: instance_name(),
        actionPolicy: effective_policy(data.policy),
        external,
        componentChecks: readiness.componentChecks,
        readiness: readiness.readiness,
        fullReadiness: readiness.readiness.state === "ready" ? "verified" : "not_ready",
        readinessScope: "setup",
        workflowReadiness: readiness.readiness.workflowReadiness,
      });
    }
    throw new ConfigError("Неизвестная операция.");
  }
}
const INDEX_OBSERVATION_TIMEOUT_MS = 75000;
function parent_index_observer(token) {
  const pending = new Map();
  const onMessage = message => {
    if (message?.type !== "index_observation_result" || message.token !== token || typeof message.id !== "string") return;
    const item = pending.get(message.id); if (!item) return;
    pending.delete(message.id); clearTimeout(item.timer);
    if (message.ok === true) item.resolve(message.result);
    else item.reject(Object.assign(new Error(message.error || "Не удалось получить состояние индекса."), {
      ...(message.code ? { code: message.code } : {}), ...(message.inputsChanged ? { inputsChanged: true } : {}),
      ...(message.outcomeUnknown ? { outcomeUnknown: true } : {}), ...(message.cleanupUnconfirmed ? { cleanupUnconfirmed: true } : {}),
      ...(message.remote ? { remote: true } : {}),
    }));
  };
  const onDisconnect = () => {
    for (const item of pending.values()) { clearTimeout(item.timer); item.reject(new ConfigError("Сеанс наблюдения индекса закрыт.")); }
    pending.clear();
  };
  process.on("message", onMessage); process.once("disconnect", onDisconnect);
  return {
    observe(payload) {
      if (!process.connected) return Promise.reject(new ConfigError("Сеанс наблюдения индекса закрыт."));
      const id = randomUUID();
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          if (process.connected) try { process.send({ type: "index_observation_cancel", token, id }, () => {}); } catch {}
          reject(new ConfigError("Истекло время наблюдения индекса."));
        }, INDEX_OBSERVATION_TIMEOUT_MS);
        pending.set(id, { resolve, reject, timer });
        process.send({ type: "index_observation", token, id, ...payload }, error => {
          if (!error || !pending.has(id)) return;
          pending.delete(id); clearTimeout(timer); reject(error);
        });
      });
    },
    close() { process.removeListener("message", onMessage); process.removeListener("disconnect", onDisconnect); onDisconnect(); },
  };
}
if (entrypoint(import.meta.url)) {
  let indexBridge, localObserver;
  try {
    if (process.platform === "linux" && process.env.EDT_AI_SETTINGS_PARENT_PID !== undefined) {
      const expected = Number(process.env.EDT_AI_SETTINGS_PARENT_PID);
      delete process.env.EDT_AI_SETTINGS_PARENT_PID;
      linux_require_parent(expected);
    }
    let input = "";
    for await (const chunk of process.stdin) {
      input += chunk;
      // Two 2 MiB YAML documents can expand in JSON escaping; ZIP bytes
      // expand to base64. Individual operations enforce their own byte limits.
      if (Buffer.byteLength(input) > 26 * 1024 * 1024)
        throw new Error("Запрос превышает допустимый размер");
    }
    const request = JSON.parse(input), token = request._indexObserverToken;
    delete request._indexObserverToken;
    if (token !== undefined) {
      if (!["refresh_readiness", "probe"].includes(request.action) || !process.connected || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(token))
        throw new ConfigError("Некорректный канал наблюдения индекса.");
      indexBridge = parent_index_observer(token);
    } else if (["refresh_readiness", "probe"].includes(request.action)) {
      // Standalone CLI checks need the same crash-independent reader cleanup
      // as checks routed through the settings MCP session.
      const { IndexObserverProxy } = await import("./index_observer_proxy.mjs");
      localObserver = new IndexObserverProxy(process.env.EDT_AI_STATE_DIR);
      indexBridge = { observe: async ({ config, root, profile, snapshot }) => {
        let timer;
        try {
          return await Promise.race([
            localObserver.observe(config, root, profile, snapshot),
            new Promise((_, reject) => { timer = setTimeout(() => reject(new ConfigError("Истекло время наблюдения индекса.")), INDEX_OBSERVATION_TIMEOUT_MS); }),
          ]);
        } finally { clearTimeout(timer); }
      } };
    }
    let result;
    try {
      result = await new SettingsBackend(undefined, undefined, { observeIndex: indexBridge?.observe }).main(request, progress => {
        if (process.connected) try { process.send({ type: "progress", progress }, () => {}); } catch {}
      });
    } finally { if (localObserver) await localObserver.close(); }
    console.log(JSON.stringify({ ok: true, result }));
  } catch (error) {
    console.log(JSON.stringify({ ok: false, error: safe_error_message(error), diagnosticFailure: diagnostic_failure(error), ...(error.code ? { errorCode: error.code } : {}), ...(Number.isSafeInteger(error.documentLine) ? { documentLine: error.documentLine } : {}), ...(error.outcomeUnknown ? { outcomeUnknown: true } : {}) }));
    process.exitCode = 1;
  } finally {
    indexBridge?.close?.();
    if (process.connected) process.disconnect();
  }
}
