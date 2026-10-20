"""Live smoke through the same stdio launchers used by a host."""
import argparse
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import sys
import time
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
from common import ROOT
from runtime import save_json
from mcp_client import McpClient

p = argparse.ArgumentParser()
p.add_argument("--project-root", type=Path, required=True)
p.add_argument("--state-dir", type=Path, required=True)
p.add_argument("--output", type=Path, required=True)
a = p.parse_args()
root = a.project_root.resolve()
state = a.state_dir.resolve()
report = {"time_utc": datetime.now(timezone.utc).isoformat(),
          "project_root": str(root), "components": []}
for component in ("code-index", "bsl-ls"):
    command = [sys.executable, str(ROOT / "scripts/managed_mcp.py"), "--component", component,
               "--project-root", str(root), "--state-dir", str(state)]
    with McpClient(command, root, timeout=90) as client:
        server = client.initialize()
        tools = client.request("tools/list")["tools"]
        entry = {"component": component, "server": server["serverInfo"], "tool_count": len(tools)}
        if component == "code-index":
            deadline = time.monotonic() + 60
            while True:
                health = client.call("health", {})
                found = client.call("find_symbol", {"repo": "fixture", "name": "Сложить"})
                if "Сложить" in json.dumps(found, ensure_ascii=False):
                    break
                if time.monotonic() > deadline:
                    raise AssertionError(f"Indexed symbol not found: {found}, health: {health}")
                time.sleep(.5)
            entry["health"] = health
            entry["symbol_lookup"] = found
        else:
            client.call("register_workspace_folder", {"path": str(root)})
            path = root / "src/Module.bsl"
            symbols = client.call("document_symbols", {"file": str(path)})
            assert "Сложить" in json.dumps(symbols, ensure_ascii=False), symbols
            diagnostics = client.call("analyze_file", {"file": str(path)})
            entry["symbols"] = symbols
            entry["diagnostics"] = diagnostics
            broken = client.call("analyze_file", {"file": str(root / "src/Broken.bsl")})
            broken_body = json.loads(broken["content"][0]["text"])
            assert broken_body["diagnosticsCount"] > 0, broken
            entry["intentional_syntax_error_detected"] = broken_body
            # Guard must reject a file outside this repository.
            try:
                client.call("analyze_file", {"file": str(ROOT / "README.md")})
                raise AssertionError("Outside-root file was accepted")
            except RuntimeError as exc:
                assert "inside the selected project directory" in str(exc), str(exc)
                entry["outside_root_rejected"] = True
        report["components"].append(entry)
report["status"] = "passed"
save_json(a.output, report)
print(json.dumps({"status": "passed", "report": str(a.output.resolve()),
                  "components": [{k: entry[k] for k in ("component", "server", "tool_count")}
                                 for entry in report["components"]]}, ensure_ascii=False, indent=2))

