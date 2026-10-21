import path from "node:path";
import assert from "node:assert/strict";
import { ROOT, argumentsOf, sleep, cli } from "../scripts/common.mjs";
import { resolve } from "../scripts/project_paths.mjs";
import { save_json } from "../scripts/runtime.mjs";
import { McpClient } from "../scripts/mcp_client.mjs";
import { all_pages } from "../scripts/mcp_pages.mjs";
await cli(async () => {
  const a = argumentsOf(),
    root = resolve(a.project_root),
    state = resolve(a.state_dir),
    report = {
      time_utc: new Date().toISOString(),
      project_root: root,
      components: [],
    };
  for (const component of ["code-index", "bsl-ls"]) {
    const client = new McpClient(
      [
        process.execPath,
        path.join(ROOT, "scripts/managed_mcp.mjs"),
        "--component",
        component,
        "--project-root",
        root,
        "--state-dir",
        state,
      ],
      root,
      process.env,
      90,
    );
    try {
      const server = await client.initialize(),
        tools = (await all_pages(client, "tools/list", "tools")).tools,
        entry = {
          component,
          server: server.serverInfo,
          tool_count: tools.length,
        };
      if (component === "code-index") {
        const deadline = Date.now() + 60000;
        let found, health;
        while (true) {
          health = await client.call("health", {});
          found = await client.call("find_symbol", {
            repo: "fixture",
            name: "Сложить",
          });
          if (JSON.stringify(found).includes("Сложить")) break;
          if (Date.now() > deadline)
            throw new Error(
              "Indexed symbol not found: " + JSON.stringify({ found, health }),
            );
          await sleep(500);
        }
        Object.assign(entry, { health, symbol_lookup: found });
      } else {
        await client.call("register_workspace_folder", { path: root });
        const file = path.join(root, "src/Module.bsl"),
          symbols = await client.call("document_symbols", { file });
        assert.ok(JSON.stringify(symbols).includes("Сложить"));
        entry.symbols = symbols;
        entry.diagnostics = await client.call("analyze_file", { file });
        const broken = await client.call("analyze_file", {
            file: path.join(root, "src/Broken.bsl"),
          }),
          body =
            broken.structuredContent ||
            JSON.parse(
              broken.content.find((part) => part.type === "text").text,
            );
        assert.ok(body.diagnosticsCount > 0);
        entry.intentional_syntax_error_detected = body;
        await assert.rejects(
          client.call("analyze_file", { file: path.join(ROOT, "README.md") }),
          /inside the selected project directory/,
        );
        entry.outside_root_rejected = true;
      }
      report.components.push(entry);
    } catch (error) {
      report.status = "failed";
      report.detail = error.message;
      save_json(a.output, report);
      throw error;
    } finally {
      await client.close();
    }
  }
  report.status = "passed";
  save_json(a.output, report);
  console.log(
    JSON.stringify(
      {
        status: "passed",
        report: resolve(a.output),
        components: report.components.map(
          ({ component, server, tool_count }) => ({
            component,
            server,
            tool_count,
          }),
        ),
      },
      null,
      2,
    ),
  );
});
