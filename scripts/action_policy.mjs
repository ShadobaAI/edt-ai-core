import { cli, entrypoint, argumentsOf } from "./common.mjs";
import { effective_policy } from "./effective_policy.mjs";
export { effective_policy } from "./effective_policy.mjs";
if (entrypoint(import.meta.url))
  await cli(async () => {
    const a = argumentsOf();
    const policy = a._[0]
      ? (await import("./profile.mjs")).project_profile(a._[0]).policy
      : {};
    console.log(JSON.stringify(effective_policy(policy), null, 2));
  });
