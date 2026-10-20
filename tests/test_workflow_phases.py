"""Execute skill phase scenarios against the bundled policy, without an EDT/IB."""
import copy
from pathlib import Path
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
from common import ROOT
from mcp_client import McpClient


class WorkflowPhases(unittest.TestCase):
    def setUp(self):
        self.client = McpClient(["node", str(ROOT / "policy/read-only-mcp.mjs")], ROOT)
        self.client.initialize()
        tools = {item["name"]: item for item in self.client.request("tools/list")["tools"]}
        self.mechanisms = tools["detect_1c_mechanisms"]["inputSchema"]["properties"]["assessments"]["propertyNames"]["enum"]
        self.target = "synthetic/project/CommonModule.Example.Method"

    def tearDown(self):
        self.client.close()

    def call(self, name, **args):
        return self.client.call(name, args)["structuredContent"]

    def rejected(self, name, message, **args):
        result = self.client.request("tools/call", {"name": name, "arguments": args})
        self.assertTrue(result.get("isError"), result)
        self.assertRegex(result["content"][0]["text"], message)

    def assessment(self, source_ref, present=()):
        return self.call("detect_1c_mechanisms", sourceRef=source_ref, format="compact",
                         assessments={name: {"status": "present" if name in present else "absent",
                                             "evidence": f"synthetic scoped transition assessed in {source_ref}"}
                                      for name in self.mechanisms})

    def subject(self, source_ref, present=(), artifact="bsl", operation="change"):
        return {"target": self.target, "artifact": artifact, "operation": operation,
                "sourceRef": source_ref, "mechanisms": list(present),
                "detection": self.assessment(source_ref, present)}

    def select(self, subject):
        return self.call("select_1c_requirements", **{key: value for key, value in subject.items()
                                                    if key != "sourceRef"})

    def ledger(self, selection, source_ref):
        return [{"selector": selector, "selection_digest": selection["digest"],
                 "target": selection["target"], "source_ref": source_ref, "status": "passed",
                 "evidence": f"synthetic clause assessed against {source_ref}"}
                for selector in selection["mandatory"] + selection["recommended"]]

    def test_first_query_uses_projected_transition_before_write(self):
        baseline = self.subject("synthetic:baseline-without-query")
        invalid = {**baseline, "mechanisms": ["query_text"]}
        self.rejected("select_1c_requirements", "contradicts detection absence",
                      **{key: value for key, value in invalid.items() if key != "sourceRef"})

        proposal = self.subject("synthetic:baseline-to-proposed-query", ["query_text"])
        selection = self.select(proposal)
        self.assertIn("std437", selection["mandatory"])
        checked = self.call("validate_compliance", phase="proposal", selection=selection,
                            ledger=self.ledger(selection, proposal["sourceRef"]), current=proposal)
        self.assertEqual(checked["status"], "ledger_valid")

        result = self.subject("synthetic:baseline-to-actual-query", ["query_text"])
        self.rejected("validate_compliance", "source_ref differs", phase="result", selection=selection,
                      ledger=self.ledger(selection, proposal["sourceRef"]), current=result)
        checked = self.call("validate_compliance", phase="result", selection=selection,
                            ledger=self.ledger(selection, result["sourceRef"]), current=result)
        self.assertEqual(checked["status"], "ledger_valid")

        unexpected = self.subject("synthetic:unplanned-privileges", ["query_text", "privileged_mode"])
        self.rejected("validate_compliance", "changed mechanisms", phase="result", selection=selection,
                      ledger=self.ledger(selection, unexpected["sourceRef"]), current=unexpected)

    def test_create_has_a_proposal_before_the_target_exists(self):
        proposal = self.subject("synthetic:known-owner-to-proposed-object", artifact="metadata", operation="create")
        proposal["mechanisms"] = ["metadata_naming"]
        selection = self.select(proposal)
        self.assertIn("std474", selection["mandatory"])
        checked = self.call("validate_compliance", phase="proposal", selection=selection,
                            ledger=self.ledger(selection, proposal["sourceRef"]), current=proposal)
        self.assertEqual(checked["status"], "ledger_valid")

    def test_delete_remains_a_transition_fact_when_result_target_is_absent(self):
        proposal = self.subject("synthetic:existing-target-to-planned-absence", ["metadata_delete"], artifact="metadata")
        selection = self.select(proposal)
        self.assertIn("std534", selection["mandatory"])
        result = self.subject("synthetic:existing-target-to-confirmed-absence", ["metadata_delete"], artifact="metadata")
        checked = self.call("validate_compliance", phase="result", selection=selection,
                            ledger=self.ledger(selection, result["sourceRef"]), current=result)
        self.assertEqual(checked["status"], "ledger_valid")

    def test_review_reports_unverified_result_without_manufacturing_a_proposal(self):
        reviewed = self.subject("synthetic:reviewed-target-sha", operation="review")
        selection = self.select(reviewed)
        ledger = self.ledger(selection, reviewed["sourceRef"])
        ledger[0].update(status="unverified", evidence="synthetic normative evidence unavailable")
        checked = self.call("validate_compliance", phase="result", selection=selection,
                            ledger=ledger, current=reviewed)
        self.assertEqual(checked["status"], "blocked")
        self.assertIn(ledger[0]["selector"], [item["selector"] for item in checked["unresolved"]])

    def test_design_selection_is_reselected_when_implementation_operation_changes(self):
        design = self.subject("synthetic:design-draft", ["query_text"], operation="design")
        selected_design = self.select(design)
        implementation = copy.deepcopy(design)
        implementation["operation"] = "change"
        self.rejected("validate_compliance", "operation differs", phase="proposal", selection=selected_design,
                      ledger=self.ledger(selected_design, design["sourceRef"]), current=implementation)
        selected_change = self.select(implementation)
        self.assertNotEqual(selected_design["digest"], selected_change["digest"])
        self.assertEqual(selected_design["mandatory"], selected_change["mandatory"])


if __name__ == "__main__":
    unittest.main()
