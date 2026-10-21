import { argumentsOf, settings } from "../scripts/common.mjs";
import { launch_command, project } from "../scripts/runtime.mjs";
import { McpClient } from "../scripts/mcp_client.mjs";
import { all_pages } from "../scripts/mcp_pages.mjs";
const a = argumentsOf(),
  config = settings(),
  [root, data] = project(a.project_root, config);
for (const component of ["code-index", "bsl-ls"]) {
  const [command, cwd, env] = await launch_command(
      a.state_dir,
      config,
      component,
      root,
      data,
    ),
    client = new McpClient(command, cwd, env);
  try {
    await client.initialize();
    for (const tool of (await all_pages(client, "tools/list", "tools")).tools)
      console.log(JSON.stringify({ component, tool }));
  } finally {
    await client.close();
  }
}
