import path from "node:path";
import { ROOT } from "./common.mjs";
import { McpClient } from "./mcp_client.mjs";
export const binding = (config, root = ROOT) => ({
  type: "stdio",
  command: config.mcp.managed["bsl-ls"].node || process.execPath,
  args: [path.join(root, "policy/read-only-mcp.mjs")],
});
export async function smoke(config, { command, env, timeoutMs } = {}) {
  const entry = binding(config),
    client = new McpClient([command || entry.command, ...entry.args], ROOT, env || null, 15);
  let timer;
  const work = (async () => {
    const server = (await client.initialize()).serverInfo,
      tools = (await client.request("tools/list")).tools;
    const required = [
      "detect_1c_mechanisms",
      "select_1c_requirements",
      "select_yaxunit_requirements",
      "validate_compliance",
      "get_action_policy",
      "check_action",
    ];
    if (
      required.some((name) => !tools.some((tool) => tool.name === name)) ||
      tools.some((tool) => !tool.annotations?.readOnlyHint)
    )
      throw new Error("Контракт встроенных инструментов политики не совпадает");
    const selection = (
      await client.call("select_yaxunit_requirements", {
        target: "policy-readiness-probe",
        operation: "report",
        mechanisms: [],
      })
    ).structuredContent;
    if (
      selection.status !== "not_applicable" ||
      selection.reason !== "authoring_not_requested" ||
      "digest" in selection ||
      selection.operation !== "report"
    )
      throw new Error("Проверка выполнения встроенной политики не удалась");
    const authoring = (
      await client.call("select_yaxunit_requirements", {
        target: "policy-readiness-probe",
        operation: "design",
        mechanisms: [],
      })
    ).structuredContent;
    if (!authoring.digest || !authoring.mandatory?.length)
      throw new Error("Проверка выбора требований встроенной политики не удалась");
    const current = {
      target: authoring.target,
      artifact: "yaxunit",
      operation: "design",
      sourceRef: "synthetic:policy-readiness",
      mechanisms: [],
    };
    const ledger = [...authoring.mandatory, ...authoring.recommended].map(
      (selector) => ({
        selector,
        selection_digest: authoring.digest,
        target: current.target,
        source_ref: current.sourceRef,
        status: "unverified",
        evidence:
          "Synthetic startup probe; normative text and source are not inspected",
      }),
    );
    const assessment = (
      await client.call("validate_compliance", {
        phase: "proposal",
        selection: authoring,
        ledger,
        current,
      })
    ).structuredContent;
    if (
      assessment.status !== "blocked" ||
      assessment.unresolved?.length !== ledger.length
    )
      throw new Error("Отрицательная проверка реестра подтверждений встроенной политики не удалась");
    return {
      component: "policy",
      server,
      live: "ready",
      registry_version: selection.registryVersion,
      evidence: "synthetic_protocol_checks_only",
    };
  })();
  try {
    if (!timeoutMs) return await work;
    const deadline = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("Истекло время проверки политики")), timeoutMs); });
    return await Promise.race([work, deadline]);
  } finally {
    clearTimeout(timer);
    await client.close();
  }
}
