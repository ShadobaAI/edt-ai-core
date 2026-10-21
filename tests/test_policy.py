"""Exercise the shipped policy MCP, normative gates and installation bindings."""
import copy
import json
import os
import subprocess
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch
from jsonschema import Draft202012Validator

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
from common import ROOT, dump, load, settings
from doctor import inspect
from mcp_client import McpClient
from policy_runtime import binding, smoke
from prepare_install import build


class Policy(unittest.TestCase):
    def setUp(self):
        # Start exactly the canonical plugin entrypoint, with no project/config setup.
        entry = json.loads((ROOT / "mcp.json").read_text(encoding="utf-8"))["mcpServers"]["policy"]
        args = [arg.replace("${PLUGIN_ROOT}", str(ROOT)) for arg in entry["args"]]
        self.client = McpClient([entry["command"], *args], ROOT, timeout=15)
        self.server = self.client.initialize()["serverInfo"]
        self.tools = {tool["name"]: tool for tool in self.client.request("tools/list")["tools"]}
        self.target = "synthetic/project/Module.Method"
        critical = self.tools["detect_1c_mechanisms"]["inputSchema"]["properties"]["assessments"]["propertyNames"]["enum"]
        self.absent = {name: {"status": "absent", "evidence": "synthetic EDT fixture: scoped context inspected"}
                       for name in critical}

    def tearDown(self):
        self.client.close()

    def call(self, name, **args):
        return self.client.call(name, args)["structuredContent"]

    def rejected(self, name, message, **args):
        result = self.client.request("tools/call", {"name": name, "arguments": args})
        self.assertTrue(result.get("isError"), result)
        self.assertRegex(result["content"][0]["text"], message)

    def detection(self, present=()):
        assessments = copy.deepcopy(self.absent)
        for name in present:
            assessments[name] = {"status": "present", "evidence": "synthetic EDT fixture: observed construct"}
        return self.call("detect_1c_mechanisms", sourceRef="EDT:synthetic:hash-A",
                         assessments=assessments, format="compact")

    def selection(self, mechanisms=(), present=(), artifact="bsl", additional=()):
        detection = self.detection(present)
        selection = self.call("select_1c_requirements", artifact=artifact, operation="change",
                              target=self.target, mechanisms=list(mechanisms), detection=detection,
                              additionalRequirements=list(additional))
        return selection, {"target": self.target, "artifact": artifact, "operation": "change",
                           "sourceRef": detection["sourceRef"], "mechanisms": list(mechanisms), "detection": detection,
                           "additionalRequirements": list(additional)}

    def ledger(self, selection, source_ref="EDT:synthetic:hash-A"):
        return [{"selector": selector, "selection_digest": selection["digest"],
                 "target": selection["target"], "source_ref": source_ref, "status": "passed",
                 "evidence": "synthetic exact normative clause and target checked"}
                for selector in selection["mandatory"] + selection["recommended"]]

    def test_canonical_connection_is_read_only_and_needs_no_project_profile(self):
        self.assertEqual(self.server["name"], "1c-ai-policy-readonly")
        self.assertEqual(self.server["version"], "2.1.0")
        self.assertEqual(len(self.tools), 6)
        self.assertTrue(all(tool["annotations"]["readOnlyHint"] for tool in self.tools.values()))
        probe = smoke(settings())
        self.assertEqual(probe["live"], "ready")
        self.assertEqual(probe["evidence"], "synthetic_protocol_checks_only")

    def test_action_policy_reuses_only_exact_scope_user_evidence(self):
        policy = self.call("get_action_policy")
        self.assertFalse(policy["allow_shell_source_read"])
        self.assertEqual(set(policy["require_explicit_confirmation"]), {"cleanup", "launch", "database", "remote_git"})
        request = {"effects": ["launch", "database"], "scope": "project/test-base-A", "authorizations": []}
        self.assertEqual(self.call("check_action", **request)["status"], "requires_user_agreement")
        request["authorizations"] = [{"effects": ["launch", "database"], "scope": request["scope"],
                                      "evidence": "synthetic actual-user-turn reference"}]
        for _ in range(2):
            self.assertEqual(self.call("check_action", **request)["status"], "within_declared_scope")
        request["scope"] = "project/test-base-B"
        self.assertEqual(self.call("check_action", **request)["status"], "requires_user_agreement")
        request["authorizations"][0]["evidence"] = " "
        self.rejected("check_action", "nonblank", **request)

    def test_query_selection_deduplicates_rules_and_preserves_recommendation_strength(self):
        selection, _ = self.selection(["existence_query"], ["query_text", "query_in_loop"])
        self.assertIn("std437", selection["mandatory"])
        self.assertIn("std438", selection["mandatory"])
        self.assertEqual(selection["mandatory"].count("std437"), 1)
        self.assertIn("std436", selection["recommended"])
        self.assertNotIn("std436", selection["mandatory"])
        same, _ = self.selection(["query_in_loop", "existence_query"], ["query_in_loop", "query_text"])
        self.assertEqual(selection["digest"], same["digest"])

    def test_metadata_rights_select_applicable_standard_without_unrelated_bsl_rules(self):
        selection, current = self.selection(present=["access_rights"], artifact="metadata")
        self.assertEqual(selection["mandatory"], ["std689"])
        self.assertEqual(self.call("validate_compliance", phase="proposal", selection=selection,
                                   ledger=self.ledger(selection), current=current)["status"], "ledger_valid")

    def test_query_artifact_cannot_disclaim_query_mechanism(self):
        self.rejected("select_1c_requirements", "query_text presence evidence", artifact="query",
                      target=self.target, operation="review", mechanisms=[], detection=self.detection())
        selection, _ = self.selection(present=["query_text"], artifact="query")
        self.assertIn("std437", selection["mandatory"])

    def test_unknown_incomplete_or_contradictory_evidence_blocks_selection(self):
        unknown = self.call("detect_1c_mechanisms", sourceRef="EDT:unknown", assessments={})
        self.rejected("select_1c_requirements", "incomplete", artifact="bsl", operation="change",
                      target=self.target, mechanisms=[], detection=unknown)
        partial = self.detection()
        partial["coverage"].pop()
        self.rejected("select_1c_requirements", "too few", artifact="bsl", operation="change",
                      target=self.target, mechanisms=[], detection=partial)
        self.rejected("select_1c_requirements", "contradicts detection absence", artifact="bsl",
                      target=self.target, operation="change", mechanisms=["explicit_transaction"], detection=self.detection())
        self.rejected("select_1c_requirements", "expected one of", artifact="bsl",
                      target=self.target, operation="change", mechanisms=["unregistered_mechanism"], detection=self.detection())

    def test_missing_metadata_registry_coverage_cannot_be_validated_as_selection(self):
        unavailable, current = self.selection(artifact="metadata")
        self.assertEqual(unavailable["status"], "unavailable")
        self.assertEqual(unavailable["reason"], "registry_coverage_missing")
        self.assertNotIn("digest", unavailable)
        self.rejected("validate_compliance", "proposal:", phase="proposal",
                      selection=unavailable, ledger=[], current=current)

    def test_both_explicit_phases_accept_complete_current_evidence(self):
        selection, current = self.selection(["method_contract"])
        for phase in ("proposal", "result"):
            with self.subTest(phase=phase):
                result = self.call("validate_compliance", phase=phase, selection=selection,
                                   ledger=self.ledger(selection), current=current)
                self.assertEqual(result["phase"], phase)
                self.assertEqual(result["digest"], selection["digest"])
                self.assertEqual(result["status"], "ledger_valid")
                self.assertEqual(result["counts"]["mandatory"], len(selection["mandatory"]))
        self.rejected("validate_compliance", "missing-phase:", selection=selection,
                      ledger=self.ledger(selection), current=current)
        self.rejected("validate_compliance", "missing current", phase="result",
                      selection=selection, ledger=self.ledger(selection))

    def test_incomplete_duplicate_extra_or_unsubstantiated_ledger_fails(self):
        selection, current = self.selection()
        ledger = self.ledger(selection)
        variants = [ledger[:-1], ledger + [copy.deepcopy(ledger[0])]]
        extra = copy.deepcopy(ledger)
        extra.append({**extra[0], "selector": "std999999"})
        variants.append(extra)
        for key, value in [("status", "compliant"), ("status", "satisfied"),
                           ("evidence", " "), ("selection_digest", "old"), ("invented", "value")]:
            changed = copy.deepcopy(ledger)
            changed[0][key] = value
            variants.append(changed)
        mandatory_deviation = copy.deepcopy(ledger)
        mandatory_deviation[0].update(status="deviated", reason="does not excuse a mandatory requirement")
        variants.append(mandatory_deviation)
        for index, invalid in enumerate(variants):
            with self.subTest(case=index):
                self.rejected("validate_compliance", "proposal:", phase="proposal",
                              selection=selection, ledger=invalid, current=current)

    def test_recommendation_deviation_requires_reason(self):
        selection, current = self.selection(present=["query_text", "query_in_loop"])
        ledger = self.ledger(selection)
        deviation = next(entry for entry in ledger if entry["selector"] == "std436")
        deviation["status"] = "deviated"
        self.rejected("validate_compliance", "result:", phase="result", selection=selection,
                      ledger=ledger, current=current)
        deviation["reason"] = "synthetic documented exception: bounded workload; exact clause checked"
        self.assertEqual(self.call("validate_compliance", phase="result", selection=selection,
                                   ledger=ledger, current=current)["status"], "ledger_valid")

    def test_reason_is_restricted_to_deviations(self):
        selection, current = self.selection()
        ledger = self.ledger(selection)
        ledger[0]["reason"] = "explanation attached to a passing row"
        arguments = {"phase": "proposal", "selection": selection, "ledger": ledger, "current": current}
        schema = self.tools["validate_compliance"]["inputSchema"]
        self.assertFalse(Draft202012Validator(schema).is_valid(arguments))
        result = self.client.request("tools/call", {"name": "validate_compliance", "arguments": arguments})
        self.assertTrue(result["isError"])

    def test_changed_mechanisms_stale_registry_or_tampered_selection_fail(self):
        selection, current = self.selection(["method_contract"])
        changed = {**current, "mechanisms": []}
        self.rejected("validate_compliance", "changed mechanisms", phase="result", selection=selection,
                      ledger=self.ledger(selection), current=changed)
        added = {**current, "mechanisms": ["method_contract"],
                 "detection": self.detection(["explicit_transaction"])}
        self.rejected("validate_compliance", "changed mechanisms", phase="result", selection=selection,
                      ledger=self.ledger(selection), current=added)
        for field, value in [("registryVersion", "2000-01-01.1"), ("digest", "tampered"),
                             ("mandatory", []), ("artifact", "query"),
                             ("mechanisms", []), ("matchedRows", [])]:
            invalid = {**selection, field: value}
            with self.subTest(field=field):
                self.rejected("validate_compliance", "result:", phase="result", selection=invalid,
                              ledger=self.ledger(selection), current=current)

    def test_new_source_reference_allows_reusing_unchanged_applicability(self):
        selection, current = self.selection(["method_contract"])
        current["detection"]["sourceRef"] = "EDT:synthetic:hash-B"
        current["sourceRef"] = "EDT:synthetic:hash-B"
        self.rejected("validate_compliance", "source_ref differs", phase="result", selection=selection,
                      ledger=self.ledger(selection), current=current)
        self.assertEqual(self.call("validate_compliance", phase="result", selection=selection,
                                   ledger=self.ledger(selection, current["sourceRef"]), current=current)["status"], "ledger_valid")
        missing = copy.deepcopy(selection)
        missing.pop("detectionSourceRef")
        self.rejected("validate_compliance", "result:", phase="result", selection=missing,
                      ledger=self.ledger(selection), current=current)

    def test_yaxunit_authoring_and_report_only_selections_are_distinct(self):
        selection = self.call("select_yaxunit_requirements", operation="create",
                              target=self.target, mechanisms=["test_module", "registration", "transactional_test"])
        self.assertIn("yaxunit:patterns:registration-and-parameters", selection["mandatory"])
        self.assertIn("yaxunit:patterns:data-isolation", selection["mandatory"])
        report = self.call("select_yaxunit_requirements", operation="report", target=self.target, mechanisms=[])
        self.assertEqual(report["status"], "not_applicable")
        self.assertNotIn("digest", report)
        self.rejected("select_yaxunit_requirements", "expected one of", operation="create",
                      target=self.target, mechanisms=["yaxunit:patterns:test-module"])

    def test_raw_source_is_rejected_instead_of_being_used_as_semantic_evidence(self):
        for source in ('// SELECT is only a comment', 'Log("Экспорт");',
                       'Данные = ОбменФайлами.Выгрузить();'):
            with self.subTest(source=source):
                self.rejected("detect_1c_mechanisms", "unknown property sourceText", sourceRef="EDT:fixture",
                              assessments=self.absent, sourceText=source)
        assessments = copy.deepcopy(self.absent)
        assessments["query_text"]["evidence"] = 'EDT: SELECT occurs only in a comment, not query text'
        assessments["export_contract"]["evidence"] = 'EDT: "Экспорт" is a string literal'
        assessments["query_result_processing"] = {"status": "unknown",
            "evidence": "EDT: receiver of Выгрузить is not yet resolved"}
        detection = self.call("detect_1c_mechanisms", sourceRef="EDT:fixture", assessments=assessments)
        coverage = {name: (status, evidence) for name, status, evidence in detection["coverage"]}
        for name in ("query_text", "export_contract", "query_result_processing"):
            self.assertEqual(coverage[name], (assessments[name]["status"], assessments[name]["evidence"]))

    def test_query_related_mechanisms_do_not_invent_text_in_a_delegating_helper(self):
        for explicit, present, required in (([], ["query_result_processing"],
                "corporate:work:query-conventions:overview#Обработка результата"),
                (["query_parameters"], [], "std437"), ([], ["query_in_loop"], "std436")):
            with self.subTest(present=present, explicit=explicit):
                selection, current = self.selection(explicit, present)
                self.assertNotIn("query_text", selection["mechanisms"])
                self.assertIn(required, selection["mandatory"] + selection["recommended"])
                self.assertEqual(self.call("validate_compliance", phase="result", selection=selection,
                    ledger=self.ledger(selection), current=current)["status"], "ledger_valid")

    def test_yaxunit_does_not_invent_persistent_data_or_database_assertions(self):
        selection = self.call("select_yaxunit_requirements", target=self.target, operation="change",
                              mechanisms=["transactional_test", "nontrivial_predicate"])
        self.assertNotIn("persistent_data", selection["mechanisms"])
        self.assertNotIn("database_assertion", selection["mechanisms"])
        self.assertIn("yaxunit:patterns:data-isolation", selection["mandatory"])
        self.assertIn("yaxunit:patterns:predicates-and-queries", selection["mandatory"])

    def test_yaxunit_design_selects_baseline_and_new_module_naming(self):
        for mechanisms in ([], ["test_behavior"], ["test_module"]):
            with self.subTest(mechanisms=mechanisms):
                selection = self.call("select_yaxunit_requirements", target=self.target,
                                      operation="design", mechanisms=mechanisms)
                self.assertIn("yaxunit:patterns:authoring-baseline", selection["mandatory"])
                if "test_module" in mechanisms:
                    self.assertIn("yaxunit:patterns:naming", selection["mandatory"])

    def test_runtime_only_operations_never_manufacture_a_compliance_pass(self):
        mechanisms = self.tools["select_yaxunit_requirements"]["inputSchema"]["properties"]["mechanisms"]["items"]["enum"]
        for operation in ("run", "report"):
            with self.subTest(operation=operation):
                result = self.call("select_yaxunit_requirements", target=self.target, operation=operation,
                                   mechanisms=mechanisms, unknownMechanisms=["test_behavior"])
                self.assertEqual(result["status"], "not_applicable")
                self.assertEqual(result["reason"], "authoring_not_requested")
                self.assertNotIn("digest", result)
                self.assertNotIn("mandatory", result)
                self.rejected("validate_compliance", "result:", phase="result", selection=result, ledger=[],
                    current={"target": self.target, "artifact": "yaxunit", "operation": operation,
                             "sourceRef": "synthetic:run-report", "mechanisms": mechanisms})

    def test_baseline_rules_cannot_mask_an_uncovered_mechanism(self):
        result, current = self.selection(["metadata_naming"], artifact="bsl")
        self.assertEqual(result["status"], "unavailable")
        self.assertEqual(result["uncoveredMechanisms"], ["metadata_naming"])
        self.assertNotIn("digest", result)
        self.rejected("validate_compliance", "proposal:", phase="proposal",
                      selection=result, ledger=[], current=current)

    def test_context_and_evidence_are_bound_to_the_actual_ledger_target(self):
        selection, current = self.selection()
        for field, value in (("target", "other/project/Module.Method"), ("artifact", "metadata"),
                             ("operation", "review"), ("sourceRef", "EDT:other:hash")):
            with self.subTest(field=field):
                self.rejected("validate_compliance", "result:", phase="result", selection=selection,
                    ledger=self.ledger(selection), current={**current, field: value})
        for field, value in (("target", "other/project/Module.Method"), ("source_ref", "EDT:old:hash")):
            ledger = self.ledger(selection)
            ledger[0][field] = value
            self.rejected("validate_compliance", "target/source_ref differs", phase="result",
                          selection=selection, ledger=ledger, current=current)
        other = self.call("select_1c_requirements", target="other/project/Module.Method",
            artifact="bsl", operation="change", mechanisms=[], detection=self.detection())
        self.assertNotEqual(selection["digest"], other["digest"])

    def test_failed_or_unverified_requirements_are_a_structured_blocked_assessment(self):
        selection, current = self.selection(present=["query_text", "query_in_loop"])
        for strength in ("mandatory", "recommended"):
            for status in ("failed", "unverified"):
                with self.subTest(strength=strength, status=status):
                    ledger = self.ledger(selection)
                    rule = selection[strength][0]
                    next(row for row in ledger if row["selector"] == rule)["status"] = status
                    result = self.call("validate_compliance", phase="result", selection=selection,
                                       ledger=ledger, current=current)
                    self.assertEqual(result["status"], "blocked")
                    self.assertEqual(result["unresolved"], [{"selector": rule, "strength": strength, "status": status}])
                    self.assertEqual(result["counts"]["recommended"], len(selection["recommended"]))

    def test_public_output_schemas_validate_with_an_independent_json_schema_engine(self):
        for tool in self.tools.values():
            Draft202012Validator.check_schema(tool["inputSchema"])
            if "outputSchema" in tool:
                Draft202012Validator.check_schema(tool["outputSchema"])
        selection, current = self.selection()
        ledger = self.ledger(selection)
        results = [("detect_1c_mechanisms", self.detection()), ("select_1c_requirements", selection),
            ("select_1c_requirements", self.selection(artifact="metadata")[0]),
            ("select_yaxunit_requirements", self.call("select_yaxunit_requirements", target=self.target,
                                                     operation="run", mechanisms=["mocks"])),
            ("validate_compliance", self.call("validate_compliance", phase="proposal", selection=selection,
                                             ledger=ledger, current=current))]
        ledger[0]["status"] = "failed"
        results.append(("validate_compliance", self.call("validate_compliance", phase="result",
            selection=selection, ledger=ledger, current=current)))
        for tool, result in results:
            with self.subTest(tool=tool, status=result.get("status")):
                Draft202012Validator(self.tools[tool]["outputSchema"]).validate(result)

    def test_v8std_additions_outside_registry_are_required_in_the_same_ledger(self):
        additions = [{"selector": "std740", "strength": "mandatory",
                      "basis": "synthetic exact clause: storage of authentication secrets applies"},
                     {"selector": "std703", "strength": "recommended",
                      "basis": "synthetic exact clause: modal interaction in changed client method"}]
        baseline, _ = self.selection()
        self.assertNotIn("std740", baseline["mandatory"] + baseline["recommended"])
        selection, current = self.selection(additional=additions)
        self.assertIn("std740", selection["mandatory"])
        self.assertIn("std703", selection["recommended"])
        ledger = self.ledger(selection)
        self.rejected("validate_compliance", "coverage mismatch", phase="proposal", selection=selection,
            ledger=[row for row in ledger if row["selector"] != "std740"], current=current)
        added = next(row for row in ledger if row["selector"] == "std740")
        for status in ("failed", "unverified"):
            added["status"] = status
            result = self.call("validate_compliance", phase="proposal", selection=selection, ledger=ledger, current=current)
            self.assertEqual(result["status"], "blocked")
            self.assertEqual(result["unresolved"], [{"selector": "std740", "strength": "mandatory", "status": status}])
        added["status"] = "passed"
        result = self.call("validate_compliance", phase="result", selection=selection, ledger=ledger, current=current)
        self.assertEqual(result["status"], "ledger_valid")
        Draft202012Validator(self.tools["select_1c_requirements"]["outputSchema"]).validate(selection)

    def test_additions_deduplicate_registry_selectors_without_weakening_them(self):
        baseline, _ = self.selection(present=["query_in_loop"])
        mandatory, recommended = baseline["mandatory"][0], baseline["recommended"][0]
        additions = [{"selector": mandatory, "strength": "recommended", "basis": "synthetic weaker request"},
                     {"selector": recommended, "strength": "mandatory", "basis": "synthetic applicable stronger clause"}]
        selection, current = self.selection(present=["query_in_loop"], additional=additions)
        self.assertIn(mandatory, selection["mandatory"])
        self.assertIn(recommended, selection["mandatory"])
        self.assertNotIn(recommended, selection["recommended"])
        self.assertEqual(len(selection["mandatory"] + selection["recommended"]),
                         len(baseline["mandatory"] + baseline["recommended"]))
        ledger = self.ledger(selection)
        next(row for row in ledger if row["selector"] == mandatory).update(status="deviated", reason="synthetic")
        self.rejected("validate_compliance", "mandatory requirements cannot be deviated", phase="result",
                      selection=selection, ledger=ledger, current=current)

    def test_addition_changes_are_bound_to_selection_and_old_ledgers_are_rejected(self):
        additions = [{"selector": "std740", "strength": "mandatory", "basis": "synthetic exact secret clause"},
                     {"selector": "std703", "strength": "recommended", "basis": "synthetic exact modal clause"}]
        selection, current = self.selection(additional=additions)
        reordered, _ = self.selection(additional=list(reversed(additions)))
        self.assertEqual(selection["digest"], reordered["digest"])
        self.assertEqual(selection["additionalRequirements"], reordered["additionalRequirements"])
        for changed in ([], [additions[0]], [{**additions[0], "strength": "recommended"}, additions[1]],
                        [{**additions[0], "basis": "different normative clause"}, additions[1]]):
            self.rejected("validate_compliance", "reselect requirements", phase="result", selection=selection,
                ledger=self.ledger(selection), current={**current, "additionalRequirements": changed})
        tampered = copy.deepcopy(selection)
        tampered["additionalRequirements"][0]["basis"] = "tampered"
        self.rejected("validate_compliance", "reselect requirements", phase="result", selection=tampered,
                      ledger=self.ledger(selection), current=current)
        baseline, _ = self.selection()
        self.rejected("validate_compliance", "invalid or duplicate", phase="result", selection=selection,
                      ledger=self.ledger(baseline), current=current)

    def test_invalid_additions_do_not_become_normative_requirements(self):
        good = {"selector": "std740", "strength": "mandatory", "basis": "synthetic clause"}
        for item in ({**good, "basis": " "}, {**good, "strength": "optional"},
                     {**good, "selector": "bslls:UsingModalWindows"},
                     {**good, "selector": "vanessa:mcp:run_tests"},
                     {**good, "selector": "yaxunit:api:test-builder:overview"},
                     {**good, "selector": "v8cs:secure-password-storage"}, {**good, "score": 1},
                     {key: value for key, value in good.items() if key != "basis"}):
            self.rejected("select_1c_requirements", "additionalRequirements", target=self.target,
                artifact="bsl", operation="change", mechanisms=[], detection=self.detection(), additionalRequirements=[item])
        self.rejected("select_1c_requirements", "duplicate additional", target=self.target,
            artifact="bsl", operation="change", mechanisms=[], detection=self.detection(), additionalRequirements=[good, good])

    def test_corporate_yaxunit_and_vanessa_patterns_share_the_normative_ledger(self):
        selectors = ["corporate:work:bsl-change-policy:overview#Диагностики и ревью",
                     "yaxunit:patterns:data-isolation", "vanessa:patterns:steps-assertions"]
        additions = [{"selector": selector, "strength": "mandatory",
                      "basis": "Synthetic test context stipulates this exact requirement applies; not actual project evidence"}
                     for selector in selectors]
        selection, current = self.selection(additional=additions)
        self.assertTrue(set(selectors).issubset(selection["mandatory"]))
        Draft202012Validator(self.tools["select_1c_requirements"]["outputSchema"]).validate(selection)
        for missing in selectors:
            self.rejected("validate_compliance", "coverage mismatch", phase="proposal", selection=selection,
                ledger=[row for row in self.ledger(selection) if row["selector"] != missing], current=current)
        ledger = self.ledger(selection)
        for row in ledger:
            if row["selector"] in selectors:
                row["status"] = "unverified"
        result = self.call("validate_compliance", phase="proposal", selection=selection, ledger=ledger, current=current)
        self.assertEqual(result["status"], "blocked")
        self.assertEqual({row["selector"] for row in result["unresolved"]}, set(selectors))

    def test_additions_cannot_bypass_registry_coverage_or_runtime_only_scope(self):
        addition = {"selector": "std740", "strength": "mandatory", "basis": "synthetic clause"}
        selection, _ = self.selection(["metadata_naming"], additional=[addition])
        self.assertEqual(selection["status"], "unavailable")
        self.assertNotIn("digest", selection)
        self.rejected("select_yaxunit_requirements", "runtime-only", target=self.target, operation="report",
                      mechanisms=[], additionalRequirements=[addition])
        authoring = self.call("select_yaxunit_requirements", target=self.target, operation="design",
                             mechanisms=[], additionalRequirements=[addition])
        self.assertIn("std740", authoring["mandatory"])
        Draft202012Validator(self.tools["select_yaxunit_requirements"]["outputSchema"]).validate(authoring)

    def test_empty_additions_preserve_existing_protocol_2_selections(self):
        args = {"target": self.target, "artifact": "bsl", "operation": "change",
                "mechanisms": [], "detection": self.detection()}
        original = self.call("select_1c_requirements", **args)
        empty = self.call("select_1c_requirements", **args, additionalRequirements=[])
        self.assertEqual(original, empty)
        self.assertNotIn("additionalRequirements", empty)
        current = {**args, "sourceRef": args["detection"]["sourceRef"]}
        self.assertEqual(self.call("validate_compliance", phase="result", selection=original,
            ledger=self.ledger(original), current=current)["status"], "ledger_valid")

    def test_registry_rejects_empty_selectors_and_unknown_coverage(self):
        registry = json.loads((ROOT / "policy/registry.json").read_text(encoding="utf-8"))
        bad = copy.deepcopy(registry)
        bad["oneC"]["rules"][0]["selectors"] = []
        unknown = copy.deepcopy(registry)
        unknown["yaxunit"]["rules"][0]["covers"] = ["unregistered_mechanism"]
        for index, invalid in enumerate((bad, unknown)):
            with self.subTest(case=index), tempfile.TemporaryDirectory() as directory:
                path = Path(directory) / "registry.json"
                path.write_text(json.dumps(invalid), encoding="utf-8")
                result = subprocess.run(["node", "--input-type=module", "-e",
                    "import {loadRegistry} from './policy/selector.mjs'; loadRegistry(process.argv[1]);", str(path)],
                    cwd=ROOT, capture_output=True, encoding="utf-8")
                self.assertNotEqual(result.returncode, 0)

    def test_design_and_review_cannot_invent_the_other_phase(self):
        for operation, accepted, rejected in (("design", "proposal", "result"), ("review", "result", "proposal")):
            with self.subTest(operation=operation):
                selection = self.call("select_1c_requirements", target=self.target, operation=operation,
                                      artifact="bsl", mechanisms=[], detection=self.detection())
                current = {"target": self.target, "operation": operation, "artifact": "bsl",
                           "sourceRef": "EDT:synthetic:hash-A", "mechanisms": [], "detection": self.detection()}
                self.assertEqual(self.call("validate_compliance", phase=accepted, selection=selection,
                    ledger=self.ledger(selection), current=current)["status"], "ledger_valid")
                self.rejected("validate_compliance", "phase does not match", phase=rejected,
                              selection=selection, ledger=self.ledger(selection), current=current)

    def test_prepared_package_ships_and_launches_policy(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            destination = root / "package"
            build(destination, root / "state", sys.executable)
            plugin = destination / "plugins/1c-ai-core"
            canonical = json.loads((ROOT / "mcp.json").read_text(encoding="utf-8"))["mcpServers"]
            packaged = json.loads((plugin / "mcp.json").read_text(encoding="utf-8"))["mcpServers"]
            self.assertEqual(set(packaged), set(canonical))
            self.assertIn("1c-ai-settings", packaged)
            self.assertIn("lazy_mcp.py", " ".join(packaged["edt"]["args"]))
            self.assertEqual(json.loads((plugin / "plugin.json").read_text(encoding="utf-8"))["extensions"]["com.openai"]["hooks"], "./hooks/hooks.json")
            for development_path in (".git", ".venv", ".work", ".build", "tools", "tests", "packaging"):
                self.assertFalse((plugin / development_path).exists(), development_path)
            for relative in ("policy/default.json", "policy/actions.mjs", "scripts/action_policy.py",
                             "scripts/vanessa.py", "vanessa/vanessa.mjs", "vanessa/receipt.mjs",
                             "mcp/http-client.mjs", "schemas/vanessa-runtime.schema.json", "hooks/hooks.json",
                             "hooks/guard.mjs", "scripts/guard.py", "scripts/project_context.py"):
                self.assertTrue((plugin / relative).is_file(), relative)
            entry = json.loads((plugin / "mcp.json").read_text(encoding="utf-8"))["mcpServers"]["policy"]
            self.assertEqual(entry, binding(settings(), plugin))
            with McpClient([entry["command"], *entry["args"]], plugin) as client:
                client.initialize()
                result = client.call("select_yaxunit_requirements", {"target": self.target, "operation": "report", "mechanisms": []})
                self.assertEqual(result["structuredContent"]["status"], "not_applicable")
                self.assertNotIn("digest", result["structuredContent"])
                result = client.call("check_action", {"effects": ["database"], "scope": "fixture/base", "authorizations": []})
                self.assertEqual(result["structuredContent"]["status"], "requires_user_agreement")
            # Exercise the installed settings server with exactly its emitted env.
            entry = packaged["1c-ai-settings"]
            command = [entry["command"], *[arg.replace("${PLUGIN_ROOT}", str(plugin)) for arg in entry["args"]]]
            with McpClient(command, plugin, {**os.environ, **entry["env"]}) as client:
                client.initialize()
                read = client.call("settings.read", {})["structuredContent"]
                self.assertEqual(read["values"]["projectRoot"], "")
                client.call("settings.update", {"set": {"projectRoot": str(root), "edtUrl": "http://127.0.0.1:19765/mcp"}})
                self.assertEqual(client.call("settings.read", {})["structuredContent"]["values"]["edtUrl"],
                                 "http://127.0.0.1:19765/mcp")

    def test_package_preparation_preserves_legacy_yaml_and_writes_canonical_json(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve(); state = root / "state"
            old = state / "settings.yaml"
            dump({"mcp": {"required": {"edt": {"url": "http://127.0.0.1:19766/mcp"}}}}, old)
            before = old.read_bytes()
            result = build(root / "package", state, sys.executable)
            self.assertEqual(Path(result["settings"]), state / "settings.json")
            self.assertEqual(json.loads((state / "settings.json").read_text())["mcp"]["required"]["edt"]["url"],
                             "http://127.0.0.1:19766/mcp")
            self.assertEqual(old.read_bytes(), before)

    def test_installed_hook_uses_its_prepared_python_without_mcp_environment(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve(); project = root / "project"; project.mkdir()
            profile = load(ROOT / "profiles/generic-1c/profile.yaml")
            profile["repositories"] = [{"id": "product", "path": ".", "alias": "product"}]
            profile["roots"] = {"source": ["src"], "protected": ["src"]}
            dump(profile, project / ".ai/project.yaml")
            destination = root / "package"
            build(destination, root / "state", sys.executable)
            plugin = destination / "plugins/1c-ai-core"
            env = {key: value for key, value in os.environ.items() if not key.startswith("EDT_AI_")}
            env["CODEX_HOME"] = str(root / "empty-codex-home")
            for path, denied in (("docs/readme.md", False), ("src/Module.bsl", True)):
                result = subprocess.run(["node", str(plugin / "hooks/guard.mjs")], env=env,
                    input=json.dumps({"cwd": str(project), "tool_name": "Read", "tool_input": {"path": path}}),
                    capture_output=True, encoding="utf-8")
                self.assertEqual(result.returncode, 0, result.stderr)
                decision = json.loads(result.stdout).get("hookSpecificOutput", {}).get("permissionDecision")
                self.assertEqual(decision, "deny" if denied else None)
            self.assertFalse((root / "empty-codex-home").exists())

    def test_doctor_reports_policy_probe_failure_without_claiming_readiness(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            profile = load(ROOT / "profiles/generic-1c/profile.yaml")
            profile["repositories"] = [{"id": "demo", "path": ".", "alias": "demo"}]
            dump(profile, root / ".ai/project.yaml")
            with patch("policy_runtime.smoke", side_effect=RuntimeError("policy unavailable")), \
                 patch("doctor.smoke", return_value={"component": "synthetic"}):
                report = inspect(root, settings(), root / "state", live=True, managed_only=True)
            self.assertEqual(report["status"], "error")
            self.assertIn("policy: policy unavailable", report["errors"])
            self.assertEqual(report["full_development_readiness"], "not_verified")


if __name__ == "__main__":
    unittest.main()
