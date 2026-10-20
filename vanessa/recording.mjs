import fs from "node:fs";
import path from "node:path";
import { readJson, fail } from "./profile.mjs";

const file = profile => path.join(profile.stateDir, "recording.json");
export function ownRecording(profile, managerToken) {
  if (!fs.existsSync(file(profile))) return null;
  const state = readJson(file(profile), 4096);
  if (state.profile !== profile.identity || state.endpoint !== profile.mcp.url) fail("recording state belongs to another profile or endpoint");
  if (state.status === "active" && (!managerToken || state.managerToken !== managerToken)) fail("recording manager session changed; ownership is unverified");
  if (["starting", "indeterminate"].includes(state.status)) fail("recording outcome is indeterminate; inspect authoritative recording state before continuing");
  return state.status === "active" ? state : null;
}
export function recordOwnership(profile, status, runtimeVersion, managerToken) {
  fs.mkdirSync(profile.stateDir, { recursive: true });
  fs.writeFileSync(file(profile), JSON.stringify({ profile: profile.identity, endpoint: profile.mcp.url, managerToken, status, runtimeVersion, observedAt: new Date().toISOString() }));
}
export function invalidateObservedIdle(profile, runtimeVersion) {
  if (!fs.existsSync(file(profile))) return;
  const state = readJson(file(profile), 4096);
  if (state.profile === profile.identity && state.endpoint === profile.mcp.url && state.status === "active") recordOwnership(profile, "idle", runtimeVersion, state.managerToken);
}
