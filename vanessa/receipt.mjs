import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { redact } from "./mcp.mjs";

export function saveRunReceipt(profile, result) {
  if (!result.feature || !result.featureSha256 || !result.scenario) return null;
  fs.mkdirSync(profile.results, { recursive: true });
  const id = randomUUID();
  const resultsFile = path.join(profile.results, `${id}.results.json`);
  const receiptFile = path.join(profile.results, `${id}.receipt.json`);
  fs.writeFileSync(resultsFile, JSON.stringify(redact(result), null, 2) + "\n", { flag: "wx" });
  const receipt = { schemaVersion: 1, featurePath: result.feature,
    featureSha256: result.featureSha256, scenario: result.scenario,
    startedAt: result.startedAt ?? null, finishedAt: result.finishedAt ?? new Date().toISOString(),
    runtime: result.runtime ?? { vanessa: result.runtimeVersion ?? null, platform: null, mcp: null },
    syntaxStatus: result.status === "completed" ? "passed" : result.reports?.check_syntax ? "checked_see_results" : "not_checked",
    fromBeginning: result.status === "completed", status: "unverified", resultsFile };
  // A completed control chain is not a passing UI-test verdict. Actual result
  // correlation and outcome assessment remain mandatory before acceptance.
  fs.writeFileSync(receiptFile, JSON.stringify(receipt, null, 2) + "\n", { flag: "wx" });
  return receiptFile;
}
