// Promotion executes only trusted source tooling, never downloaded artifact code.
import fs from "node:fs";
import path from "node:path";
import { run_sync } from "../scripts/processes.mjs";
import { version_key, compare_version } from "./release_policy.mjs";
import { verify } from "./verify-package.mjs";
import { resolve, contained, exists } from "../scripts/project_paths.mjs";
import { argumentsOf, entrypoint, cli } from "../scripts/common.mjs";
export const REPOSITORY = "ShadobaAI/edt-ai-core",
  MARKETPLACE_REPOSITORY = "ShadobaAI/codex-plugins";
export function git_environment(token) {
  const env = {
    ...process.env,
    GIT_TERMINAL_PROMPT: "0",
    GIT_CONFIG_COUNT: token ? "2" : "1",
    GIT_CONFIG_KEY_0: "credential.helper",
    GIT_CONFIG_VALUE_0: "",
  };
  // Per-command HTTP authentication avoids shell credential helpers and never
  // persists either source or marketplace credentials in a clone/config file.
  if (token) {
    env.GIT_CONFIG_KEY_1 = "http.https://github.com/.extraheader";
    env.GIT_CONFIG_VALUE_1 =
      "AUTHORIZATION: basic " +
      Buffer.from("x-access-token:" + token).toString("base64");
  }
  return env;
}
export function run(args, options = {}) {
  return run_sync(args[0], args.slice(1), options);
}
export function validate_run(record) {
  if (
    record.repository?.full_name !== REPOSITORY ||
    record.head_repository?.full_name !== REPOSITORY ||
    record.path !== ".github/workflows/build-plugin.yml" ||
    record.event !== "push" ||
    record.conclusion !== "success"
  )
    throw new Error(
      "Only a successful tagged release build of this repository can be published",
    );
  version_key(record.head_branch);
}
export function validate_build(build, record) {
  if (
    build.profile !== "release" ||
    build.dirty ||
    build.revision !== record.head_sha ||
    build.version !== record.head_branch ||
    String(build.runId) !== String(record.id)
  )
    throw new Error("Artifact does not match the successful release run");
}
export function validate_source_tag(checkout, build, exec = run) {
  exec(["git", "fetch", "--no-tags", "origin", "refs/tags/" + build.version], {
    cwd: checkout,
  });
  if (
    exec(["git", "rev-parse", "FETCH_HEAD^{commit}"], { cwd: checkout }) !==
    build.revision
  )
    throw new Error("Release tag no longer points to the built revision");
  exec(["git", "merge-base", "--is-ancestor", build.revision, "HEAD"], {
    cwd: checkout,
  });
}
export function clone_marketplace(checkout, environment, exec = run) {
  exec(
    [
      "git",
      "clone",
      `https://github.com/${MARKETPLACE_REPOSITORY}.git`,
      checkout,
    ],
    { env: environment },
  );
  const refs = exec(
    ["git", "for-each-ref", "--format=%(refname)", "refs/remotes/origin"],
    { cwd: checkout },
  )
    .split(/\r?\n/)
    .filter(Boolean);
  if (refs.includes("refs/remotes/origin/main"))
    exec(["git", "checkout", "-B", "main", "refs/remotes/origin/main"], {
      cwd: checkout,
    });
  else if (refs.length)
    throw new Error("Marketplace must have a main branch or be empty");
  else
    exec(["git", "symbolic-ref", "HEAD", "refs/heads/main"], { cwd: checkout });
}
export function update_catalog(checkout, payload) {
  const catalog = path.join(checkout, ".agents/plugins/marketplace.json");
  if (!contained(resolve(checkout), resolve(catalog)))
    throw new Error("Unsafe catalog destination");
  const incoming = JSON.parse(
      fs.readFileSync(
        path.join(payload, ".agents/plugins/marketplace.json"),
        "utf8",
      ),
    ),
    current = exists(catalog)
      ? JSON.parse(fs.readFileSync(catalog, "utf8"))
      : {},
    plugins = current.plugins || [],
    names = plugins.map((plugin) => plugin.name);
  if (new Set(names).size !== names.length)
    throw new Error("Duplicate plugin names in marketplace catalog");
  const entry = incoming.plugins[0],
    index = names.indexOf(entry.name);
  if (index >= 0) plugins[index] = entry;
  else plugins.push(entry);
  Object.assign(current, {
    name: incoming.name,
    plugins,
    interface: { ...current.interface, ...incoming.interface },
  });
  fs.mkdirSync(path.dirname(catalog), { recursive: true });
  fs.writeFileSync(catalog, JSON.stringify(current, null, 2) + "\n");
}
export function stage_catalog(checkout, exec = run) {
  exec(
    [
      "git",
      "add",
      "--",
      "plugins/1c-ai-core",
      ".agents/plugins/marketplace.json",
    ],
    { cwd: checkout },
  );
  const tracked = new Set(
    exec(["git", "ls-files", "--", "plugins/1c-ai-core"], {
      cwd: checkout,
    }).split(/\r?\n/),
  );
  for (const file of [
    ".codex-plugin/plugin.json",
    "plugin.json",
    "mcp.json",
    "build-info.json",
    "LICENSE",
    "NOTICE.md",
    "SOURCE.md",
    "vendor/deps.mjs",
    "vendor/NOTICE.txt",
    "policy/read-only-mcp.mjs",
    "scripts/lazy_mcp.mjs",
    "mcp/settings.mjs",
    "hooks/guard.mjs",
  ])
    if (!tracked.has("plugins/1c-ai-core/" + file))
      throw new Error("Runtime file was not staged: " + file);
}
export function stage_release(checkout, payload, source, build, exec = run) {
  const previousFile = path.join(
    checkout,
    "plugins/1c-ai-core/build-info.json",
  );
  if (exists(previousFile)) {
    const previous = JSON.parse(fs.readFileSync(previousFile, "utf8"));
    if (
      previous.revision === build.revision &&
      previous.version === build.version
    )
      return false;
    if (compare_version(build.version, previous.version) <= 0)
      throw new Error(
        "Publication cannot replace or roll back an existing version",
      );
    exec(
      ["git", "merge-base", "--is-ancestor", previous.revision, build.revision],
      { cwd: source },
    );
  }
  const target = path.join(checkout, "plugins/1c-ai-core");
  if (
    (exists(target) && fs.lstatSync(target).isSymbolicLink()) ||
    !contained(resolve(checkout), resolve(target))
  )
    throw new Error("Unsafe plugin destination");
  update_catalog(checkout, payload);
  if (exists(target)) fs.rmSync(target, { recursive: true });
  fs.cpSync(path.join(payload, "plugins/1c-ai-core"), target, {
    recursive: true,
    // Force JS traversal: Node 22's native Windows copy mishandles Unicode
    // paths (nodejs/node#61950), including a checkout below a Unicode temp dir.
    filter: () => true,
  });
  stage_catalog(checkout, exec);
  return true;
}
export function push_release(
  checkout,
  payload,
  source,
  build,
  environment,
  exec = run,
) {
  exec(["git", "config", "user.name", "github-actions[bot]"], {
    cwd: checkout,
  });
  exec(
    [
      "git",
      "config",
      "user.email",
      "41898282+github-actions[bot]@users.noreply.github.com",
    ],
    { cwd: checkout },
  );
  for (let attempt = 0; attempt < 3; attempt++) {
    if (!stage_release(checkout, payload, source, build, exec)) return;
    exec(["git", "commit", "-m", "Publish 1c-ai-core " + build.version], {
      cwd: checkout,
    });
    const parents = exec(["git", "rev-list", "--parents", "-n", "1", "HEAD"], {
      cwd: checkout,
    })
      .split(/\s+/)
      .slice(1);
    try {
      exec(["git", "push", "origin", "HEAD:refs/heads/main"], {
        cwd: checkout,
        env: environment,
      });
      return;
    } catch (error) {
      if (attempt === 2) throw error;
      exec(["git", "fetch", "--no-tags", "origin", "refs/heads/main"], {
        cwd: checkout,
        env: environment,
      });
      const latest = exec(["git", "rev-parse", "FETCH_HEAD"], {
        cwd: checkout,
      });
      if (parents.length && latest === parents[0]) throw error;
      if (parents.length)
        exec(["git", "merge-base", "--is-ancestor", parents[0], latest], {
          cwd: checkout,
        });
      // checkout is a dedicated clone created by publish(), never the user's tree.
      exec(["git", "reset", "--hard", latest], { cwd: checkout });
    }
  }
}
export function publish(runId, work, exec = run) {
  if (process.env.GITHUB_REPOSITORY !== REPOSITORY)
    throw new Error("Publication is restricted to " + REPOSITORY);
  if (!/^\d+$/.test(String(runId))) throw new Error("Invalid build run id");
  const record = JSON.parse(
    exec(["gh", "api", `repos/${REPOSITORY}/actions/runs/${runId}`]),
  );
  validate_run(record);
  const token = process.env.MARKETPLACE_TOKEN;
  if (!token)
    throw new Error(
      "MARKETPLACE_TOKEN with Contents write access to " +
        MARKETPLACE_REPOSITORY +
        " is required",
    );
  fs.mkdirSync(work, { recursive: false });
  const download = path.join(work, "download");
  exec([
    "gh",
    "run",
    "download",
    String(runId),
    "--repo",
    REPOSITORY,
    "--name",
    "1c-ai-core-plugin",
    "--dir",
    download,
  ]);
  const payload = path.join(work, "payload"),
    build = verify(download, payload);
  validate_build(build, record);
  const source = path.join(work, "source"),
    sourceEnvironment = git_environment(process.env.GH_TOKEN);
  const sourceExec = (args, options = {}) =>
    exec(args, { ...options, env: options.env || sourceEnvironment });
  sourceExec([
    "git",
    "clone",
    "--single-branch",
    "--branch",
    "main",
    `https://github.com/${REPOSITORY}.git`,
    source,
  ]);
  validate_source_tag(source, build, sourceExec);
  const checkout = path.join(work, "catalog"),
    environment = { ...git_environment(token), GH_TOKEN: token };
  clone_marketplace(checkout, environment, sourceExec);
  push_release(checkout, payload, source, build, environment, sourceExec);
}
if (entrypoint(import.meta.url))
  await cli(() => {
    const a = argumentsOf();
    publish(a.run_id, resolve(a.work));
  });
