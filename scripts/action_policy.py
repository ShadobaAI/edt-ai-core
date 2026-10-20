"""Effective shared action policy; no stored approvals or external operations."""
import argparse
import json
from common import ROOT, ConfigError, cli, load


def effective_policy(project_policy=None):
    defaults = json.loads((ROOT / "policy/default.json").read_text(encoding="utf-8"))
    overlay = project_policy or {}
    if overlay.get("allow_shell_source_read", False) is not False:
        raise ConfigError("Project policy cannot permit shell access to protected source")
    required = defaults["require_explicit_confirmation"]
    if "require_explicit_confirmation" in overlay and not set(required).issubset(overlay["require_explicit_confirmation"]):
        raise ConfigError("Project policy cannot remove shared agreement groups")
    return {**defaults, **overlay, "require_explicit_confirmation": list(required),
            "workflow": "skills/1c-routing/references/action-policy.md"}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("project_root", nargs="?")
    args = parser.parse_args()
    policy = None
    if args.project_root:
        from profile import project_profile
        policy = project_profile(args.project_root)["policy"]
    print(json.dumps(effective_policy(policy), ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(cli(main))
