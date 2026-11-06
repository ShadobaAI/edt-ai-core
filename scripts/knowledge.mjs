// Knowledge configuration is project-owned; transport alone never selects it.
import fs from "node:fs";
import path from "node:path";
import { ConfigError, sha256 } from "./project_paths.mjs";
import { check_schema, validate_openviking_url, inside, parse, stable } from "./common.mjs";

export const WORKFLOW_ACTIONS = Object.freeze(["discovery", "design", "implementation", "review", "runtime"]);
export const SEARCH_REQUIREMENTS = Object.freeze({ publication: "verified", snapshot: "consistent", access: "read_only",
  max_results: 10, max_excerpt_chars: 1000, max_material_chars: 20000 });
const confirmations = new WeakMap();
// Process-local capability: a JSON status/receipt supplied by a caller cannot
// authorize workflow. The owner must keep checking its original connection.
export function knowledge_confirmation(profile, config, check) {
  const token = Object.freeze({});
  confirmations.set(token, { profile: stable(profile), config: stable(config), check });
  return token;
}

export function search_requirements(profile) {
  check_schema(profile, "project-profile.schema.json");
  return profile.knowledge.provider === "none" ? null : { ...SEARCH_REQUIREMENTS, ...profile.knowledge.search };
}

export function validate_manifest(data, selectedCollections = []) {
  check_schema(data, "knowledge-manifest.schema.json");
  const collections = new Set(data.collections.map(item => item.id));
  if (collections.size !== data.collections.length) throw new ConfigError("Идентификаторы коллекций манифеста должны быть уникальными");
  for (const id of selectedCollections)
    if (!collections.has(id)) throw new ConfigError("Неизвестная выбранная коллекция манифеста: " + id);
  const ids = new Set(), paths = new Set();
  for (const material of data.materials) {
    portable_path(material.path);
    if (!collections.has(material.collection)) throw new ConfigError("Неизвестная коллекция материала: " + material.collection);
    if (ids.has(material.id) || paths.has(material.path)) throw new ConfigError("Идентификаторы и пути материалов манифеста должны быть уникальными");
    ids.add(material.id); paths.add(material.path);
  }
  return data;
}

export function validate_material(data) {
  check_schema(data, "knowledge-material.schema.json");
  reference_path(data.provenance.source);
  if (data.kind === "api_card") {
    reference_path(data.verification_ref);
    const date = new Date(data.verified_at + "T00:00:00Z");
    if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== data.verified_at)
      throw new ConfigError("Некорректная календарная дата verified_at материала");
  }
  return data;
}

// Provider-independent retrieval policy. Metadata is a declaration; neither a
// valid shape nor a declared status authenticates publication or applicability.
export function knowledge_material_active(metadata) {
  validate_material(metadata);
  return metadata.kind === "document" ? metadata.status === "published" : metadata.status !== "obsolete";
}
export function knowledge_material_summary(metadata, { body, maxExcerptChars = 1000, partial = false } = {}) {
  validate_material(metadata);
  const excerpt = metadata.kind === "api_card" && metadata.recommendation === "avoid" ? metadata.avoid_reason : body;
  return { id: metadata.id, kind: metadata.kind, title: metadata.title, source: metadata.provenance.source,
    revision: metadata.revision, scope: metadata.scope, compatibility: metadata.compatibility, status: metadata.status,
    evidence: { metadata: "unverified_declaration", publication: "not_verified", compatibility: "not_verified" },
    ...(metadata.kind === "api_card" ? { apiPolicy: {
      apiReference: metadata.recommended_api, recommendation: metadata.recommendation,
      evidenceRole: metadata.recommendation === "avoid" ? "avoidance_warning" : metadata.status === "confirmed" ? "declared_scoped_confirmation" : "verification_pointer",
      newCall: metadata.recommendation === "avoid" ? "not_recommended" : metadata.status === "confirmed" ? "candidate_after_scope_verification" : "requires_reverification",
      applicabilityToCurrentTask: "not_verified", verificationRef: metadata.verification_ref, verifiedAt: metadata.verified_at,
      ...(metadata.recommendation === "avoid" ? { avoidReason: metadata.avoid_reason } : {})
    } } : { documentPolicy: { publicationStatus: metadata.status, evidenceRole: "publication_declaration", apiApplicability: "not_proven" } }),
    ...(body !== undefined ? { excerpt: excerpt.slice(0, maxExcerptChars),
      excerptTruncated: excerpt.length > maxExcerptChars || excerpt === body && partial } : {}) };
}

// Validating this declaration does not authenticate the publisher or prove
// index completeness, access rights, current binding or readiness.
export function validate_publication_receipt(data) {
  check_schema(data, "knowledge-publication-receipt.schema.json");
  validate_openviking_url(data.server.endpoint);
  reference_path(data.evidence_ref);
  const ids = data.collection_snapshots.map(item => item.collection);
  if (new Set(ids).size !== ids.length || stable([...ids].sort()) !== stable([...data.collections].sort()))
    throw new ConfigError("Снимки коллекций публикации должны точно соответствовать выбранному набору коллекций");
  for (const { root } of data.collection_snapshots)
    if (root.slice("viking://resources/".length).split("/").some(part => !part || part === "." || part === ".."))
      throw new ConfigError("Корень коллекции публикации должен быть каноническим");
  const roots = data.collection_snapshots.map(item => item.root);
  if (roots.some((root, index) => roots.some((other, second) => index !== second && (root === other || root.startsWith(other + "/")))))
    throw new ConfigError("Корни коллекций публикации не должны пересекаться");
  for (const field of ["verified_at", "expires_at"]) {
    const instant = new Date(data[field]);
    const canonical = data[field].includes(".") ? data[field] : data[field].replace(/Z$/, ".000Z");
    if (!Number.isFinite(instant.getTime()) || instant.toISOString() !== canonical)
      throw new ConfigError("Некорректная календарная метка подтверждения публикации: " + field);
  }
  if (Date.parse(data.expires_at) <= Date.parse(data.verified_at))
    throw new ConfigError("В подтверждении публикации expires_at должен следовать после verified_at");
  return data;
}

// A digest of the complete active set, including an empty collection. The
// publisher uses the same canonical JSON; ordering in YAML has no meaning.
export function publication_inventory(manifest, selectedCollections) {
  validate_manifest(manifest, selectedCollections);
  if (manifest.kind !== "catalog" || !selectedCollections.length || new Set(selectedCollections).size !== selectedCollections.length)
    throw new ConfigError("Для состава публикации нужен каталог и уникальные выбранные коллекции");
  return [...selectedCollections].sort().map(collection => {
    const entries = manifest.materials.filter(item => item.collection === collection)
      .map(({ id, collection, path, sha256 }) => ({ id, collection, path, sha256 }))
      .sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
    return { collection, material_count: entries.length, materials_sha256: sha256(stable(entries)) };
  });
}

// Use one portable spelling. In particular, Windows device names, ADS and
// encoded separators must not acquire another meaning on a different host.
function portable_path(value) {
  if (typeof value !== "string" || !value || /[\\:\u0000-\u001f\u007f<>|?*%#]/u.test(value) ||
      value.split("/").some(part => !part || [".", ".."].includes(part) || /[. ]$/.test(part) ||
        /^(con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i.test(part)))
    throw new ConfigError("Путь знаний должен быть переносимым относительным путём без выхода за границы и имён устройств");
  return value;
}

// References are data. Never fetch a URL, execute a URI or read a referenced
// source file while validating the catalog.
function reference_path(value) {
  if (typeof value !== "string" || !value || /[\s\u0000-\u001f\u007f]/u.test(value))
    throw new ConfigError("Некорректная ссылка материала");
  if (/^https?:\/\//.test(value)) {
    let uri;
    try { uri = new URL(value); } catch { throw new ConfigError("Некорректная HTTP-ссылка материала"); }
    if (!uri.hostname || uri.username || uri.password || uri.port === "0" || value.endsWith("#") || value.includes("\\"))
      throw new ConfigError("Некорректная HTTP-ссылка материала: учётные данные или ошибочный URL");
    return null;
  }
  const [file, ...fragment] = value.split("#");
  if (fragment.length > 1 || fragment.length && !fragment[0]) throw new ConfigError("Некорректный фрагмент ссылки материала");
  if (file) portable_path(file);
  else if (!fragment.length) throw new ConfigError("Пустая ссылка материала");
  return file;
}

function regular_file(file) {
  let stat;
  try { stat = fs.statSync(file, { bigint: true }); } catch { throw new ConfigError("Файл знаний отсутствует: " + file); }
  if (!stat.isFile()) throw new ConfigError("Путь знаний должен указывать на обычный файл: " + file);
  return stat;
}

export function parse_material(text) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)([\s\S]*)$/.exec(text.replace(/^\uFEFF/, ""));
  if (!match || !match[2].trim()) throw new ConfigError("Для материала знаний нужны заголовок YAML и непустой текст Markdown");
  return validate_material(parse(match[1]));
}

// Published retrieval needs the catalog and containment, not a rescan of local
// source documents. Their remote bytes are checked against this catalog when
// addressed; imports and source validation still use the full loader below.
export function load_manifest_catalog(root, relative, selectedCollections = []) {
  portable_path(relative);
  const file = inside(root, relative);
  regular_file(file);
  const bytes = fs.readFileSync(file), data = validate_manifest(parse(bytes.toString("utf8")), selectedCollections);
  if (data.kind !== "catalog") throw new ConfigError("Манифест рекомендаций нельзя использовать как опубликованный каталог");
  for (const entry of data.materials) inside(path.dirname(file), entry.path);
  return { data, sha256: sha256(bytes) };
}

export function load_manifest(root, relative, selectedCollections = []) {
  const catalog = load_manifest_catalog(root, relative, selectedCollections), data = catalog.data, file = inside(root, relative);
  const corpus = path.dirname(file), files = new Set(), materials = [];
  for (const entry of data.materials) {
    const target = inside(corpus, entry.path), stat = regular_file(target), identity = `${stat.dev}:${stat.ino}`;
    if (files.has(identity)) throw new ConfigError("Пути материалов манифеста указывают на один файл");
    files.add(identity);
    const content = fs.readFileSync(target);
    if (sha256(content) !== entry.sha256) throw new ConfigError("Не совпадает SHA-256 материала знаний: " + entry.id);
    const metadata = parse_material(content.toString("utf8"));
    if (metadata.id !== entry.id) throw new ConfigError("Не совпадают идентификаторы манифеста и материала: " + entry.id);
    if (metadata.kind === "document" ? metadata.status !== "published" : metadata.status === "obsolete")
      throw new ConfigError("Неактивный материал знаний в каталоге: " + entry.id);
    for (const ref of [metadata.provenance.source, ...(metadata.kind === "api_card" ? [metadata.verification_ref] : [])]) {
      const linked = reference_path(ref);
      if (linked !== null) regular_file(linked ? inside(corpus, linked) : target);
    }
    materials.push({ ...entry, metadata });
  }
  return { ...catalog, materials };
}

export function knowledge_status(profile, config) {
  const { provider, mode = null, collections = [], required = false, dependent_actions = [] } = profile?.knowledge || {};
  const transport = config?.mcp?.optional?.openviking;
  const enabled = Boolean(transport) && transport.enabled !== false;
  const result = { provider, mode, collections: structuredClone(collections), required, dependentActions: structuredClone(dependent_actions),
    configured: false, connected: false, ready: false, lifecycle: "saved", searchReadiness: "not_verified", readinessScope: "configuration",
    transport: { enabled, endpointConfigured: typeof transport?.url === "string" && Boolean(transport.url) },
    coverage: "not_verified", coverageScope: "selected_collections", apiExistence: "not_determined",
    workflowScope: mode === "kora" ? "all" : "dependent_actions", koraReady: false };
  try {
    check_schema(profile, "project-profile.schema.json");
    check_schema(config, "plugin-settings.schema.json");
    if (transport?.url) validate_openviking_url(transport.url);
  } catch (error) {
    return { ...result, state: "invalid", lifecycle: "invalid", detail: "Некорректная настройка знаний: " + error.message };
  }
  if (provider === "none") return { ...result, state: enabled ? "invalid" : "disabled", lifecycle: enabled ? "invalid" : "disabled",
    detail: enabled ? "Транспорт OpenViking включён, но в профиле задано knowledge.provider: none." : "Знания явно отключены; покрытие базы знаний не подтверждается." };
  if (!enabled && !required) return { ...result, state: "disabled", lifecycle: "disabled",
    detail: "Необязательное подключение знаний отключено; выбранный профиль и адрес сохранены." };
  const configured = enabled && Boolean(transport?.url);
  return { ...result, configured, lifecycle: configured ? "configured" : "saved", state: configured ? "not_verified" : "not_configured",
    detail: configured ? "Готовность поиска по выбранным коллекциям ещё не проверена."
      : "Подключение OpenViking отключено или его URL пуст; требования профиля к знаниям сохраняются." };
}

// This decision only constrains knowledge dependencies; it grants no authority
// or permission and cannot replace the shared action policy.
export function knowledge_gate(profile, config, action, confirmation = null) {
  let knowledge = knowledge_status(profile, config);
  const proof = confirmation && confirmations.get(confirmation);
  if (knowledge.state === "not_verified" && proof?.profile === stable(profile) && proof.config === stable(config)) {
    const observation = proof.check();
    if (observation?.ready === true) knowledge = { ...knowledge, state: "ready", lifecycle: "ready", connected: true, ready: true,
      searchReadiness: "ready", readiness: observation.readiness, koraReady: knowledge.mode === "kora",
      readinessScope: "workflow",
      detail: "Готовность поиска по выбранным коллекциям подтверждена для этого подключения." };
  }
  const dependent = knowledge.mode === "kora" || action === "knowledge_search" || knowledge.required && Array.isArray(knowledge.dependentActions) &&
    (action === "workflow" || knowledge.dependentActions.includes(action));
  const blocked = knowledge.state === "invalid" || dependent && knowledge.state !== "ready";
  return { allowed: !blocked, scope: "workflow", action, dependent, knowledge,
    ...(blocked ? { reason: knowledge.detail } : {}) };
}

export function require_workflow_knowledge(profile, config, action = "workflow", confirmation = null) {
  const gate = knowledge_gate(profile, config, action, confirmation);
  if (!gate.allowed) throw new ConfigError("Рабочий процесс заблокирован настройкой знаний: " + gate.reason);
  return gate;
}
