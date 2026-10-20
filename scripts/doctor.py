#!/usr/bin/env python3
"""Read-only diagnostics; optional live managed-MCP probes start scoped sessions."""
import argparse
import json
from pathlib import Path
from urllib.parse import urlsplit
from common import ConfigError, cli, settings, state_path
from profile import project_profile
from runtime import artifact, project, smoke


def inspect(project_root, config, state, live=False, managed_only=False):
    from project_context import locate_project, effective_settings
    root = locate_project(project_root)
    report = {"status": "configured", "project_root": str(root), "errors": [],
              "warnings": [], "managed": [], "external": {},
              "full_development_readiness": "not_verified"}
    data = project_profile(root)
    config = effective_settings(config, root, data, state=state)
    report["profile_id"] = data["profile_id"]
    from action_policy import effective_policy
    report["action_policy"] = effective_policy(data["policy"])
    from common import ROOT
    report["source_guard"] = {"packaged": (ROOT / "hooks/hooks.json").is_file(),
                              "host_trust": "not_verified", "host_activation": "not_verified"}
    if not data["repositories"]:
        report["errors"].append("No repository mappings configured")
    for name, entry in config["mcp"]["required"].items():
        url = entry["url"]
        valid = bool(url and urlsplit(url).scheme in ("http", "https") and urlsplit(url).netloc)
        if valid and (urlsplit(url).username or urlsplit(url).password):
            raise ConfigError("Credentials must not be embedded in MCP URLs")
        report["external"][name] = {"configured": valid, "mode": "user", "live": "not_verified"}
        if not valid:
            (report["warnings"] if managed_only else report["errors"]).append(f"Set user-started MCP URL: {name}")
    report["warnings"].append("EDT/v8std live acceptance requires the user's running servers")
    if data["knowledge"]["provider"] == "openviking":
        ov = config["mcp"].get("optional", {}).get("openviking", {})
        if not ov.get("enabled") or not ov.get("url"):
            report["warnings"].append("Profile requests optional OpenViking, but no enabled URL is configured")
    if live and not report["errors"]:
        root, data = project(root, config)
        from policy_runtime import smoke as policy_smoke
        try:
            report["policy"] = policy_smoke(config)
        except (OSError, RuntimeError, ValueError) as exc:
            report["errors"].append(f"policy: {exc}")
        for component in ("code-index", "bsl-ls"):
            try:
                probe = smoke(state, config, root, data, component)
                report["managed"].append(probe)
                if component == "code-index" and probe.get("index_ready") is not True:
                    report["errors"].append(
                        "code-index: repository index readiness was not confirmed; "
                        "check index health and repository coverage")
            except (OSError, RuntimeError, ValueError) as exc:
                report["errors"].append(f"{component}: {exc}")
        report["status"] = "managed_mcp_ready"
    else:
        for component in ("code-index", "bsl-ls"):
            path = artifact(state, component)
            report["managed"].append({"component": component,
                                      "installed_and_hash_verified": bool(path),
                                      "live": "not_checked"})
    if report["errors"]:
        report["status"] = "error"
    return report


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("project_root", type=Path)
    p.add_argument("--settings", type=Path)
    p.add_argument("--state-dir", type=Path)
    p.add_argument("--live", action="store_true", help="May download runtimes and start managed processes")
    p.add_argument("--managed-only", action="store_true", help="Allow missing external URLs for isolated runtime tests")
    a = p.parse_args()
    config = settings(a.settings)
    result = inspect(a.project_root, config, state_path(config, a.state_dir), a.live, a.managed_only)
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 1 if result["errors"] else 0


if __name__ == "__main__":
    raise SystemExit(cli(main))

