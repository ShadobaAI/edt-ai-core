// Normalize caller assessments from authorized EDT/index/analyzer evidence.
// This module does not parse source or independently establish any mechanism.
export const criticalMechanisms = Object.freeze([
  "query_text", "query_in_loop", "exception_handler", "explicit_transaction",
  "export_contract", "module_variable", "privileged_mode", "full_access_module",
  "universal_container", "client_server_boundary", "changed_signature",
  "query_result_processing", "predefined_values",
  "access_rights", "object_write_handler", "data_migration",
  "metadata_rename", "metadata_delete",
]);

// A compact result retains every assessment and unresolved status. It is not a
// proof token: callers still supply authorized evidence and selection rechecks it.
export function expandDetection(input) {
  if (input?.format !== "compact-v1") throw new Error("compact-v1 detection required");
  if (Object.keys(input).some((key) => !["format", "sourceRef", "coverage"].includes(key)) ||
      !Array.isArray(input.coverage) || input.coverage.length !== criticalMechanisms.length) {
    throw new Error("invalid compact detection");
  }
  const coverage = {};
  for (const row of input.coverage) {
    if (!Array.isArray(row) || row.length !== 3 || !criticalMechanisms.includes(row[0]) ||
        Object.hasOwn(coverage, row[0]) || !["present", "absent", "unknown"].includes(row[1]) ||
        typeof row[2] !== "string" || !row[2].trim()) throw new Error("invalid compact detection assessment");
    coverage[row[0]] = { status: row[1], evidence: row[2] };
  }
  return { sourceRef: input.sourceRef, coverage,
    detectedMechanisms: criticalMechanisms.filter((name) => coverage[name].status === "present"),
    unknownMechanisms: criticalMechanisms.filter((name) => coverage[name].status === "unknown") };
}

export function detectMechanisms(input) {
  if (!input || typeof input !== "object" || Array.isArray(input) ||
      typeof input.sourceRef !== "string" || !input.sourceRef.trim() ||
      Object.keys(input).some((key) => !["sourceRef", "assessments", "format"].includes(key)) ||
      !input.assessments || typeof input.assessments !== "object" || Array.isArray(input.assessments) ||
      (input.format !== undefined && input.format !== "compact")) {
    throw new Error("detector requires a sourceRef and structured assessments");
  }
  const extra = Object.keys(input.assessments).filter((key) => !criticalMechanisms.includes(key));
  if (extra.length) throw new Error(`unknown assessed mechanism: ${extra.join(", ")}`);
  const coverage = {};
  for (const mechanism of criticalMechanisms) {
    const assessment = input.assessments[mechanism];
    if (assessment !== undefined && (!assessment || !["present", "absent", "unknown"].includes(assessment.status) ||
        typeof assessment.evidence !== "string" || !assessment.evidence.trim())) {
      throw new Error(`invalid assessment: ${mechanism}`);
    }
    coverage[mechanism] = { status: assessment?.status ?? "unknown", evidence: assessment?.evidence ?? "not assessed" };
  }
  return { format: "compact-v1", sourceRef: input.sourceRef,
    coverage: criticalMechanisms.map((name) => [name, coverage[name].status, coverage[name].evidence]) };
}
