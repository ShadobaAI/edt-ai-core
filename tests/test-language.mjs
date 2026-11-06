import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { ROOT, parse, check_schema, validate_url } from "../scripts/common.mjs";
import { locate_project } from "../scripts/project_paths.mjs";
import { safe_error_message } from "../scripts/diagnostics.mjs";
import { fixture } from "./helpers.mjs";

function files(directory) {
  return fs.readdirSync(path.join(ROOT, directory), { withFileTypes: true }).flatMap(entry => {
    const file = directory + "/" + entry.name;
    return entry.isDirectory() ? files(file) : [file];
  });
}
const cyrillic = /[А-Яа-яЁё]/;
const productHeadings = new Set(["1C AI Core", "v8std", "OpenViking", "YaXUnit", "Vanessa"]);
// Exact API tokens and quoted control labels are data, not Russian instructions.
const technicalText = {
  "skills/1c-code-change/SKILL.md": ["`Попытка/Исключение`"],
  "skills/1c-code-index/SKILL.md": ["`Если`"],
  "skills/yaxunit-tests/SKILL.md": ["`ЮТест.Данные()`", "`ЮТПодражатель`"],
  "skills/vanessa-ui-tests/references/cli-workflow.md": ["“Перейти в Vanessa Editor”"],
  "skills/edt-ai-core/SKILL.md": ["“Настройки проекта”", "“Настройки”"],
};

test("every skill instruction is English and user-facing skill metadata is Russian", () => {
  for (const file of files("skills")) {
    let text = fs.readFileSync(path.join(ROOT, file), "utf8");
    if (file.endsWith("/agents/openai.yaml")) {
      const { interface: display, ...instructions } = parse(text);
      for (const field of ["display_name", "short_description", "default_prompt"])
        assert.match(display[field], cyrillic, file + ": " + field);
      assert.doesNotMatch(JSON.stringify(instructions), cyrillic, file);
      continue;
    }
    for (const token of technicalText[file] || []) text = text.replaceAll(token, "");
    assert.doesNotMatch(text, cyrillic, file);
  }
});

test("user documentation headings and settings schema explanations are Russian", () => {
  for (const file of ["README.md", ...files("docs").filter(file => file.endsWith(".md"))]) {
    const text = fs.readFileSync(path.join(ROOT, file), "utf8").replace(/^```[^\n]*\n[\s\S]*?^```[^\n]*$/gm, "");
    for (const heading of text.matchAll(/^#{1,6}\s+(.+)$/gm))
      if (!productHeadings.has(heading[1].trim()) && !/^`[A-Za-z0-9_.-]+`$/.test(heading[1].trim())) assert.match(heading[1], cyrillic, file);
  }
  for (const file of files("schemas")) {
    const inspect = value => {
      if (!value || typeof value !== "object") return;
      for (const [key, child] of Object.entries(value)) {
        if (["title", "description"].includes(key) && typeof child === "string") assert.match(child, cyrillic, file);
        else inspect(child);
      }
    };
    inspect(JSON.parse(fs.readFileSync(path.join(ROOT, file), "utf8")));
  }
});

test("profile validation and safe user errors are Russian without changing diagnostic codes", t => {
  const f = fixture(t);
  for (const operation of [() => locate_project(f.root), () => validate_url("https://user:secret@example.invalid"),
    () => check_schema({ schema_version: "0.2", project: { id: 1 } }, "project-profile.schema.json")])
    assert.throws(operation, error => { assert.match(safe_error_message(error), cyrillic); return true; });
  const message = safe_error_message({ remote: true, code: -32000, message: "private upstream text" });
  assert.match(message, /Внешний сервер MCP.*RPC -32000/);
  assert.doesNotMatch(message, /private upstream text/);
  assert.match(safe_error_message({ outcomeUnknown: true, message: "MCP connection closed" }), /Исход операции неизвестен/);
});
