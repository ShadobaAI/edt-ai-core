// Synthetic wire-size benchmark, not a model token or quality benchmark.
import { PolicySession } from "../policy/session.mjs";
import { loadRegistry, select, validateCompliance } from "../policy/selector.mjs";
import { criticalMechanisms, detectMechanisms } from "../policy/detector.mjs";

const registry = loadRegistry(), sourceRef = "synthetic:proposal:hash-a";
const scope = { target: "benchmark/project/CommonModule.Sample.Execute", artifact: "bsl", operation: "change", mechanisms: [] };
const assessments = Object.fromEntries(criticalMechanisms.map(name => [name, { status: "absent", evidence: "Synthetic transition and enclosing contract assessed; no production evidence." }]));
const detectArgs = { sourceRef, assessments, format: "compact" };
const detection = detectMechanisms(detectArgs), selectArgs = { ...scope, detection };
const selection = select("oneC", selectArgs, registry);
const current = { ...scope, sourceRef, detection };
const ledger = [...selection.mandatory, ...selection.recommended].map(selector => ({ selector, selection_digest: selection.digest, target: scope.target, source_ref: sourceRef, status: "unverified", evidence: "Synthetic benchmark only; exact source and normative truth are not assessed." }));
const fullArgs = { phase: "proposal", selection, current, ledger };
const fullResult = validateCompliance(selection, ledger, current, registry, "proposal");
const session = new PolicySession(registry), assessArgs = { ...scope, sourceRef, assessments };
const compact = session.assess(assessArgs);
const refArgs = { phase: "proposal", selectionRef: compact.selectionRef,
  current: { ...scope, sourceRef, detectionRef: compact.detectionRef },
  rows: ledger.map(row => [row.selector, row.status, row.evidence]) };
const compactResult = session.validate(refArgs);
if (JSON.stringify(fullResult) !== JSON.stringify(compactResult)) throw new Error("Benchmark paths disagree");
const size = value => Buffer.byteLength(JSON.stringify(value));
const fullInput = size(detectArgs) + size(selectArgs) + size(fullArgs), compactInput = size(assessArgs) + size(refArgs);
console.log(JSON.stringify({ kind: "synthetic_utf8_json_payloads", modelTokensMeasured: false, sourceOrNormativeQualityMeasured: false,
  full: { calls: 3, inputBytes: fullInput, outputBytes: size(detection)+size(selection)+size(fullResult) },
  compact: { calls: 2, inputBytes: compactInput, outputBytes: size(compact)+size(compactResult) },
  inputBytesSaved: fullInput-compactInput, inputReductionPercent: Number((100*(1-compactInput/fullInput)).toFixed(1)),
  sameAssessmentStatus: compactResult.status }, null, 2));
