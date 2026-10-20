// Shared JSON Schema and runtime checks. Only keywords used below are supported;
// do not treat this small validator as a general JSON Schema implementation.
import { criticalMechanisms } from "./detector.mjs";
export const policyProtocolVersion = "2.1.0";
export const registrySchemaVersion = 2;
export const nonblank = { type: "string", minLength: 1, pattern: "\\S" };
// Exact normative references selected after reading v8std text, not search scores
// or arbitrary diagnostic IDs. Their truth/applicability remains caller evidence.
export const additionalRequirementsSchema = { type: "array", items: {
  type: "object", additionalProperties: false,
  properties: {
    selector: { type: "string", pattern: "^(std[0-9]+|corporate:work:[a-z-]+:overview|(?:yaxunit|vanessa):patterns:[a-z-]+)(?:#[^#\\r\\n]+)?$" },
    strength: { enum: ["mandatory", "recommended"] }, basis: nonblank,
  }, required: ["selector", "strength", "basis"],
} };
export const assessmentSchema = { type: "object", additionalProperties: false,
  properties: { status: { enum: ["present", "absent", "unknown"] }, evidence: nonblank },
  required: ["status", "evidence"] };
export const assessmentsSchema = { type: "object",
  propertyNames: { enum: criticalMechanisms }, additionalProperties: assessmentSchema };
export const detectionSchema = { type: "object", additionalProperties: false,
    properties: { format: { const: "compact-v1" }, sourceRef: nonblank,
      coverage: { type: "array", minItems: criticalMechanisms.length, maxItems: criticalMechanisms.length,
        items: { type: "array", minItems: 3, maxItems: 3,
          prefixItems: [{ enum: criticalMechanisms }, { enum: ["present", "absent", "unknown"] }, nonblank] } } },
    required: ["format", "sourceRef", "coverage"] };
export const ledgerItemSchema = {
  type: "object", additionalProperties: false,
  properties: {
    selector: nonblank, selection_digest: nonblank, target: nonblank, source_ref: nonblank,
    status: { enum: ["passed", "failed", "unverified", "deviated"] }, evidence: nonblank, reason: nonblank,
  },
  required: ["selector", "selection_digest", "target", "source_ref", "status", "evidence"],
  if: { properties: { status: { const: "deviated" } }, required: ["status"] },
  then: { required: ["reason"] },
};

export const selectionSchema = { type: "object", additionalProperties: false,
  properties: { registrySchemaVersion: { const: registrySchemaVersion }, registryVersion: nonblank,
    kind: { enum: ["oneC", "yaxunit"] }, target: nonblank,
    artifact: { enum: ["bsl", "query", "metadata", "yaxunit"] },
    operation: { enum: ["design", "create", "change", "review", "debug", "migrate", "run", "report"] },
    mechanisms: { type: "array", items: nonblank }, mandatory: { type: "array", items: nonblank },
    recommended: { type: "array", items: nonblank }, digest: nonblank,
    matchedRows: { type: "array", items: nonblank }, detectionSourceRef: nonblank,
    additionalRequirements: additionalRequirementsSchema },
  required: ["registrySchemaVersion", "registryVersion", "kind", "target", "artifact", "operation", "mechanisms", "mandatory", "recommended", "digest", "matchedRows"],
  if: { properties: { kind: { const: "oneC" } }, required: ["kind"] },
  then: { required: ["detectionSourceRef"] } };

// Neither unavailable coverage nor a runtime-only operation is a compliance selection.
export const requirementsResultSchema = { type: "object", oneOf: [selectionSchema, {
  type: "object", additionalProperties: false,
  properties: {
    status: { const: "unavailable" }, reason: { const: "registry_coverage_missing" },
    registrySchemaVersion: { const: registrySchemaVersion }, registryVersion: nonblank,
    kind: { enum: ["oneC", "yaxunit"] }, target: nonblank,
    artifact: { enum: ["bsl", "query", "metadata", "yaxunit"] },
    operation: { enum: ["design", "create", "change", "review", "debug", "migrate"] },
    mechanisms: { type: "array", items: nonblank }, detectionSourceRef: nonblank,
    uncoveredMechanisms: { type: "array", items: nonblank },
  },
  required: ["status", "reason", "registrySchemaVersion", "registryVersion", "kind", "target", "artifact", "operation", "mechanisms", "uncoveredMechanisms"],
  if: { properties: { kind: { const: "oneC" } }, required: ["kind"] },
  then: { required: ["detectionSourceRef"] },
}, {
  type: "object", additionalProperties: false,
  properties: {
    status: { const: "not_applicable" }, reason: { const: "authoring_not_requested" },
    registrySchemaVersion: { const: registrySchemaVersion }, registryVersion: nonblank,
    kind: { const: "yaxunit" }, target: nonblank, artifact: { const: "yaxunit" },
    operation: { enum: ["run", "report"] }, mechanisms: { type: "array", items: nonblank },
  },
  required: ["status", "reason", "registrySchemaVersion", "registryVersion", "kind", "target", "artifact", "operation", "mechanisms"],
}] };

export const complianceResultSchema = { type: "object", additionalProperties: false,
  properties: {
    status: { enum: ["ledger_valid", "blocked"] }, phase: { enum: ["proposal", "result"] },
    digest: nonblank, target: nonblank, sourceRef: nonblank, evidenceLimit: nonblank,
    counts: { type: "object", additionalProperties: false,
      properties: { mandatory: { type: "number" }, recommended: { type: "number" }, deviations: { type: "number" } },
      required: ["mandatory", "recommended", "deviations"] },
    unresolved: { type: "array", items: { type: "object", additionalProperties: false,
      properties: { selector: nonblank, strength: { enum: ["mandatory", "recommended"] },
        status: { enum: ["failed", "unverified"] } }, required: ["selector", "strength", "status"] } },
  }, required: ["status", "phase", "digest", "target", "sourceRef", "counts", "unresolved", "evidenceLimit"] };

export function validateSchema(schema, value, at = "arguments", root = schema) {
  if (schema.$ref) {
    const resolved = schema.$ref.slice(2).split("/").reduce((node, key) => node[key], root);
    return validateSchema(resolved, value, at, root);
  }
  const fail = (message) => { throw new Error(`${at}: ${message}`); };
  if (schema.oneOf) {
    const matches = schema.oneOf.filter((branch) => {
      try { validateSchema(branch, value, at, root); return true; } catch { return false; }
    });
    if (matches.length !== 1) fail("expected exactly one documented schema variant");
  }
  if (schema.type) {
    const matches = schema.type === "object" ? value !== null && typeof value === "object" && !Array.isArray(value)
      : schema.type === "array" ? Array.isArray(value) : typeof value === schema.type;
    if (!matches) fail(`expected ${schema.type}`);
  }
  if (schema.enum && !schema.enum.includes(value)) fail(`expected one of ${schema.enum.join(", ")}`);
  if (Object.hasOwn(schema, "const") && value !== schema.const) fail(`expected ${schema.const}`);
  if (typeof value === "string") {
    if (schema.minLength && value.length < schema.minLength) fail("empty string");
    if (schema.pattern && !new RegExp(schema.pattern).test(value)) {
      fail(schema.pattern === "\\S" ? "nonblank value required" : "does not match required pattern");
    }
  }
  if (Array.isArray(value) && schema.items) value.forEach((item, i) => validateSchema(schema.items, item, `${at}[${i}]`, root));
  if (Array.isArray(value)) {
    if (schema.uniqueItems && new Set(value.map((x) => JSON.stringify(x))).size !== value.length) fail("duplicate items");
    if (schema.minItems !== undefined && value.length < schema.minItems) fail("too few items");
    if (schema.maxItems !== undefined && value.length > schema.maxItems) fail("too many items");
    (schema.prefixItems ?? []).forEach((item, i) => { if (i < value.length) validateSchema(item, value[i], `${at}[${i}]`, root); });
  }
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    for (const key of schema.required ?? []) if (!Object.hasOwn(value, key)) fail(`missing ${key}`);
    for (const [key, item] of Object.entries(value)) {
      if (schema.propertyNames) validateSchema(schema.propertyNames, key, `${at} property name`, root);
      if (schema.additionalProperties === false && !Object.hasOwn(schema.properties ?? {}, key)) fail(`unknown property ${key}`);
      if (schema.properties?.[key]) validateSchema(schema.properties[key], item, `${at}.${key}`, root);
      else if (schema.additionalProperties && typeof schema.additionalProperties === "object")
        validateSchema(schema.additionalProperties, item, `${at}.${key}`, root);
    }
  }
  if (schema.if) {
    let matches = true;
    try { validateSchema(schema.if, value, at, root); } catch { matches = false; }
    if (matches && schema.then) validateSchema(schema.then, value, at, root);
  }
}
