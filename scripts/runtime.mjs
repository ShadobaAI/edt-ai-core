import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import {
  ROOT,
  ConfigError,
  atomic_write,
  cli,
  inside,
  operation_lock,
  settings,
  state_path,
  sleep,
  entrypoint,
  argumentsOf,
  stable,
} from "./common.mjs";
import {
  exists,
  is_file,
  is_dir,
  resolve,
  sha256,
  locate_project,
} from "./project_paths.mjs";
import { project_profile } from "./profile.mjs";
import { effective_settings } from "./project_context.mjs";
import { launch, alive, which, run_sync } from "./processes.mjs";
import { extract_binary, zip_entries } from "./archives.mjs";
import { McpClient } from "./mcp_client.mjs";
import { all_pages } from "./mcp_pages.mjs";
import { casefold } from "./casefold.mjs";
import { spawn_detached_windows } from "./windows_process.mjs";

export const SPECS = {
  "code-index": "Regsorm/code-index-mcp",
  "bsl-ls": "1c-syntax/bsl-language-server",
};
export function platform_build(
  platform = process.platform,
  arch = process.arch,
) {
  const builds = {
    "win32-x64": ["bsl-indexer-windows-x64.zip", "bsl-indexer.exe", "zip"],
    "linux-x64": ["bsl-indexer-linux-x64.tar.gz", "bsl-indexer", "tar.gz"],
    "darwin-arm64": ["bsl-indexer-macos-arm64.tar.gz", "bsl-indexer", "tar.gz"],
  };
  const build = builds[platform + "-" + arch];
  if (!build)
    throw new ConfigError(
      `Unsupported code-index platform: ${platform}/${arch}. Available builds: Windows x64, Linux x64, macOS arm64.`,
    );
  return { asset: build[0], executable: build[1], format: build[2] };
}
export const read_json = (file, fallback = null) =>
  is_file(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : fallback;
export const save_json = (file, value) =>
  atomic_write(file, JSON.stringify(value, null, 2) + "\n");
export const sha = (file) => sha256(fs.readFileSync(file));
export async function fetch_json(url, timeout = 30000) {
  const response = await fetch(url, {
    headers: { "User-Agent": "1c-ai-core/0.2.1" },
    signal: AbortSignal.timeout(timeout),
    redirect: "error",
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${url}`);
  return response.json();
}
export function artifact(state, component) {
  const entry = read_json(path.join(state, "runtime-lock.json"), {})[component];
  if (!entry) return null;
  if (
    !/^v?\d+\.\d+\.\d+$/.test(entry.release || "") ||
    !/^[0-9a-f]{64}$/.test(entry.sha256 || "")
  )
    throw new ConfigError("Invalid runtime-lock entry");
  const executable =
    component === "code-index"
      ? platform_build().executable
      : "bsl-language-server-exec.jar";
  if (
    entry.platform &&
    entry.platform !== process.platform + "-" + process.arch
  )
    return null;
  const home = path.join(state, "runtime", component, entry.release),
    legacy = resolve(path.join(home, executable));
  const target = entry.path ? inside(state, entry.path) : legacy;
  if (
    ![legacy, resolve(path.join(home, entry.sha256, executable))].includes(
      resolve(target),
    )
  )
    throw new ConfigError("Invalid runtime-lock artifact path");
  return is_file(target) && sha(target) === entry.sha256 ? target : null;
}
export async function ensure_installed(
  state,
  config,
  component,
  refresh = false,
  io = { fetch_json, fetch },
) {
  if (!Object.hasOwn(SPECS, component))
    throw new ConfigError("Unknown runtime component");
  const build =
    component === "code-index"
      ? platform_build()
      : { executable: "bsl-language-server-exec.jar" };
  const existing = artifact(state, component),
    requested = config.mcp.managed[component].version,
    current =
      read_json(path.join(state, "runtime-lock.json"), {})[component] || {};
  if (
    existing &&
    !refresh &&
    (requested === "latest" ||
      requested.replace(/^v/, "") === current.release.replace(/^v/, ""))
  )
    return existing;
  const releaseURL =
    requested === "latest" ? "latest" : "tags/v" + requested.replace(/^v/, "");
  const release = await io.fetch_json(
    `https://api.github.com/repos/${SPECS[component]}/releases/${releaseURL}`,
  );
  if (release.draft || release.prerelease)
    throw new ConfigError("Only stable releases are supported");
  const version = release.tag_name;
  if (!/^v?\d+\.\d+\.\d+$/.test(version || ""))
    throw new ConfigError("Unsupported release tag: " + version);
  if (existing && current.release === version && !refresh) return existing;
  const candidates = release.assets.filter((asset) =>
    component === "code-index"
      ? asset.name === build.asset
      : /^bsl-language-server-.*-exec\.jar$/.test(asset.name),
  );
  if (candidates.length !== 1)
    throw new ConfigError(
      `Expected one artifact for ${component}, got ${candidates.length}. Required platform: ${process.platform}/${process.arch}.`,
    );
  const asset = candidates[0],
    digest = asset.digest || "";
  if (!/^sha256:[0-9a-f]{64}$/.test(digest))
    throw new ConfigError(
      `Release ${version} does not publish an SHA-256 asset digest`,
    );
  if (
    !Number.isSafeInteger(asset.size) ||
    asset.size <= 0 ||
    asset.size > 512 * 1024 * 1024
  )
    throw new ConfigError("Invalid runtime asset size");
  const url = new URL(asset.browser_download_url);
  if (
    url.protocol !== "https:" ||
    url.hostname !== "github.com" ||
    !url.pathname.startsWith("/" + SPECS[component] + "/releases/download/")
  )
    throw new ConfigError("Invalid runtime download source");
  process.stderr.write(
    `Installing ${component} ${version}: ${asset.size} bytes\n`,
  );
  const response = await io.fetch(url.href, {
    headers: { "User-Agent": "1c-ai-core/0.2.1" },
    signal: AbortSignal.timeout(60000),
  });
  if (!response.ok) throw new Error("Runtime download HTTP " + response.status);
  const chunks = [];
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > asset.size)
      throw new ConfigError("Artifact size or SHA-256 mismatch: " + component);
    chunks.push(chunk);
  }
  const download = Buffer.concat(chunks);
  if (size !== asset.size || sha256(download) !== digest.slice(7))
    throw new ConfigError("Artifact size or SHA-256 mismatch: " + component);
  let staged;
  if (component === "code-index")
    staged = extract_binary(download, build.format, build.executable);
  else {
    zip_entries(download, 1024 * 1024 * 1024);
    staged = download;
  }
  const contentSHA = sha256(staged);
  const target =
    existing && current.release === version && sha(existing) === contentSHA
      ? existing
      : path.join(
          state,
          "runtime",
          component,
          version,
          contentSHA,
          build.executable,
        );
  if (!is_file(target) || sha(target) !== contentSHA)
    atomic_write(target, staged);
  if (component === "code-index" && process.platform !== "win32")
    fs.chmodSync(target, 0o755);
  const lock = read_json(path.join(state, "runtime-lock.json"), {});
  lock[component] = {
    release: version,
    path: path.relative(resolve(state), resolve(target)),
    sha256: contentSHA,
    asset_sha256: digest.slice(7),
    source: url.href,
    bytes: asset.size,
    ...(component === "code-index"
      ? { platform: process.platform + "-" + process.arch }
      : {}),
  };
  save_json(path.join(state, "runtime-lock.json"), lock);
  return resolve(target);
}
export function project(selected, config) {
  selected ||= process.env.EDT_AI_PROJECT_ROOT || config.active_project;
  if (!selected)
    throw new ConfigError(
      "Set --project-root, EDT_AI_PROJECT_ROOT, or active_project in plugin settings",
    );
  const root = locate_project(selected),
    data = project_profile(root);
  if (!data.repositories.length)
    throw new ConfigError(
      "Configure explicit repositories (id, relative path, alias) in the project profile",
    );
  for (const repo of data.repositories)
    if (!is_dir(inside(root, repo.path)))
      throw new ConfigError(
        "Repository directory does not exist: " + repo.path,
      );
  return [root, data];
}
export function path_key(file) {
  let value = resolve(file);
  if (process.platform === "win32") {
    value = value
      .replace(/^\\\\\?\\UNC\\/, "\\\\")
      .replace(/^\\\\\?\\/, "")
      .toLowerCase();
  }
  return value;
}
export const project_home = (state, root) =>
  path.join(state, "projects", sha256(casefold(path_key(root))).slice(0, 16));
export const installed_runtime = (state, config, component, refresh = false) =>
  operation_lock(
    state,
    () => ensure_installed(state, config, component, refresh),
    120,
  );
export function index_config(home, root, data, health = null) {
  let text = "[daemon]\nhttp_port = 0\nmax_concurrent_initial = 1\n";
  for (const repo of data.repositories)
    text +=
      "\n[[paths]]\nalias = " +
      JSON.stringify(repo.alias) +
      "\npath = " +
      JSON.stringify(inside(root, repo.path).replaceAll("\\", "/")) +
      '\nlanguage = "bsl"\n';
  const file = path.join(home, "daemon.toml");
  if (exists(file) && fs.readFileSync(file, "utf8") === text) return;
  if (exists(file) && health)
    throw new ConfigError(
      "Repository mapping changed: stop this project's daemon before applying it",
    );
  atomic_write(file, text);
}
export async function daemon_health(home) {
  const info = read_json(path.join(home, "daemon.json"), {}),
    port = info.http_port;
  if (!Number.isInteger(port) || port <= 0 || port > 65535) return null;
  try {
    const response = await fetch_json(`http://127.0.0.1:${port}/health`, 2000);
    if (response.pid === info.pid && response.status === "running")
      return response;
  } catch {}
  return null;
}
const pathsMatch = (health, root, data) =>
  stable(
    [
      ...new Set(
        data.repositories.map((repo) => path_key(inside(root, repo.path))),
      ),
    ].sort(),
  ) ===
  stable(
    [
      ...new Set(
        (health?.paths || [])
          .filter((item) => item?.path)
          .map((item) => path_key(item.path)),
      ),
    ].sort(),
  );
export async function start_daemon(
  home,
  root,
  data,
  exe,
  io = {
    launch: process.platform === "win32" ? spawn_detached_windows : launch,
  },
) {
  const health = await daemon_health(home);
  index_config(home, root, data, health);
  if (health) {
    const owner = read_json(path.join(home, "owner.json"), {});
    if (owner.executable !== exe)
      throw new ConfigError(
        "The project daemon runs a different runtime; stop it before changing versions",
      );
    if (
      !owner.project_root ||
      path_key(owner.project_root) !== path_key(root) ||
      owner.pid !== health.pid
    )
      throw new ConfigError(
        "Project daemon ownership mismatch; refusing to reuse it",
      );
    if (!pathsMatch(health, root, data))
      throw new ConfigError(
        "Project daemon repository paths do not match the selected profile",
      );
    return home;
  }
  const stale = read_json(path.join(home, "daemon.json"), {}),
    owner = read_json(path.join(home, "owner.json"), {});
  if (alive(stale.pid) || alive(owner.pid))
    throw new ConfigError(
      "Existing project daemon is alive but unhealthy; inspect its logs before restart",
    );
  const out = fs.openSync(path.join(home, "stdout.log"), "a"),
    err = fs.openSync(path.join(home, "stderr.log"), "a");
  let proc;
  try {
    proc = io.launch(exe, ["daemon", "run"], {
      cwd: home,
      env: {
        ...process.env,
        CODE_INDEX_HOME: home,
        CODE_INDEX_DAEMON_DETACHED: "1",
      },
      detached: true,
      stdio: ["ignore", out, err],
      stdoutFile: path.join(home, "stdout.log"),
      stderrFile: path.join(home, "stderr.log"),
    });
  } finally {
    fs.closeSync(out);
    fs.closeSync(err);
  }
  try {
    let launchError;
    proc.once("error", (error) => {
      launchError = error;
    });
    proc.unref();
    if (!proc.pid) {
      await sleep(10);
      throw launchError || new Error("code-index failed to launch");
    }
    save_json(path.join(home, "owner.json"), {
      pid: proc.pid,
      executable: exe,
      project_root: root,
    });
    const deadline = Date.now() + 40000;
    while (Date.now() < deadline) {
      const ready = await daemon_health(home);
      if (ready?.pid === proc.pid && pathsMatch(ready, root, data)) return home;
      if (launchError || proc.exitCode !== null || proc.signalCode !== null)
        throw new ConfigError(
          `code-index daemon exited (${proc.exitCode}); see ${path.join(home, "stderr.log")}`,
        );
      await sleep(250);
    }
    throw new ConfigError(
      `code-index startup timed out; inspect ${home} before retrying`,
    );
  } finally {
    proc.release?.();
  }
}
export async function ensure_daemon(state, root, data, exe, io) {
  const home = path.join(project_home(state, root), "code-index");
  return operation_lock(
    home,
    () => start_daemon(home, root, data, exe, io),
    45,
  );
}
export function java_command(config) {
  const java = which(config.mcp.managed["bsl-ls"].java || "java");
  if (!java)
    throw new ConfigError(
      "Java is required; set mcp.managed.bsl-ls.java in plugin settings",
    );
  const version = spawnSync(java, ["-version"], {
    encoding: "utf8",
    windowsHide: true,
    shell: false,
    timeout: 20000,
  });
  const match = /version "(\d+)/.exec(
    (version.stderr || "") + (version.stdout || ""),
  );
  if (version.error || version.status !== 0 || !match || Number(match[1]) < 25)
    throw new ConfigError("BSL LS requires Java 25 or newer");
  return java;
}
export async function launch_command(
  state,
  config,
  component,
  root,
  data,
  refresh = false,
) {
  if (component === "code-index") {
    const exe = await installed_runtime(state, config, component, refresh),
      home = await ensure_daemon(state, root, data, exe);
    return [
      [exe, "serve", "--config", path.join(home, "daemon.toml")],
      home,
      { ...process.env, CODE_INDEX_HOME: home },
    ];
  }
  const bsl = config.mcp.managed["bsl-ls"],
    node = which(bsl.node || process.execPath);
  if (!node)
    throw new ConfigError(
      "Node.js 22+ is required for the scoped BSL LS MCP adapter",
    );
  let configuration = bsl.configuration;
  if (configuration) {
    configuration = path.isAbsolute(configuration)
      ? configuration
      : inside(root, configuration);
    if (!is_file(configuration))
      throw new ConfigError("Configured BSL LS configuration does not exist");
  }
  const java = java_command(config),
    exe = await installed_runtime(state, config, component, refresh);
  return [
    [
      node,
      path.join(ROOT, "mcp/bsl-ls-proxy.mjs"),
      "--project-root",
      resolve(root),
      "--java",
      java,
      "--jar",
      exe,
      ...(configuration ? ["--configuration", resolve(configuration)] : []),
    ],
    resolve(root),
    null,
  ];
}
export function validate_bsl_tools(tools) {
  const required = [
      "register_workspace_folder",
      "list_workspace_folders",
      "unregister_workspace_folder",
    ],
    missing = required.filter(
      (name) => !tools.some((tool) => tool.name === name),
    );
  if (
    !tools.some(
      (tool) =>
        !required.includes(tool.name) &&
        tool.inputSchema?.properties?.workspaceFolder?.type === "string" &&
        tool.inputSchema?.required?.includes("workspaceFolder"),
    )
  )
    missing.push("workspaceFolder-aware analyzer tool");
  if (missing.length)
    throw new ConfigError(
      "BSL LS lacks the native multi-workspace API: " +
        missing.join(", ") +
        ". Use a BSL LS artifact exposing workspace registration and workspaceFolder parameters.",
    );
}
export function index_readiness(body, root, data) {
  if (
    !body?.mcp ||
    !body?.daemon ||
    !Array.isArray(body.repos) ||
    body.repos.length !== data.repositories.length
  )
    return false;
  const expected = new Map(
      data.repositories.map((repo) => [
        repo.alias,
        path_key(inside(root, repo.path)),
      ]),
    ),
    seen = new Set();
  for (const repo of body.repos) {
    if (
      !repo ||
      typeof repo.repo !== "string" ||
      !expected.has(repo.repo) ||
      seen.has(repo.repo) ||
      typeof repo.root_path !== "string" ||
      !repo.root_path ||
      path_key(repo.root_path) !== expected.get(repo.repo) ||
      repo.path_status?.status !== "ready" ||
      repo.path_status.error ||
      repo.data_version?.stale !== false
    )
      return false;
    if (
      repo.path_status.path &&
      path_key(repo.path_status.path) !== expected.get(repo.repo)
    )
      return false;
    seen.add(repo.repo);
  }
  return (
    seen.size === expected.size &&
    body.mcp.status === "ok" &&
    body.daemon.status === "online"
  );
}
export async function smoke(
  state,
  config,
  root,
  data,
  component,
  timeout = 90,
  refresh = false,
) {
  const [command, cwd, env] = await launch_command(
      state,
      config,
      component,
      root,
      data,
      refresh,
    ),
    client = new McpClient(command, cwd, env, timeout);
  try {
    const server = await client.initialize(),
      tools = (await all_pages(client, "tools/list", "tools")).tools;
    if (!tools.length)
      throw new ConfigError(component + " exposes no MCP tools");
    if (component === "bsl-ls") validate_bsl_tools(tools);
    const result = {
      component,
      status: "mcp_ready",
      server: server.serverInfo,
      tools: tools.map((tool) => tool.name),
    };
    if (component === "code-index") {
      const health = await client.call("health", {});
      result.index_ready = index_readiness(
        JSON.parse(health.content.find((part) => part.type === "text").text),
        root,
        data,
      );
      result.readiness_scope =
        "Reported repository paths and data freshness; check operation-specific coverage in each response";
    }
    return result;
  } finally {
    await client.close();
  }
}
export async function stop_daemon(state, root) {
  const home = path.join(project_home(state, root), "code-index");
  await operation_lock(
    home,
    async () => {
      const owner = read_json(path.join(home, "owner.json"), {}),
        health = await daemon_health(home);
      if (!health) {
        if (
          alive(owner.pid) ||
          alive(read_json(path.join(home, "daemon.json"), {}).pid)
        )
          throw new ConfigError(
            "Existing daemon is unhealthy; stop is not confirmed",
          );
        return;
      }
      if (
        health.pid !== owner.pid ||
        !owner.project_root ||
        path_key(owner.project_root) !== path_key(root) ||
        owner.executable !== artifact(state, "code-index")
      )
        throw new ConfigError("Daemon ownership mismatch; refusing to stop it");
      run_sync(owner.executable, ["daemon", "stop"], {
        cwd: home,
        env: { ...process.env, CODE_INDEX_HOME: home },
        timeout: 20000,
      });
      for (let i = 0; i < 40; i++) {
        if (!(await daemon_health(home))) return;
        await sleep(250);
      }
      throw new ConfigError("Daemon stop is not confirmed");
    },
    45,
  );
}
export async function main() {
  const a = argumentsOf(
      undefined,
      ["refresh"],
      ["state_dir", "settings", "project_root", "output"],
    ),
    [action, component = "all"] = a._,
    config = settings(a.settings),
    state = state_path(config, a.state_dir),
    components = component === "all" ? Object.keys(SPECS) : [component];
  if (
    !["install", "status", "start", "stop", "smoke", "config"].includes(
      action,
    ) ||
    components.some((name) => !Object.hasOwn(SPECS, name))
  )
    throw new ConfigError("Unknown runtime action/component");
  let result;
  if (action === "install")
    result = await operation_lock(state, async () => {
      const result = {};
      for (const c of components)
        result[c] = await ensure_installed(state, config, c, a.refresh);
      return result;
    });
  else if (action === "status") {
    result = {
      artifacts: Object.fromEntries(
        components.map((c) => [c, artifact(state, c)]),
      ),
      runtime_lock: read_json(path.join(state, "runtime-lock.json"), {}),
    };
    if (a.project_root)
      result.daemon = await daemon_health(
        path.join(project_home(state, a.project_root), "code-index"),
      );
  } else {
    const [root, data] = project(a.project_root, config),
      effective = effective_settings(config, root, data, null, state);
    if (action === "smoke") {
      result = [];
      for (const c of components)
        result.push(await smoke(state, effective, root, data, c));
    } else if (action === "stop") {
      if (component === "bsl-ls")
        throw new ConfigError(
          "BSL LS is owned by its stdio client and stops on disconnect",
        );
      await stop_daemon(state, root);
      result = { status: "stopped", project_root: root };
    } else if (action === "start") {
      if (component === "all") throw new ConfigError("Select a component");
      if (component === "bsl-ls")
        return (await import("./managed_mcp.mjs")).serve(
          component,
          root,
          state,
          effective,
        );
      const exe = await installed_runtime(state, effective, component),
        home = await ensure_daemon(state, root, data, exe);
      result = { status: "running", daemon: await daemon_health(home) };
    } else {
      if (!a.output) throw new ConfigError("config requires --output");
      const servers = {
        policy: (await import("./policy_runtime.mjs")).binding(effective),
      };
      for (const c of Object.keys(SPECS))
        servers[c] = {
          type: "stdio",
          command: process.execPath,
          args: [
            path.join(ROOT, "scripts/managed_mcp.mjs"),
            "--component",
            c,
            "--project-root",
            root,
            "--state-dir",
            state,
            ...(a.settings ? ["--settings", resolve(a.settings)] : []),
          ],
        };
      for (const [c, item] of Object.entries(effective.mcp.required)) {
        if (!item.url)
          throw new ConfigError("Configure user-started MCP URL: " + c);
        servers[c] = { type: "streamable-http", url: item.url };
      }
      save_json(a.output, {
        $schema: "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json",
        mcpServers: servers,
      });
      result = { status: "written", path: resolve(a.output) };
    }
  }
  console.log(JSON.stringify(result, null, 2));
}
if (entrypoint(import.meta.url)) await cli(main);
