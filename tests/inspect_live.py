"""Inspect test-server tool contracts; writes only to the requested report directory."""
import argparse, json, sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
from common import settings, state_path
from runtime import launch_command, project
from mcp_client import McpClient
p=argparse.ArgumentParser(); p.add_argument("--project-root",type=Path,required=True); p.add_argument("--state-dir",type=Path,required=True)
a=p.parse_args(); config=settings(); root,data=project(a.project_root,config)
for component in ("code-index","bsl-ls"):
    command,cwd,env=launch_command(a.state_dir.resolve(),config,component,root,data)
    with McpClient(command,cwd,env) as client:
        client.initialize()
        tools=client.request("tools/list")["tools"]
        for tool in tools:
            if tool["name"] in ("health","get_stats","find_symbol","search_function","document_symbols","analyze_file"):
                print(json.dumps({"component":component,"tool":tool},ensure_ascii=False))

