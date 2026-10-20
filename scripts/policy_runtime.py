"""Bundled read-only policy MCP binding and isolated readiness probe."""
from common import ROOT
from mcp_client import McpClient


def binding(config, plugin_root=ROOT):
    return {"type": "stdio",
            "command": config["mcp"]["managed"]["bsl-ls"].get("node", "node"),
            "args": [str(plugin_root / "policy/read-only-mcp.mjs")]}


def smoke(config):
    entry = binding(config)
    with McpClient([entry["command"], *entry["args"]], ROOT, timeout=15) as client:
        server = client.initialize()["serverInfo"]
        tools = client.request("tools/list")["tools"]
        required = {"detect_1c_mechanisms", "select_1c_requirements",
                    "select_yaxunit_requirements", "validate_compliance",
                    "get_action_policy", "check_action"}
        if {tool["name"] for tool in tools} != required or not all(
                tool.get("annotations", {}).get("readOnlyHint") for tool in tools):
            raise RuntimeError("Bundled policy tool contract mismatch")
        # Run/report-only selection needs no source, test launch or normative corpus.
        selection = client.call("select_yaxunit_requirements", {
            "target": "policy-readiness-probe", "operation": "report", "mechanisms": []})["structuredContent"]
        if (selection.get("status") != "not_applicable" or selection.get("reason") != "authoring_not_requested"
                or "digest" in selection or selection.get("operation") != "report"):
            raise RuntimeError("Bundled policy runtime-only probe failed")
        # Exercise nonempty selection and a negative ledger without asserting
        # that a real source or normative clause was inspected during startup.
        authoring = client.call("select_yaxunit_requirements", {
            "target": "policy-readiness-probe", "operation": "design", "mechanisms": []})["structuredContent"]
        if not authoring.get("digest") or not authoring.get("mandatory"):
            raise RuntimeError("Bundled policy authoring selection probe failed")
        current = {"target": authoring["target"], "artifact": "yaxunit", "operation": "design",
                   "sourceRef": "synthetic:policy-readiness", "mechanisms": []}
        ledger = [{"selector": selector, "selection_digest": authoring["digest"], "target": current["target"],
                   "source_ref": current["sourceRef"], "status": "unverified",
                   "evidence": "Synthetic startup probe; normative text and source are not inspected"}
                  for selector in authoring["mandatory"] + authoring["recommended"]]
        assessment = client.call("validate_compliance", {
            "phase": "proposal", "selection": authoring, "ledger": ledger, "current": current})["structuredContent"]
        if assessment.get("status") != "blocked" or len(assessment.get("unresolved", [])) != len(ledger):
            raise RuntimeError("Bundled policy negative-ledger probe failed")
        return {"component": "policy", "server": server, "live": "ready",
                "registry_version": selection["registryVersion"], "evidence": "synthetic_protocol_checks_only"}
