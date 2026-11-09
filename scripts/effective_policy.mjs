import path from "node:path";
import { ROOT, ConfigError, load } from "./common.mjs";

export function effective_policy(overlay = {}) {
  const defaults = load(path.join(ROOT, "policy/default.json"));
  if (
    overlay.allow_shell_source_read !== undefined &&
    overlay.allow_shell_source_read !== false
  )
    throw new ConfigError(
      "Политика проекта не может разрешать доступ к защищённым исходникам через shell",
    );
  const required = defaults.require_explicit_confirmation;
  if (
    overlay.require_explicit_confirmation &&
    required.some(
      (value) => !overlay.require_explicit_confirmation.includes(value),
    )
  )
    throw new ConfigError(
      "Политика проекта не может удалять общие категории разрешений",
    );
  return {
    ...defaults,
    ...overlay,
    require_explicit_confirmation: required,
    workflow: "skills/1c-routing/references/action-policy.md",
  };
}
