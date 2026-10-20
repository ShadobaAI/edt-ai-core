import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";
import { loadRegistry, select, validateCompliance } from "./selector.mjs";
import { detectMechanisms } from "./detector.mjs";
import { actionPolicy, checkAction, actionRequest } from "./actions.mjs";
import { ledgerItemSchema, selectionSchema, requirementsResultSchema, complianceResultSchema, additionalRequirementsSchema, nonblank, assessmentsSchema, detectionSchema, policyProtocolVersion, validateSchema } from "./schema.mjs";

const modulePath = fileURLToPath(import.meta.url);
const readOnly = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const mechanismInput = {
  mechanisms: { type: "array", items: nonblank },
  classifiedMechanisms: { type: "array", items: nonblank },
  detectedMechanisms: { type: "array", items: nonblank },
  unknownMechanisms: { type: "array", items: nonblank },
};
const schemaRegistry = loadRegistry();
const oneCMechanismInput = Object.fromEntries(
  Object.keys(mechanismInput).map((name) =>
    [name, { type: "array", items: { enum: schemaRegistry.oneC.mechanisms } }]),
);
const yaxunitMechanismInput = Object.fromEntries(
  Object.keys(mechanismInput).map((name) =>
    [name, { type: "array", items: { enum: schemaRegistry.yaxunit.mechanisms } }]),
);
const tools = [
  { name: "get_action_policy", description: "Read the shared action agreement groups and protected-source boundary. No stored authorizations.",
    annotations: readOnly, inputSchema: { type: "object", properties: {}, additionalProperties: false, required: [] } },
  { name: "check_action", description: "Check declared actual effects against caller-supplied evidence of user authorization for the exact same scope. Does not grant consent or replace host approvals.",
    annotations: readOnly, inputSchema: actionRequest },
  { name: "detect_1c_mechanisms", description: "Normalize explicit caller assessments from authorized EDT/index/analyzer evidence. Does not parse source or prove presence/absence. Missing assessments remain unknown.",
    outputSchema: detectionSchema,
    annotations: readOnly, inputSchema: { type: "object", properties: {
      sourceRef: nonblank, assessments: assessmentsSchema,
      format: { const: "compact", description: "compact is the only supported detection response" },
    }, required: ["sourceRef", "assessments"], additionalProperties: false } },
  { name: "select_1c_requirements", description: "Select baseline normative selectors from declared facts and merge additionalRequirements found through v8std code/context retrieval after reading exact text. Additions cannot weaken registry requirements or repair missing registry coverage. Unknown assessments block selection; uncovered mechanisms return unavailable. Does not prove retrieval completeness or applicability.",
    outputSchema: requirementsResultSchema,
    annotations: readOnly, inputSchema: { type: "object", properties: {
      artifact: { enum: ["bsl", "query", "metadata"] }, operation: { enum: ["design", "create", "change", "review"] },
      target: nonblank, ...oneCMechanismInput, detection: detectionSchema, additionalRequirements: additionalRequirementsSchema,
    }, required: ["target", "artifact", "operation", "mechanisms", "detection"], additionalProperties: false } },
  { name: "select_yaxunit_requirements", description: "Select baseline YaXUnit authoring patterns and merge additionalRequirements retrieved from v8std after applicability checks. Run/report return not_applicable without a digest; nonempty authoring additions are rejected in those modes.",
    outputSchema: requirementsResultSchema,
    annotations: readOnly, inputSchema: { type: "object", properties: {
      operation: { enum: ["design", "create", "change", "review", "debug", "migrate", "run", "report"] },
      target: nonblank, ...yaxunitMechanismInput, additionalRequirements: additionalRequirementsSchema,
    }, required: ["target", "operation", "mechanisms"], additionalProperties: false } },
  { name: "validate_compliance", description: "Policy protocol 2.1.0. Check ledger consistency including additional requirements against current target/artifact/operation/sourceRef and explicit phase. Returns ledger_valid or blocked for failed/unverified requirements; neither proves normative truth or authorizes a write. Deviation is allowed only for recommended requirements with a reason.",
    outputSchema: complianceResultSchema,
    annotations: readOnly, inputSchema: { type: "object", properties: {
      phase: { enum: ["proposal", "result"] },
      selection: selectionSchema, ledger: { type: "array", items: ledgerItemSchema },
      current: { type: "object", properties: {
        target: nonblank, sourceRef: nonblank,
        artifact: { enum: ["bsl", "query", "metadata", "yaxunit"] },
        operation: { enum: ["design", "create", "change", "review", "debug", "migrate", "run", "report"] },
        ...mechanismInput, detection: detectionSchema, additionalRequirements: additionalRequirementsSchema,
      }, required: ["target", "sourceRef", "artifact", "operation", "mechanisms"], additionalProperties: false },
    }, required: ["phase", "selection", "ledger", "current"], additionalProperties: false } },
];

export function visibleTools() { return tools; }

export function callTool(name, args, registry = loadRegistry()) {
  const tool = tools.find((item) => item.name === name);
  if (!tool) throw new Error("unknown policy tool");
  try { validateSchema(tool.inputSchema, args); }
  catch (error) { throw new Error(`${name === "validate_compliance" ? `${args?.phase ?? "missing-phase"}: ` : ""}${error.message}`); }
  if (!args || typeof args !== "object" || Array.isArray(args) ||
      Object.keys(args).some((key) => !Object.hasOwn(tool.inputSchema.properties, key)) ||
      tool.inputSchema.required.some((key) => args[key] === undefined)) {
    throw new Error("invalid policy tool arguments");
  }
  let result;
  if (name === "get_action_policy") result = actionPolicy();
  else if (name === "check_action") result = checkAction(args);
  else if (name === "detect_1c_mechanisms") result = detectMechanisms(args);
  else if (name === "select_1c_requirements") result = select("oneC", args, registry);
  else if (name === "select_yaxunit_requirements") result = select("yaxunit", args, registry);
  else result = validateCompliance(args.selection, args.ledger, args.current, registry, args.phase);
  if (tool.outputSchema) validateSchema(tool.outputSchema, result, "tool result");
  return result;
}

function send(message) { process.stdout.write(`${JSON.stringify(message)}\n`); }

function dispatch(message, registry) {
  if (!message || message.jsonrpc !== "2.0" || !message.method || message.id === undefined) return;
  let result;
  if (message.method === "initialize") {
    result = { protocolVersion: message.params?.protocolVersion ?? "2024-11-05", capabilities: { tools: {} },
      serverInfo: { name: "1c-ai-policy-readonly", version: policyProtocolVersion } };
  } else if (message.method === "ping") result = {};
  else if (message.method === "tools/list") result = { tools };
  else if (message.method === "tools/call") {
    try {
      const value = callTool(message.params?.name, message.params?.arguments ?? {}, registry);
      result = { content: [{ type: "text", text: JSON.stringify(value) }], isError: false,
        structuredContent: value };
    } catch (error) {
      result = { content: [{ type: "text", text: error.message }], isError: true };
    }
  } else {
    send({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "method not found" } });
    return;
  }
  send({ jsonrpc: "2.0", id: message.id, result });
}

if (process.argv[1] && path.resolve(process.argv[1]) === modulePath) {
  try {
    const registry = schemaRegistry;
    const lines = readline.createInterface({ input: process.stdin });
    lines.on("line", (line) => {
      try { dispatch(JSON.parse(line), registry); }
      catch (error) { process.stderr.write(`policy-mcp: ${error.message}\n`); }
    });
  } catch (error) {
    process.stderr.write(`policy-mcp: ${error.message}\n`);
    process.exitCode = 1;
  }
}
