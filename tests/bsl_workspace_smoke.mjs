// Opt-in native acceptance on synthetic files; never installs a JAR.
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import { ROOT, argumentsOf } from "../scripts/common.mjs";
import { McpClient } from "../scripts/mcp_client.mjs";
import { all_pages } from "../scripts/mcp_pages.mjs";
import { validate_bsl_tools, save_json } from "../scripts/runtime.mjs";
const body = (result) =>
  result.structuredContent ||
  JSON.parse(result.content.find((part) => part.type === "text").text);
export async function run(jar, java = "java", node = process.execPath) {
  const base = fs.realpathSync.native(
      fs.mkdtempSync(path.join(os.tmpdir(), "bsl native ")),
    ),
    clients = [];
  const first = path.join(base, "Проект первый"),
    second = path.join(base, "Проект второй"),
    a = path.join(first, "Конфигурация А"),
    b = path.join(first, "Конфигурация Б"),
    other = path.join(second, "Другая");
  try {
    for (const [folder, mode] of [
      [a, "on"],
      [b, "off"],
      [other, "on"],
    ]) {
      fs.mkdirSync(folder, { recursive: true });
      fs.writeFileSync(
        path.join(folder, ".bsl-language-server.json"),
        JSON.stringify({ diagnostics: { mode } }),
      );
      fs.writeFileSync(path.join(folder, "Модуль.bsl"), "Процедура Ошибка(\n");
    }
    const connect = async (root, configuration) => {
      const client = new McpClient(
        [
          node,
          path.join(ROOT, "mcp/bsl-ls-proxy.mjs"),
          "--project-root",
          root,
          "--java",
          java,
          "--jar",
          path.resolve(jar),
          ...(configuration ? ["--configuration", configuration] : []),
        ],
        root,
        process.env,
        90,
      );
      clients.push(client);
      await client.initialize();
      validate_bsl_tools(
        (await all_pages(client, "tools/list", "tools")).tools,
      );
      return client;
    };
    const one = await connect(first),
      two = await connect(second),
      uriA = body(await one.call("register_workspace_folder", { path: a }))
        .workspaceFolder.uri,
      uriB = body(
        await one.call("register_workspace_folder", {
          path: pathToFileURL(b).href,
        }),
      ).workspaceFolder.uri;
    await two.call("register_workspace_folder", { path: other });
    assert.equal(
      body(await one.call("list_workspace_folders", {})).workspaceFolders
        .length,
      2,
    );
    assert.equal(
      body(await two.call("list_workspace_folders", {})).workspaceFolders
        .length,
      1,
    );
    assert.ok(
      body(await one.call("register_workspace_folder", { path: a }))
        .alreadyRegistered,
    );
    for (const [folder, uri, enabled] of [
      [a, uriA, true],
      [b, uriB, false],
      [a, uriA, true],
    ]) {
      const result = body(
        await one.call("analyze_file", {
          file: pathToFileURL(path.join(folder, "Модуль.bsl")).href,
        }),
      );
      assert.equal(!!result.diagnosticsCount, enabled);
      await one.call("type_info", {
        workspaceFolder: uri,
        typeName: "Массив",
        fileType: "BSL",
      });
    }
    await one.call("unregister_workspace_folder", { workspaceFolder: uriA });
    assert.equal(
      body(await one.call("list_workspace_folders", {})).workspaceFolders
        .length,
      1,
    );
    await one.close();
    await two.call("document_symbols", {
      file: path.join(other, "Модуль.bsl"),
    });
    const explicit = path.join(first, "bsl-language-server.json");
    fs.writeFileSync(explicit, '{"diagnostics":{"mode":"off"}}');
    const three = await connect(first, explicit);
    await three.call("register_workspace_folder", { path: a });
    assert.equal(
      body(
        await three.call("analyze_file", { file: path.join(a, "Модуль.bsl") }),
      ).diagnosticsCount,
      0,
    );
    return {
      status: "passed",
      scope:
        "native_registration_switching_unicode_workspace_and_explicit_configuration_parallel_sessions",
    };
  } finally {
    for (const client of clients) await client.close();
    fs.rmSync(base, { recursive: true, force: true });
  }
}
if (
  process.argv[1] &&
  path.resolve(process.argv[1]) ===
    path.join(ROOT, "tests/bsl_workspace_smoke.mjs")
) {
  const a = argumentsOf();
  let report;
  try {
    report = await run(a.jar, a.java, a.node);
  } catch (error) {
    report = { status: "failed", detail: error.message };
  }
  if (a.output) save_json(a.output, report);
  console.log(JSON.stringify(report, null, 2));
  process.exitCode = report.status === "passed" ? 0 : 1;
}
