import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { fixture } from "./helpers.mjs";
import { folder_action, windows_folder_api } from "../scripts/settings_folder.mjs";

test("native folder dialog initializes for Unicode paths without displaying a window", { skip: process.platform !== "win32" }, t => {
  const f = fixture(t);
  const api = windows_folder_api(), dialog = api.createDialog(f.root);
  dialog.dispose();
});

test("opening a folder rejects files and missing directories before launching Explorer", { skip: process.platform !== "win32" }, async t => {
  const f = fixture(t);
  await assert.rejects(folder_action("open", fileURLToPath(import.meta.url)), /папк|directory|ENOENT/i);
  await assert.rejects(folder_action("open", path.join(f.root, "missing")), /папк|directory|ENOENT/i);
});
