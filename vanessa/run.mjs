import fs from "node:fs";
import path from "node:path";
import { digest, fail } from "./profile.mjs";
import { callTool, checkArguments } from "./mcp.mjs";
import { inspectSession } from "./readiness.mjs";
import { runtimeContract, normalizeFeatureText } from "./runtime-contract.mjs";
import { saveRunReceipt } from "./receipt.mjs";

const normalized = file => process.platform === "win32" ? path.resolve(file).toLowerCase() : path.resolve(file);
export async function runFeature(profile, client, tools, { feature, scenario, beforeOpen, onProgress = () => {} }, contract = runtimeContract) {
  if (typeof feature !== "string" || path.extname(feature).toLowerCase() !== ".feature" || typeof scenario !== "string" || !scenario.trim() || /[\x00-\x1f]/.test(scenario)) fail("run requires --feature and an exact --scenario name");
  const file = fs.realpathSync(path.resolve(profile.projectRoot, feature));
  const roots = [fs.realpathSync(profile.features), fs.realpathSync(profile.projectRoot)];
  const withinScope = roots.some(root => { const relative = path.relative(root, file); return relative !== ".." && !relative.startsWith(".." + path.sep) && !path.isAbsolute(relative); });
  const stat = fs.statSync(file);
  if (path.extname(file).toLowerCase() !== ".feature" || !withinScope || !stat.isFile() || stat.size > 4 * 1024 * 1024) fail("run feature must be a bounded .feature file inside projectRoot or configured features");
  const sourceBytes = fs.readFileSync(file), sourceHash = digest(sourceBytes);
  const sourceText = normalizeFeatureText(sourceBytes.toString("utf8"));
  const required = [
    ["open_feature_file", { filePath: file }], ["load_features", { path: file }], ["check_syntax", { filePath: file }],
    ["select_scenario", { name: scenario }], ["get_editor_state", { includeContent: true }],
    ["run_scenario", { mode: "selected" }], ["get_test_results", {}],
  ];
  // Validate the whole plan before its first mutation against actual tools/list.
  for (const [name, args] of required) {
    const tool = tools.find(item => item.name === name);
    if (!tool) fail(`required workflow tool is unavailable: ${name}`);
    checkArguments(tool.inputSchema, args);
  }
  const baseline = await inspectSession(profile, client, tools, contract);
  if (baseline.status !== "ready") return { status: "error", stage: "readiness", reason: baseline.reason, readiness: baseline };
  const reports = {}, startedAt = new Date().toISOString();
  if (beforeOpen) await beforeOpen();
  const invoke = async (name, args, mutation = false) => {
    let dispatched = false;
    try {
      const result = await callTool(client, tools, name, args, { onDispatch: () => {
        dispatched = true;
        onProgress({ feature: file, featureSha256: sourceHash, scenario, startedAt,
          runtime: baseline.runtime, tool: name, mutation, pending: true, reports });
      } });
      reports[name] = result;
      onProgress({ feature: file, featureSha256: sourceHash, scenario, startedAt,
        runtime: baseline.runtime, tool: name, mutation, pending: false, reports });
      return result;
    } catch (error) {
      if (error.code === "tool_error") { error.detail = { ...error.detail, stage: name, reports }; throw error; }
      if (mutation && dispatched) {
        const uncertain = new Error("Selected workflow mutation outcome is indeterminate; inspect state before retrying");
        uncertain.code = "mutation_indeterminate";
        uncertain.detail = { classification: "transport_or_protocol", outcome: "indeterminate", tool: name, reports, nextAction: uncertain.message };
        throw uncertain;
      }
      throw error;
    }
  };
  await invoke("open_feature_file", { filePath: file }, true);
  await invoke("load_features", { path: file }, true);
  const syntax = contract.syntax?.(await invoke("check_syntax", { filePath: file }));
  if (!syntax || normalized(syntax.file) !== normalized(file) || !syntax.valid || syntax.problemCount !== 0) return { status: "error", stage: "syntax", reason: syntax ? "syntax_invalid_or_wrong_file" : "syntax_response_contract_unverified", reports };
  const selected = await invoke("select_scenario", { name: scenario }, true);
  const editor = await invoke("get_editor_state", { includeContent: true });
  const selection = contract.selection?.(selected, editor);
  if (!selection || normalized(selection.file) !== normalized(file) || selection.scenario !== scenario || selection.occurrences !== 1) return { status: "error", stage: "selection", reason: "selected_scenario_or_file_unverified", reports };
  const content = contract.editorContent?.(editor);
  if (typeof content !== "string" || normalizeFeatureText(content) !== sourceText) return { status: "error", stage: "source", reason: "editor_content_does_not_match_feature_or_is_unverified", reports };
  // This single control chain retains the full baseline through documented editor-only
  // effects. The editor's abbreviated state is never interpreted as idle/connected.
  await invoke("run_scenario", { mode: "selected" }, true);
  await invoke("get_test_results", {});
  if (digest(fs.readFileSync(file)) !== sourceHash) return { status: "error", stage: "source", reason: "feature_changed_during_run", reports };
  const result = { status: "completed", feature: file, scenario, mode: "selected", featureSha256: sourceHash,
    editorEnabled: "verified_by_open_feature_file",
    editorContentSha256: digest(normalizeFeatureText(content)),
    startedAt, finishedAt: new Date().toISOString(), runtimeVersion: baseline.runtimeVersion, runtime: baseline.runtime, reports,
    nextReadiness: "Obtain full state from the manager tree view before another control chain; completed is not a passed-test verdict." };
  return { ...result, receipt: saveRunReceipt(profile, result) };
}
