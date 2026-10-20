import fs from "node:fs";
import { nonblank, validateSchema } from "./schema.mjs";

const defaults = JSON.parse(fs.readFileSync(new URL("./default.json", import.meta.url), "utf8"));
const effects = { type: "array", items: { enum: defaults.require_explicit_confirmation }, uniqueItems: true };
export const actionRequest = { type: "object", additionalProperties: false,
  properties: { effects, scope: nonblank, authorizations: { type: "array", items: {
    type: "object", additionalProperties: false,
    properties: { effects, scope: nonblank, evidence: nonblank },
    required: ["effects", "scope", "evidence"],
  } } }, required: ["effects", "scope", "authorizations"] };

export function actionPolicy() {
  return { ...defaults, workflow: "skills/1c-routing/references/action-policy.md",
    evidenceLimit: "Authorization evidence is a caller assertion about actual user instructions; this is not proof of user identity or an override of host approvals." };
}

export function checkAction(request) {
  validateSchema(actionRequest, request);
  const granted = new Set(request.authorizations.filter(item => item.scope === request.scope)
    .flatMap(item => item.effects));
  const missing = request.effects.filter(effect => !granted.has(effect));
  return { status: missing.length ? "requires_user_agreement" : "within_declared_scope",
    scope: request.scope, effects: request.effects, missing,
    policyVersion: defaults.version, evidenceLimit: actionPolicy().evidenceLimit };
}
