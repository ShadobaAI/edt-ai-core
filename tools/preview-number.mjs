// Count push workflow runs, including failures, in run-number order for each
// source version. A rerun retains its original run ID and ordinal.
import { run_sync } from "../scripts/processes.mjs";
import { read_source_manifest, version_key } from "./release_policy.mjs";

export function preview_number(exec = (args) => run_sync(args[0], args.slice(1))) {
  const id = process.env.GITHUB_RUN_ID;
  if (!/^\d+$/.test(id || "")) throw new Error("Missing preview run ID");
  const runs = new Map();
  for (let page = 1; ; page++) {
    const response = JSON.parse(exec(["gh", "api", `repos/ShadobaAI/edt-ai-core/actions/workflows/build-plugin.yml/runs?per_page=100&page=${page}`]));
    if (!Array.isArray(response.workflow_runs)) throw new Error("Invalid workflow runs response");
    for (const run of response.workflow_runs) runs.set(String(run.id), run);
    if (response.workflow_runs.length < 100) break;
  }
  const current = runs.get(id);
  if (!current || current.event !== "push" || current.head_branch !== "develop" || current.head_sha !== process.env.GITHUB_SHA || !Number.isSafeInteger(current.run_number))
    throw new Error("Current develop push run is missing from workflow history");
  const base = read_source_manifest(process.cwd()).version;
  let count = 0;
  for (const run of runs.values()) {
    if (run.event !== "push" || run.head_branch !== "develop" || run.run_number > current.run_number) continue;
    if (!Number.isSafeInteger(run.run_number) || !/^[a-f0-9]{40}$/.test(run.head_sha))
      throw new Error("Invalid develop workflow history");
    const manifest = JSON.parse(exec(["git", "show", `${run.head_sha}:plugin.json`]));
    if (manifest.name !== "1c-ai-core") throw new Error("Unexpected historical plugin identity");
    version_key(manifest.version);
    if (manifest.version === base) count++;
  }
  if (!count) throw new Error("Current source version is missing from workflow history");
  return count;
}
