import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { fixture, session, ROOT } from "./helpers.mjs";
import { settings } from "../scripts/common.mjs";
import { smoke } from "../scripts/policy_runtime.mjs";
import { Ajv2020 } from "../vendor/deps.mjs";
import { loadRegistry } from "../policy/selector.mjs";
import { validateSchema } from "../policy/schema.mjs";

async function policy(t) {
  const f = fixture(t),
    client = await session(t, "policy/read-only-mcp.mjs", [], f),
    tools = Object.fromEntries(
      (await client.request("tools/list")).tools.map((tool) => [
        tool.name,
        tool,
      ]),
    );
  const target = "synthetic/project/Module.Method",
    mechanisms =
      tools.detect_1c_mechanisms.inputSchema.properties.assessments
        .propertyNames.enum;
  const call = async (name, args = {}) =>
    (await client.call(name, args)).structuredContent;
  const rejected = async (name, args, pattern = /./s) => {
    const result = await client.request("tools/call", {
      name,
      arguments: args,
    });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, pattern);
  };
  const detection = async (present = [], sourceRef = "EDT:synthetic:hash-A") =>
    call("detect_1c_mechanisms", {
      sourceRef,
      assessments: Object.fromEntries(
        mechanisms.map((name) => [
          name,
          {
            status: present.includes(name) ? "present" : "absent",
            evidence: "synthetic scoped EDT context inspected",
          },
        ]),
      ),
      format: "compact",
    });
  const selection = async (
    explicit = [],
    present = [],
    artifact = "bsl",
    additionalRequirements = [],
    operation = "change",
  ) => {
    const d = await detection(present),
      current = {
        target,
        artifact,
        operation,
        mechanisms: explicit,
        detection: d,
        sourceRef: d.sourceRef,
        additionalRequirements,
      };
    const { sourceRef, ...args } = current;
    return [await call("select_1c_requirements", args), current];
  };
  const ledger = (selection, source_ref = "EDT:synthetic:hash-A") =>
    [...selection.mandatory, ...selection.recommended].map((selector) => ({
      selector,
      selection_digest: selection.digest,
      target: selection.target,
      source_ref,
      status: "passed",
      evidence: "synthetic exact normative clause and target checked",
    }));
  return {
    f,
    client,
    tools,
    target,
    call,
    rejected,
    detection,
    selection,
    ledger,
  };
}
test("canonical policy connection exposes full and compact read-only workflows", async (t) => {
  const p = await policy(t);
  assert.equal(Object.keys(p.tools).length, 8);
  assert.ok(
    Object.values(p.tools).every((tool) => tool.annotations.readOnlyHint),
  );
  assert.equal(
    (await smoke(settings())).evidence,
    "synthetic_protocol_checks_only",
  );
});

test("shared mechanism schema references preserve enum validation for every input array", async t => {
  const p = await policy(t), detection = await p.detection();
  const assessments = Object.fromEntries(p.tools.detect_1c_mechanisms.inputSchema.properties.assessments.propertyNames.enum.map(name => [name, { status: "absent", evidence: "fixture" }]));
  const registry = loadRegistry();
  for (const [name, mechanism, base] of [
    ["select_1c_requirements", registry.oneC.mechanisms[0], { target: p.target, artifact: "bsl", operation: "change", mechanisms: [], detection }],
    ["assess_1c_requirements", registry.oneC.mechanisms[0], { target: p.target, artifact: "bsl", operation: "change", mechanisms: [], sourceRef: "fixture", assessments }],
    ["select_yaxunit_requirements", registry.yaxunit.mechanisms[0], { target: p.target, operation: "design", mechanisms: [] }],
  ]) {
    const schema = p.tools[name].inputSchema;
    const ajv = new Ajv2020({ strict: false }).compile(schema);
    for (const field of ["mechanisms", "classifiedMechanisms", "detectedMechanisms", "unknownMechanisms"]) {
      const valid = { ...base, [field]: [mechanism] }, invalid = { ...base, [field]: ["not-a-mechanism"] };
      assert.equal(ajv(valid), true, `${name}/${field}`);
      assert.doesNotThrow(() => validateSchema(schema, valid));
      assert.equal(ajv(invalid), false, `${name}/${field}`);
      assert.throws(() => validateSchema(schema, invalid));
    }
  }
});

test("session references reduce retransmission while retaining all compliance and phase checks", async t => {
  const p = await policy(t), sourceRef = "EDT:proposal:hash-a";
  const assessments = Object.fromEntries(p.tools.detect_1c_mechanisms.inputSchema.properties.assessments.propertyNames.enum.map(name => [name,{status:"absent",evidence:"synthetic scoped transition inspected"}]));
  const compact = await p.call("assess_1c_requirements",{target:p.target,artifact:"bsl",operation:"change",mechanisms:[],sourceRef,assessments});
  const args={phase:"proposal",selectionRef:compact.selectionRef,current:{target:p.target,artifact:"bsl",operation:"change",sourceRef,mechanisms:[],detectionRef:compact.detectionRef},rows:[...compact.selection.mandatory,...compact.selection.recommended].map(selector=>[selector,"unverified","Synthetic fixture, no normative truth established"])};
  assert.equal((await p.call("validate_compliance_ref",args)).status,"blocked");
  await p.rejected("validate_compliance_ref",{...args,current:{...args.current,sourceRef:"EDT:result:hash-b"}},/sourceRef differs/);
  await p.rejected("validate_compliance_ref",{...args,current:{...args.current,target:"another/project"}},/target differs/);
  await p.rejected("validate_compliance_ref",{...args,rows:[]},/coverage/);
  const other=await policy(t);await other.rejected("validate_compliance_ref",args,/another session/);
  const detection=await p.call("detect_1c_mechanisms",{sourceRef,assessments});
  const full={phase:args.phase,selection:compact.selection,current:{...args.current,detection},ledger:args.rows.map(([selector,status,evidence])=>({selector,status,evidence,selection_digest:compact.selection.digest,target:p.target,source_ref:sourceRef}))};
  delete full.current.detectionRef;
  assert.ok(Buffer.byteLength(JSON.stringify(args)) < Buffer.byteLength(JSON.stringify(full)) / 2);
  assert.deepEqual(await p.call("validate_compliance_ref",args),await p.call("validate_compliance",full));
});
test("action agreement reuses only exact scope and nonblank evidence", async (t) => {
  const p = await policy(t),
    request = {
      effects: ["launch", "database"],
      scope: "fixture/base-a",
      authorizations: [],
    };
  assert.equal(
    (await p.call("check_action", request)).status,
    "requires_user_agreement",
  );
  request.authorizations = [
    {
      effects: request.effects,
      scope: request.scope,
      evidence: "synthetic actual-user-turn reference",
    },
  ];
  for (let i = 0; i < 2; i++)
    assert.equal(
      (await p.call("check_action", request)).status,
      "within_declared_scope",
    );
  request.scope = "fixture/base-b";
  assert.equal(
    (await p.call("check_action", request)).status,
    "requires_user_agreement",
  );
  request.authorizations[0].evidence = " ";
  await p.rejected("check_action", request, /nonblank/);
});
test("query selectors deduplicate without weakening recommendations; metadata rights avoid BSL rules", async (t) => {
  const p = await policy(t),
    [selection] = await p.selection(
      ["existence_query"],
      ["query_text", "query_in_loop"],
    );
  assert.ok(selection.mandatory.includes("std437"));
  assert.ok(selection.mandatory.includes("std438"));
  assert.ok(selection.recommended.includes("std436"));
  assert.ok(!selection.mandatory.includes("std436"));
  assert.equal(selection.mandatory.filter((x) => x === "std437").length, 1);
  const [same] = await p.selection(
    ["query_in_loop", "existence_query"],
    ["query_in_loop", "query_text"],
  );
  assert.equal(same.digest, selection.digest);
  const [rights, current] = await p.selection(
    [],
    ["access_rights"],
    "metadata",
  );
  assert.deepEqual(rights.mandatory, ["std689"]);
  assert.equal(
    (
      await p.call("validate_compliance", {
        phase: "proposal",
        selection: rights,
        ledger: p.ledger(rights),
        current,
      })
    ).status,
    "ledger_valid",
  );
});
test("incomplete/unknown/contradictory mechanisms and raw source cannot establish applicability", async (t) => {
  const p = await policy(t),
    common = {
      target: p.target,
      artifact: "bsl",
      operation: "change",
      mechanisms: [],
    };
  const unknown = await p.call("detect_1c_mechanisms", {
    sourceRef: "unknown",
    assessments: {},
  });
  await p.rejected(
    "select_1c_requirements",
    { ...common, detection: unknown },
    /incomplete/,
  );
  const d = await p.detection();
  await p.rejected(
    "select_1c_requirements",
    { ...common, mechanisms: ["explicit_transaction"], detection: d },
    /contradicts detection absence/,
  );
  await p.rejected("select_1c_requirements", {
    ...common,
    mechanisms: ["unregistered"],
    detection: d,
  });
  await p.rejected(
    "select_1c_requirements",
    { ...common, artifact: "query", detection: d },
    /query_text presence evidence/,
  );
  for (const sourceText of [
    "// SELECT",
    'Log("Экспорт");',
    "Данные = ОбменФайлами.Выгрузить();",
  ])
    await p.rejected(
      "detect_1c_mechanisms",
      { sourceRef: "fixture", assessments: {}, sourceText },
      /unknown property sourceText/,
    );
  d.coverage.pop();
  await p.rejected(
    "select_1c_requirements",
    { ...common, detection: d },
    /too few/,
  );
});
for (const artifact of ["metadata", "bsl"])
  test(
    "missing registry coverage is unavailable and cannot pass: " + artifact,
    async (t) => {
      const p = await policy(t),
        [selection, current] = await p.selection(
          artifact === "bsl" ? ["metadata_naming"] : [],
          [],
          artifact,
        );
      assert.equal(selection.status, "unavailable");
      assert.ok(!selection.digest);
      await p.rejected("validate_compliance", {
        phase: "proposal",
        selection,
        current,
        ledger: [],
      });
    },
  );
for (const [operation, accepted, refused] of [
  ["design", "proposal", "result"],
  ["review", "result", "proposal"],
  ["change", "proposal", null],
])
  test("normative phase matches operation " + operation, async (t) => {
    const p = await policy(t),
      [selection, current] = await p.selection(
        ["method_contract"],
        [],
        "bsl",
        [],
        operation,
      ),
      args = { selection, current, ledger: p.ledger(selection) };
    assert.equal(
      (await p.call("validate_compliance", { ...args, phase: accepted }))
        .status,
      "ledger_valid",
    );
    if (refused)
      await p.rejected(
        "validate_compliance",
        { ...args, phase: refused },
        /phase does not match/,
      );
    if (operation === "change") {
      assert.equal(
        (await p.call("validate_compliance", { ...args, phase: "result" }))
          .status,
        "ledger_valid",
      );
      await p.rejected("validate_compliance", args, /missing-phase/);
      const { current: omitted, ...without } = args;
      await p.rejected(
        "validate_compliance",
        { ...without, phase: "result" },
        /missing current/,
      );
    }
  });
test("ledgers reject incomplete/duplicate/extra/unsubstantiated entries and invalid mandatory deviations", async (t) => {
  const p = await policy(t),
    [selection, current] = await p.selection(),
    ledger = p.ledger(selection),
    variants = [
      ledger.slice(1),
      [...ledger, ledger[0]],
      [...ledger, { ...ledger[0], selector: "std999999" }],
    ];
  for (const [key, value] of [
    ["status", "compliant"],
    ["status", "satisfied"],
    ["evidence", " "],
    ["selection_digest", "old"],
    ["invented", "value"],
    ["reason", "passing rows cannot have reasons"],
  ]) {
    const changed = structuredClone(ledger);
    changed[0][key] = value;
    variants.push(changed);
  }
  const deviated = structuredClone(ledger);
  Object.assign(deviated[0], {
    status: "deviated",
    reason: "does not excuse mandatory",
  });
  variants.push(deviated);
  for (const invalid of variants)
    await p.rejected(
      "validate_compliance",
      { phase: "proposal", selection, current, ledger: invalid },
      /proposal:/,
    );
});
test("recommendation deviation requires a reason; failed/unverified rows return structured blocked results", async (t) => {
  const p = await policy(t),
    [selection, current] = await p.selection(
      [],
      ["query_text", "query_in_loop"],
    ),
    ledger = p.ledger(selection),
    row = ledger.find((row) => row.selector === "std436");
  row.status = "deviated";
  await p.rejected("validate_compliance", {
    phase: "result",
    selection,
    current,
    ledger,
  });
  row.reason = "synthetic exact clause and bounded workload";
  assert.equal(
    (
      await p.call("validate_compliance", {
        phase: "result",
        selection,
        current,
        ledger,
      })
    ).status,
    "ledger_valid",
  );
  for (const strength of ["mandatory", "recommended"])
    for (const status of ["failed", "unverified"]) {
      const ledger = p.ledger(selection),
        selector = selection[strength][0];
      ledger.find((row) => row.selector === selector).status = status;
      const result = await p.call("validate_compliance", {
        phase: "result",
        selection,
        current,
        ledger,
      });
      assert.equal(result.status, "blocked");
      assert.deepEqual(result.unresolved, [{ selector, strength, status }]);
    }
});
test("selection, context, mechanism and source tampering require reselection or current evidence", async (t) => {
  const p = await policy(t),
    [selection, current] = await p.selection(["method_contract"]);
  for (const [key, value] of [
    ["registryVersion", "2000-01-01.1"],
    ["digest", "tampered"],
    ["mandatory", []],
    ["artifact", "query"],
    ["mechanisms", []],
    ["matchedRows", []],
  ])
    await p.rejected("validate_compliance", {
      phase: "result",
      selection: { ...selection, [key]: value },
      current,
      ledger: p.ledger(selection),
    });
  for (const [key, value] of [
    ["target", "other"],
    ["artifact", "metadata"],
    ["operation", "review"],
    ["sourceRef", "old"],
    ["mechanisms", []],
  ])
    await p.rejected("validate_compliance", {
      phase: "result",
      selection,
      current: { ...current, [key]: value },
      ledger: p.ledger(selection),
    });
  current.sourceRef = current.detection.sourceRef = "EDT:synthetic:hash-B";
  await p.rejected(
    "validate_compliance",
    { phase: "result", selection, current, ledger: p.ledger(selection) },
    /source_ref differs/,
  );
  assert.equal(
    (
      await p.call("validate_compliance", {
        phase: "result",
        selection,
        current,
        ledger: p.ledger(selection, current.sourceRef),
      })
    ).status,
    "ledger_valid",
  );
});
test("query helpers and YaXUnit do not invent unrelated mechanisms", async (t) => {
  const p = await policy(t);
  for (const [explicit, present, required] of [
    [
      [],
      ["query_result_processing"],
      "corporate:work:query-conventions:overview#Обработка результата",
    ],
    [["query_parameters"], [], "std437"],
    [[], ["query_in_loop"], "std436"],
  ]) {
    const [selection, current] = await p.selection(explicit, present);
    assert.ok(!selection.mechanisms.includes("query_text"));
    assert.ok(
      [...selection.mandatory, ...selection.recommended].includes(required),
    );
    assert.equal(
      (
        await p.call("validate_compliance", {
          phase: "result",
          selection,
          current,
          ledger: p.ledger(selection),
        })
      ).status,
      "ledger_valid",
    );
  }
  const yax = await p.call("select_yaxunit_requirements", {
    target: p.target,
    operation: "change",
    mechanisms: ["transactional_test", "nontrivial_predicate"],
  });
  assert.ok(!yax.mechanisms.includes("persistent_data"));
  assert.ok(!yax.mechanisms.includes("database_assertion"));
  assert.ok(yax.mandatory.includes("yaxunit:patterns:data-isolation"));
});
for (const operation of ["run", "report", "design", "create"])
  test("YaXUnit authoring/run/report scope: " + operation, async (t) => {
    const p = await policy(t),
      selection = await p.call("select_yaxunit_requirements", {
        target: p.target,
        operation,
        mechanisms: ["test_module", "registration", "transactional_test"],
      });
    if (["run", "report"].includes(operation)) {
      assert.equal(selection.status, "not_applicable");
      assert.ok(!selection.digest);
      assert.ok(!selection.mandatory);
      await p.rejected("validate_compliance", {
        phase: "result",
        selection,
        ledger: [],
        current: {
          target: p.target,
          artifact: "yaxunit",
          operation,
          sourceRef: "fixture",
          mechanisms: [],
        },
      });
    } else {
      assert.ok(
        selection.mandatory.includes("yaxunit:patterns:authoring-baseline"),
      );
      assert.ok(selection.mandatory.includes("yaxunit:patterns:naming"));
      assert.ok(
        selection.mandatory.includes(
          "yaxunit:patterns:registration-and-parameters",
        ),
      );
    }
  });
test("v8std additions share the normative ledger and cannot weaken registry strength or coverage", async (t) => {
  const p = await policy(t),
    additions = [
      {
        selector: "std740",
        strength: "mandatory",
        basis: "synthetic exact secret storage clause",
      },
      {
        selector: "std703",
        strength: "recommended",
        basis: "synthetic exact modal clause",
      },
    ],
    [selection, current] = await p.selection([], [], "bsl", additions);
  assert.ok(selection.mandatory.includes("std740"));
  assert.ok(selection.recommended.includes("std703"));
  const [reordered] = await p.selection(
    [],
    [],
    "bsl",
    [...additions].reverse(),
  );
  assert.equal(reordered.digest, selection.digest);
  const ledger = p.ledger(selection);
  await p.rejected(
    "validate_compliance",
    {
      phase: "proposal",
      selection,
      current,
      ledger: ledger.filter((row) => row.selector !== "std740"),
    },
    /coverage mismatch/,
  );
  for (const changed of [
    [],
    [additions[0]],
    [{ ...additions[0], strength: "recommended" }, additions[1]],
    [{ ...additions[0], basis: "different clause" }, additions[1]],
  ])
    await p.rejected(
      "validate_compliance",
      {
        phase: "result",
        selection,
        current: { ...current, additionalRequirements: changed },
        ledger,
      },
      /reselect requirements/,
    );
  const [baseline] = await p.selection([], ["query_in_loop"]),
    mandatory = baseline.mandatory[0],
    recommended = baseline.recommended[0];
  const [stronger] = await p.selection([], ["query_in_loop"], "bsl", [
    { selector: mandatory, strength: "recommended", basis: "weaker request" },
    { selector: recommended, strength: "mandatory", basis: "stronger clause" },
  ]);
  assert.ok(stronger.mandatory.includes(mandatory));
  assert.ok(stronger.mandatory.includes(recommended));
  assert.ok(!stronger.recommended.includes(recommended));
  await p.rejected(
    "select_yaxunit_requirements",
    {
      target: p.target,
      operation: "report",
      mechanisms: [],
      additionalRequirements: additions,
    },
    /runtime-only/,
  );
});
test("invalid/additional nonnormative selectors, blank evidence, duplicates and fields are rejected", async (t) => {
  const p = await policy(t),
    good = {
      selector: "std740",
      strength: "mandatory",
      basis: "synthetic clause",
    },
    detection = await p.detection(),
    args = {
      target: p.target,
      artifact: "bsl",
      operation: "change",
      mechanisms: [],
      detection,
    };
  for (const item of [
    { ...good, basis: " " },
    { ...good, strength: "optional" },
    ...[
      "bslls:UsingModalWindows",
      "vanessa:mcp:run_tests",
      "yaxunit:api:test-builder:overview",
      "v8cs:secure-password-storage",
    ].map((selector) => ({ ...good, selector })),
    { ...good, score: 1 },
  ])
    await p.rejected(
      "select_1c_requirements",
      { ...args, additionalRequirements: [item] },
      /additionalRequirements/,
    );
  await p.rejected(
    "select_1c_requirements",
    { ...args, additionalRequirements: [good, good] },
    /duplicate additional/,
  );
  assert.deepEqual(
    await p.call("select_1c_requirements", args),
    await p.call("select_1c_requirements", {
      ...args,
      additionalRequirements: [],
    }),
  );
});
test("corporate, Vanessa and YaXUnit normative additions are required in one ledger", async (t) => {
  const p = await policy(t),
    selectors = [
      "corporate:work:bsl-change-policy:overview#Диагностики и ревью",
      "yaxunit:patterns:data-isolation",
      "vanessa:patterns:steps-assertions",
    ],
    additional = selectors.map((selector) => ({
      selector,
      strength: "mandatory",
      basis: "synthetic exact clause applicability, no real project acceptance",
    })),
    [selection, current] = await p.selection([], [], "bsl", additional);
  for (const selector of selectors) {
    assert.ok(selection.mandatory.includes(selector));
    await p.rejected(
      "validate_compliance",
      {
        phase: "proposal",
        selection,
        current,
        ledger: p.ledger(selection).filter((row) => row.selector !== selector),
      },
      /coverage mismatch/,
    );
  }
});
test("public input/output schemas validate independently with Ajv and registry rejects broken coverage", async (t) => {
  const p = await policy(t),
    ajv = new Ajv2020({ strict: false });
  for (const tool of Object.values(p.tools)) {
    ajv.compile(tool.inputSchema);
    if (tool.outputSchema) ajv.compile(tool.outputSchema);
  }
  const [selection, current] = await p.selection(),
    results = [
      ["detect_1c_mechanisms", await p.detection()],
      ["select_1c_requirements", selection],
      ["select_1c_requirements", (await p.selection([], [], "metadata"))[0]],
      [
        "validate_compliance",
        await p.call("validate_compliance", {
          phase: "result",
          selection,
          current,
          ledger: p.ledger(selection),
        }),
      ],
    ];
  for (const [name, result] of results)
    assert.ok(ajv.compile(p.tools[name].outputSchema)(result));
  const registry = JSON.parse(
    fs.readFileSync(path.join(ROOT, "policy/registry.json"), "utf8"),
  );
  registry.oneC.rules[0].selectors = [];
  const file = path.join(p.f.base, "registry.json");
  fs.writeFileSync(file, JSON.stringify(registry));
  assert.throws(() => loadRegistry(file));
});
test("first query is assessed in the projected transition and result evidence cannot reuse proposal refs", async (t) => {
  const p = await policy(t),
    detection = await p.detection(["query_text"], "synthetic:proposed-query"),
    args = {
      target: p.target,
      artifact: "bsl",
      operation: "change",
      mechanisms: ["query_text"],
      detection,
    },
    selection = await p.call("select_1c_requirements", args),
    proposal = { ...args, sourceRef: detection.sourceRef };
  assert.ok(selection.mandatory.includes("std437"));
  assert.equal(
    (
      await p.call("validate_compliance", {
        phase: "proposal",
        selection,
        current: proposal,
        ledger: p.ledger(selection, proposal.sourceRef),
      })
    ).status,
    "ledger_valid",
  );
  const result = {
    ...proposal,
    sourceRef: "synthetic:actual-query",
    detection: await p.detection(["query_text"], "synthetic:actual-query"),
  };
  await p.rejected(
    "validate_compliance",
    {
      phase: "result",
      selection,
      current: result,
      ledger: p.ledger(selection, proposal.sourceRef),
    },
    /source_ref differs/,
  );
  assert.equal(
    (
      await p.call("validate_compliance", {
        phase: "result",
        selection,
        current: result,
        ledger: p.ledger(selection, result.sourceRef),
      })
    ).status,
    "ledger_valid",
  );
});
for (const [operation, mechanism, selector] of [
  ["create", "metadata_naming", "std474"],
  ["change", "metadata_delete", "std534"],
])
  test(
    "metadata transition remains scoped before/after " + mechanism,
    async (t) => {
      const p = await policy(t),
        detection = await p.detection(
          operation === "create" ? [] : [mechanism],
          "synthetic:transition",
        ),
        args = {
          target: p.target,
          artifact: "metadata",
          operation,
          mechanisms: [mechanism],
          detection,
        },
        selection = await p.call("select_1c_requirements", args),
        current = { ...args, sourceRef: detection.sourceRef };
      assert.ok(selection.mandatory.includes(selector));
      assert.equal(
        (
          await p.call("validate_compliance", {
            phase: "proposal",
            selection,
            current,
            ledger: p.ledger(selection, current.sourceRef),
          })
        ).status,
        "ledger_valid",
      );
    },
  );
test("review keeps unresolved result evidence blocked and design is reselected for implementation", async (t) => {
  const p = await policy(t),
    [selection, current] = await p.selection([], [], "bsl", [], "review"),
    ledger = p.ledger(selection);
  ledger[0].status = "unverified";
  assert.equal(
    (
      await p.call("validate_compliance", {
        phase: "result",
        selection,
        current,
        ledger,
      })
    ).status,
    "blocked",
  );
  const [design, proposal] = await p.selection([], [], "bsl", [], "design");
  await p.rejected(
    "validate_compliance",
    {
      phase: "proposal",
      selection: design,
      current: { ...proposal, operation: "change" },
      ledger: p.ledger(design),
    },
    /operation/,
  );
});
