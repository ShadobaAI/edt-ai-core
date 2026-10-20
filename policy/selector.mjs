import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { criticalMechanisms, expandDetection } from "./detector.mjs";
import { validateSchema, ledgerItemSchema, selectionSchema, additionalRequirementsSchema, registrySchemaVersion } from "./schema.mjs";

const registryPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "registry.json");
const implications = {
  changed_signature: ["method_contract"],
  method_naming: ["method_contract"],
  database_assertion: ["assertions"],
  persistent_data: ["test_data"],
  new_module: ["module_structure"],
};

function isStringArray(value) {
  return Array.isArray(value) && value.every((item) => typeof item === "string" && item.trim().length > 0);
}

export function loadRegistry(source = registryPath) {
  const registry = JSON.parse(fs.readFileSync(source, "utf8"));
  const registrySchema = JSON.parse(fs.readFileSync(new URL("./registry.schema.json", import.meta.url), "utf8"));
  validateSchema(registrySchema, registry, "registry");
  if (registry.registrySchemaVersion !== registrySchemaVersion || !/^\d{4}-\d{2}-\d{2}\.\d+$/.test(registry.registryVersion)) {
    throw new Error("unsupported policy registry version");
  }
  for (const kind of ["oneC", "yaxunit"]) {
    const group = registry[kind];
    if (!group || !isStringArray(group.operations) || !isStringArray(group.mechanisms) ||
        !Array.isArray(group.rules) || (kind === "oneC" && !isStringArray(group.artifacts))) {
      throw new Error(`incomplete ${kind} registry`);
    }
    const ids = new Set();
    for (const rule of group.rules) {
      if (typeof rule.id !== "string" || ids.has(rule.id) || !["mandatory", "recommended"].includes(rule.strength) || !isStringArray(rule.selectors) ||
          (rule.artifacts && (!isStringArray(rule.artifacts) || rule.artifacts.some((x) => !group.artifacts.includes(x)))) ||
          (rule.operations && (!isStringArray(rule.operations) || rule.operations.some((x) => !group.operations.includes(x)))) ||
          (rule.any && (!isStringArray(rule.any) || rule.any.some((x) => !group.mechanisms.includes(x)))) ||
          (rule.covers && (!isStringArray(rule.covers) || rule.covers.some((x) => !group.mechanisms.includes(x)) || rule.any)) ||
          (kind === "yaxunit" && (!rule.operations || rule.operations.some((x) => !group.authoringOperations.includes(x))))) {
        throw new Error(`invalid ${kind} registry rule ${rule.id}`);
      }
      for (const selector of rule.selectors) {
        if (kind === "yaxunit" ? !/^yaxunit:patterns:[a-z-]+$/.test(selector) :
          !/^(std\d+|v8cs:[a-z-]+|corporate:work:[a-z-]+:overview(?:#[^#]+)?)$/.test(selector)) {
          throw new Error(`invalid exact policy selector ${selector}`);
        }
      }
      ids.add(rule.id);
    }
    if (kind === "yaxunit" && group.authoringOperations.some((x) => !group.operations.includes(x) || ["run", "report"].includes(x))) {
      throw new Error("invalid YaXUnit authoring operations");
    }
    const uncovered = group.mechanisms.filter((name) => !group.rules.some((rule) => (rule.any ?? rule.covers ?? []).includes(name)));
    if (uncovered.length) throw new Error(`registry mechanisms lack coverage: ${uncovered.join(", ")}`);
  }
  return registry;
}

function effectiveMechanisms(group, input) {
  const effective = new Set();
  for (const field of ["mechanisms", "classifiedMechanisms", "detectedMechanisms"]) {
    const values = input[field] ?? [];
    if (!isStringArray(values)) {
      throw new Error(`invalid ${field}`);
    }
    for (const value of values) effective.add(value);
  }
  const unknown = input.unknownMechanisms ?? [];
  if (!Array.isArray(unknown) || unknown.some((x) => typeof x !== "string")) {
    throw new Error("invalid unknownMechanisms");
  }
  if (unknown.length) throw new Error(`mechanism applicability unresolved: ${unknown.join(", ")}`);
  const pending = [...effective];
  for (let index = 0; index < pending.length; index += 1) {
    const value = pending[index];
    if (!group.mechanisms.includes(value)) throw new Error(`unknown required mechanism: ${value}`);
    for (const implied of implications[value] ?? []) {
      if (!group.mechanisms.includes(implied)) throw new Error(`registry lacks implied mechanism ${implied}`);
      if (!effective.has(implied)) { effective.add(implied); pending.push(implied); }
    }
  }
  return [...effective].sort();
}

function ruleMatches(rule, artifact, operation, mechanisms) {
  return (!rule.artifacts || rule.artifacts.includes(artifact)) &&
    (!rule.operations || rule.operations.includes(operation)) &&
    (!rule.any || rule.any.some((item) => mechanisms.includes(item)));
}

function normalizeAdditionalRequirements(value = []) {
  validateSchema(additionalRequirementsSchema, value, "additionalRequirements");
  if (new Set(value.map((item) => item.selector)).size !== value.length) {
    throw new Error("duplicate additional requirement selector");
  }
  return value.map(({ selector, strength, basis }) => ({ selector, strength, basis }))
    .sort((a, b) => a.selector < b.selector ? -1 : a.selector > b.selector ? 1 : 0);
}

export function select(kind, input, registry = loadRegistry()) {
  if (!["oneC", "yaxunit"].includes(kind) || !input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("invalid selection request");
  }
  const allowed = ["target", "artifact", "operation", "mechanisms", "classifiedMechanisms", "detectedMechanisms", "unknownMechanisms", "detection", "additionalRequirements"];
  if (Object.keys(input).some((key) => !allowed.includes(key))) throw new Error("unknown selection property");
  if (typeof input.target !== "string" || !input.target.trim()) throw new Error("selection target required");
  if (kind === "yaxunit" && input.detection !== undefined) throw new Error("1C detection cannot classify YaXUnit mechanisms");
  const group = registry[kind];
  input = { ...input, detection: input.detection === undefined ? undefined : expandDetection(input.detection) };
  if (kind === "oneC") {
    const detection = input.detection;
    if (!detection || typeof detection.sourceRef !== "string" || !detection.sourceRef.trim() ||
        !detection.coverage || !Array.isArray(detection.detectedMechanisms) ||
        !Array.isArray(detection.unknownMechanisms) ||
        criticalMechanisms.some((mechanism) => !["present", "absent"].includes(detection.coverage[mechanism]?.status) ||
          typeof detection.coverage[mechanism]?.evidence !== "string" || !detection.coverage[mechanism].evidence.trim()) ||
        detection.unknownMechanisms.length ||
        new Set(detection.detectedMechanisms).size !== detection.detectedMechanisms.length ||
        criticalMechanisms.some((mechanism) =>
          (detection.coverage[mechanism].status === "present") !== detection.detectedMechanisms.includes(mechanism))) {
      throw new Error("incomplete or contradictory mechanism detection");
    }
    const claimed = [...(input.mechanisms ?? []), ...(input.classifiedMechanisms ?? []),
      ...(input.detectedMechanisms ?? [])];
    if (claimed.some((mechanism) => criticalMechanisms.includes(mechanism) &&
        detection.coverage[mechanism].status === "absent")) {
      throw new Error("explicit mechanism contradicts detection absence");
    }
  }
  const artifact = kind === "oneC" ? input.artifact : "yaxunit";
  if (kind === "oneC" && !group.artifacts.includes(artifact)) throw new Error(`unknown artifact: ${artifact}`);
  if (artifact === "query" && input.detection.coverage.query_text.status !== "present") {
    throw new Error("query artifact requires query_text presence evidence");
  }
  if (!group.operations.includes(input.operation)) throw new Error(`unknown operation: ${input.operation}`);
  const runtimeOnly = kind === "yaxunit" && ["run", "report"].includes(input.operation);
  const additionalRequirements = normalizeAdditionalRequirements(input.additionalRequirements);
  if (runtimeOnly && additionalRequirements.length) throw new Error("runtime-only operation cannot select authoring requirements");
  const mechanisms = effectiveMechanisms(group, { ...input,
    unknownMechanisms: runtimeOnly ? [] : input.unknownMechanisms,
    detectedMechanisms: [...(input.detectedMechanisms ?? []), ...(input.detection?.detectedMechanisms ?? [])] });
  if (kind === "oneC" && mechanisms.some((mechanism) =>
    criticalMechanisms.includes(mechanism) && input.detection.coverage[mechanism].status === "absent")) {
    throw new Error("effective mechanism contradicts detection absence");
  }
  const context = { registrySchemaVersion: registry.registrySchemaVersion, registryVersion: registry.registryVersion,
    kind, target: input.target, artifact, operation: input.operation, mechanisms };
  if (runtimeOnly) return { status: "not_applicable", reason: "authoring_not_requested", ...context };
  const rows = group.rules.filter((rule) => ruleMatches(rule, artifact, input.operation, mechanisms));
  const uncoveredMechanisms = mechanisms.filter((name) => !rows.some((rule) => (rule.any ?? rule.covers ?? []).includes(name)));
  if (rows.length === 0 || uncoveredMechanisms.length) {
    return {
      status: "unavailable", reason: "registry_coverage_missing",
      ...context, uncoveredMechanisms,
      ...(kind === "oneC" ? { detectionSourceRef: input.detection.sourceRef } : {}),
    };
  }
  const mandatory = [...new Set([
    ...rows.filter((rule) => rule.strength === "mandatory").flatMap((rule) => rule.selectors),
    ...additionalRequirements.filter((item) => item.strength === "mandatory").map((item) => item.selector),
  ])].sort();
  const recommended = [...new Set([
    ...rows.filter((rule) => rule.strength === "recommended").flatMap((rule) => rule.selectors),
    ...additionalRequirements.filter((item) => item.strength === "recommended").map((item) => item.selector),
  ])]
    .filter((selector) => !mandatory.includes(selector)).sort();
  if (mandatory.length + recommended.length === 0) {
    throw new Error("policy selection is empty; resolve uncovered mechanism");
  }
  // Omit empty additions to preserve protocol 2.0 selections/digests.
  const canonical = { ...context, mandatory, recommended,
    ...(additionalRequirements.length ? { additionalRequirements } : {}) };
  const digest = crypto.createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
  return { ...canonical, digest, matchedRows: rows.map((rule) => rule.id),
    ...(kind === "oneC" ? { detectionSourceRef: input.detection.sourceRef } : {}) };
}

export function validateCompliance(selection, ledger, current = {}, registry = loadRegistry(), phase) {
  try {
    if (!["proposal", "result"].includes(phase)) throw new Error("invalid compliance phase");
    if ((selection?.operation === "design" && phase !== "proposal") ||
        (selection?.operation === "review" && phase !== "result")) throw new Error("phase does not match design/review operation");
    return { ...checkCompliance(selection, ledger, current, registry), phase };
  } catch (error) { throw new Error(`${phase}: ${error.message}`); }
}

function checkCompliance(selection, ledger, current, registry) {
  validateSchema(selectionSchema, selection, "selection");
  if (!Array.isArray(ledger)) throw new Error("invalid compliance request");
  if (!current || typeof current !== "object" || Array.isArray(current) || Object.keys(current).some((key) => !["target", "artifact", "operation", "sourceRef", "mechanisms", "classifiedMechanisms", "detectedMechanisms", "unknownMechanisms", "detection", "additionalRequirements"].includes(key))) throw new Error("invalid current applicability");
  for (const key of ["target", "artifact", "operation"]) {
    if (current[key] !== selection[key]) throw new Error(`current ${key} differs from selection; reselect requirements`);
  }
  if (typeof current.sourceRef !== "string" || !current.sourceRef.trim()) throw new Error("current sourceRef required");
  if (selection.kind === "yaxunit" && selection.artifact !== "yaxunit") throw new Error("artifact mismatch");
  if (selection.registryVersion !== registry.registryVersion || selection.registrySchemaVersion !== registry.registrySchemaVersion) {
    throw new Error("stale policy registry selection");
  }
  if (selection.kind === "oneC" && !current.detection) throw new Error("current mechanism detection required");
  if (selection.kind === "oneC" && current.detection.sourceRef !== current.sourceRef) throw new Error("current sourceRef differs from detection");
  if (!Object.hasOwn(current, "mechanisms")) throw new Error("current mechanisms required");
  const fresh = select(selection.kind, {
    target: current.target, artifact: current.artifact, operation: current.operation,
    mechanisms: current.mechanisms,
    classifiedMechanisms: current.classifiedMechanisms,
    detectedMechanisms: current.detectedMechanisms,
    unknownMechanisms: current.unknownMechanisms,
    detection: current.detection,
    additionalRequirements: current.additionalRequirements,
  }, registry);
  const boundFields = ["registrySchemaVersion", "registryVersion", "kind", "target", "artifact",
    "operation", "mechanisms", "mandatory", "recommended", "digest", "matchedRows", "additionalRequirements"];
  const boundValue = (value, key) => key === "additionalRequirements" ? value[key] ?? [] : value[key];
  if (boundFields.some((key) => JSON.stringify(boundValue(fresh, key)) !== JSON.stringify(boundValue(selection, key)))) {
    throw new Error("selection digest mismatch or changed mechanisms/additional requirements; reselect requirements");
  }
  const bySelector = new Map();
  for (const entry of ledger) {
    validateSchema(ledgerItemSchema, entry, "ledger item");
    if (bySelector.has(entry.selector) || entry.selection_digest !== selection.digest) {
      throw new Error("invalid or duplicate compliance ledger entry");
    }
    if (entry.target !== current.target || entry.source_ref !== current.sourceRef) {
      throw new Error("ledger target/source_ref differs from current evidence");
    }
    bySelector.set(entry.selector, entry);
  }
  const missing = [...selection.mandatory, ...selection.recommended].filter((id) => !bySelector.has(id));
  const extra = [...bySelector.keys()].filter((id) => !selection.mandatory.includes(id) && !selection.recommended.includes(id));
  if (missing.length || extra.length) throw new Error(`compliance ledger coverage mismatch: missing=${missing.join(",")} extra=${extra.join(",")}`);
  if (selection.mandatory.some((id) => bySelector.get(id).status === "deviated")) throw new Error("mandatory requirements cannot be deviated");
  const unresolved = ledger.filter((entry) => ["failed", "unverified"].includes(entry.status)).map((entry) => ({
    selector: entry.selector, strength: selection.mandatory.includes(entry.selector) ? "mandatory" : "recommended", status: entry.status,
  }));
  return { status: unresolved.length ? "blocked" : "ledger_valid", digest: selection.digest,
    target: current.target, sourceRef: current.sourceRef,
    counts: { mandatory: selection.mandatory.length, recommended: selection.recommended.length,
      deviations: ledger.filter((entry) => entry.status === "deviated").length }, unresolved,
    evidenceLimit: "Checks consistency of caller assertions only; does not verify source, normative text, user identity or readiness for mutation." };
}
