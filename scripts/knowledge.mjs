// Knowledge configuration is project-owned; transport alone never selects it.
import fs from "node:fs";
import path from "node:path";
import { ConfigError, sha256 } from "./project_paths.mjs";
import { check_schema, validate_openviking_url, inside, parse, stable } from "./common.mjs";

export const WORKFLOW_ACTIONS = Object.freeze(["discovery", "design", "implementation", "review", "runtime"]);
export const SEARCH_REQUIREMENTS = Object.freeze({ publication: "verified", snapshot: "consistent", access: "read_only",
  max_results: 10, max_excerpt_chars: 1000, max_material_chars: 20000 });

export function search_requirements(profile) {
  check_schema(profile, "project-profile.schema.json");
  return profile.knowledge.provider === "none" ? null : { ...SEARCH_REQUIREMENTS, ...profile.knowledge.search };
}

export function validate_manifest(data, selectedCollections = []) {
  check_schema(data, "knowledge-manifest.schema.json");
  const collections = new Set(data.collections.map(item => item.id));
  if (collections.size !== data.collections.length) throw new ConfigError("Manifest collection ids must be unique");
  for (const id of selectedCollections)
    if (!collections.has(id)) throw new ConfigError("Unknown selected manifest collection: " + id);
  const ids = new Set(), paths = new Set();
  for (const material of data.materials) {
    portable_path(material.path);
    if (!collections.has(material.collection)) throw new ConfigError("Unknown material collection: " + material.collection);
    if (ids.has(material.id) || paths.has(material.path)) throw new ConfigError("Manifest material ids and paths must be unique");
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
      throw new ConfigError("Invalid material verified_at calendar date");
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
    throw new ConfigError("Publication collection snapshots must match the exact selected collection set");
  for (const { root } of data.collection_snapshots)
    if (root.slice("viking://resources/".length).split("/").some(part => !part || part === "." || part === ".."))
      throw new ConfigError("Publication collection root must be canonical");
  const roots = data.collection_snapshots.map(item => item.root);
  if (roots.some((root, index) => roots.some((other, second) => index !== second && (root === other || root.startsWith(other + "/")))))
    throw new ConfigError("Publication collection roots must not overlap");
  for (const field of ["verified_at", "expires_at"]) {
    const instant = new Date(data[field]);
    const canonical = data[field].includes(".") ? data[field] : data[field].replace(/Z$/, ".000Z");
    if (!Number.isFinite(instant.getTime()) || instant.toISOString() !== canonical)
      throw new ConfigError("Invalid publication receipt calendar timestamp: " + field);
  }
  if (Date.parse(data.expires_at) <= Date.parse(data.verified_at))
    throw new ConfigError("Publication receipt expires_at must follow verified_at");
  return data;
}

// A digest of the complete active set, including an empty collection. The
// publisher uses the same canonical JSON; ordering in YAML has no meaning.
export function publication_inventory(manifest, selectedCollections) {
  validate_manifest(manifest, selectedCollections);
  if (manifest.kind !== "catalog" || !selectedCollections.length || new Set(selectedCollections).size !== selectedCollections.length)
    throw new ConfigError("Publication inventory requires a catalog and unique selected collections");
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
    throw new ConfigError("Knowledge path must be a portable relative path without traversal or device names");
  return value;
}

// References are data. Never fetch a URL, execute a URI or read a referenced
// source file while validating the catalog.
function reference_path(value) {
  if (typeof value !== "string" || !value || /[\s\u0000-\u001f\u007f]/u.test(value))
    throw new ConfigError("Invalid material reference");
  if (/^https?:\/\//.test(value)) {
    let uri;
    try { uri = new URL(value); } catch { throw new ConfigError("Invalid material HTTP reference"); }
    if (!uri.hostname || uri.username || uri.password || uri.port === "0" || value.endsWith("#") || value.includes("\\"))
      throw new ConfigError("Invalid material HTTP reference: credentials or malformed URL");
    return null;
  }
  const [file, ...fragment] = value.split("#");
  if (fragment.length > 1 || fragment.length && !fragment[0]) throw new ConfigError("Invalid material reference fragment");
  if (file) portable_path(file);
  else if (!fragment.length) throw new ConfigError("Empty material reference");
  return file;
}

function regular_file(file) {
  let stat;
  try { stat = fs.statSync(file, { bigint: true }); } catch { throw new ConfigError("Knowledge file is missing: " + file); }
  if (!stat.isFile()) throw new ConfigError("Knowledge path must identify a regular file: " + file);
  return stat;
}

export function parse_material(text) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)([\s\S]*)$/.exec(text.replace(/^\uFEFF/, ""));
  if (!match || !match[2].trim()) throw new ConfigError("Knowledge material needs YAML front matter and a nonempty Markdown body");
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
  if (data.kind !== "catalog") throw new ConfigError("A recommendations manifest cannot be used as a published catalog");
  for (const entry of data.materials) inside(path.dirname(file), entry.path);
  return { data, sha256: sha256(bytes) };
}

export function load_manifest(root, relative, selectedCollections = []) {
  const catalog = load_manifest_catalog(root, relative, selectedCollections), data = catalog.data, file = inside(root, relative);
  const corpus = path.dirname(file), files = new Set(), materials = [];
  for (const entry of data.materials) {
    const target = inside(corpus, entry.path), stat = regular_file(target), identity = `${stat.dev}:${stat.ino}`;
    if (files.has(identity)) throw new ConfigError("Manifest material paths resolve to the same file");
    files.add(identity);
    const content = fs.readFileSync(target);
    if (sha256(content) !== entry.sha256) throw new ConfigError("Knowledge material SHA-256 mismatch: " + entry.id);
    const metadata = parse_material(content.toString("utf8"));
    if (metadata.id !== entry.id) throw new ConfigError("Manifest and material id mismatch: " + entry.id);
    if (metadata.kind === "document" ? metadata.status !== "published" : metadata.status === "obsolete")
      throw new ConfigError("Inactive knowledge material in catalog: " + entry.id);
    for (const ref of [metadata.provenance.source, ...(metadata.kind === "api_card" ? [metadata.verification_ref] : [])]) {
      const linked = reference_path(ref);
      if (linked !== null) regular_file(linked ? inside(corpus, linked) : target);
    }
    materials.push({ ...entry, metadata });
  }
  return { ...catalog, materials };
}

export function knowledge_status(profile, config) {
  const { provider, mode = provider === "none" ? "disabled" : null, collections = [], required = false, dependent_actions = [] } = profile?.knowledge || {};
  const transport = config?.mcp?.optional?.openviking;
  const result = { provider, mode, collections: structuredClone(collections), required, dependentActions: structuredClone(dependent_actions),
    transport: { enabled: transport?.enabled === true, endpointConfigured: typeof transport?.url === "string" && Boolean(transport.url) },
    coverage: "not_verified", coverageScope: "selected_collections", apiExistence: "not_determined",
    workflowScope: mode === "kora" ? "all" : "dependent_actions", koraReady: false };
  try {
    check_schema(profile, "project-profile.schema.json");
    check_schema(config, "plugin-settings.schema.json");
    if (transport?.url) validate_openviking_url(transport.url);
  } catch (error) {
    return { ...result, state: "invalid", detail: "Invalid knowledge configuration: " + error.message };
  }
  if (provider === "none") return { ...result, state: transport?.enabled ? "invalid" : "disabled",
    detail: transport?.enabled ? "OpenViking transport is enabled but knowledge.provider is none." : "Knowledge is explicitly disabled; no knowledge coverage is claimed." };
  const configured = transport?.enabled === true && Boolean(transport.url);
  return { ...result, state: configured ? "not_verified" : "not_configured",
    detail: configured ? "Search readiness for the selected collections has not been verified."
      : "OpenViking transport is disabled or its URL is empty; the profile's knowledge requirements remain in force." };
}

// This decision only constrains knowledge dependencies; it grants no authority
// or permission and cannot replace the shared action policy.
export function knowledge_gate(profile, config, action) {
  const knowledge = knowledge_status(profile, config);
  const dependent = knowledge.mode === "kora" || action === "knowledge_search" || knowledge.required && Array.isArray(knowledge.dependentActions) && knowledge.dependentActions.includes(action);
  const blocked = knowledge.state === "invalid" || dependent && knowledge.state !== "ready";
  return { allowed: !blocked, action, dependent, knowledge,
    ...(blocked ? { reason: knowledge.detail } : {}) };
}

export function require_workflow_knowledge(profile, config) {
  const gate = knowledge_gate(profile, config, "workflow");
  if (!gate.allowed) throw new ConfigError("Knowledge workflow blocked: " + gate.reason);
  return gate;
}
