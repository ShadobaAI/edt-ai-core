import fs from "node:fs";
import path from "node:path";
import { test, expect } from "@playwright/test";
import { canonical_yaml, dump, load } from "../../scripts/common.mjs";
import { startHost } from "./host.mjs";

let host;
test.beforeEach(async ({ page }) => {
  host = await startHost();
  await page.goto(host.url);
  await expect(page.frameLocator("#app").locator("#headerProjectName")).toHaveText("Product");
});
test.afterEach(async ({ page }) => {
  await page.close();
  if (host) await host.close();
  host = null;
});

async function openEdt(page) {
  const app = page.frameLocator("#app");
  await app.getByRole("button", { name: "Открыть настройки EDT" }).click();
  await expect(app.locator("#componentDialog")).toBeVisible();
  return app;
}

function seedVanessa() {
  const shared = path.join(host.project, ".ai/project.yaml"), file = path.join(host.project, ".ai/vanessa.local.json");
  const project = load(shared);
  project.testing.vanessa = true;
  project.testing.vanessa_config = { repository_id: "product", runtime_profile: ".ai/vanessa.local.json", features: "features", results: "results", server_name: "vanessa" };
  dump(project, shared);
  const user = name => ({ name, password: "private-secret", interface: "taxi" });
  fs.writeFileSync(file, JSON.stringify({ version: 1, id: "ui-tests", projectRoot: "..", platform: "../1cv8c.exe",
    runtime: { epf: "../vanessa.epf" }, manager: { infobase: { type: "server", server: "localhost", database: "manager" }, user: user("Manager") },
    infobase: { type: "file", path: "../base" }, users: { TestClient: user("Client") },
    mcp: { serverName: "vanessa", url: "http://127.0.0.1:19876/mcp", port: 19876 }, features: "../features", results: "../results" }));
  return file;
}

test("edits the local Vanessa profile through grouped fields and reviews the launch target", async ({ page }) => {
  const file = seedVanessa();
  await page.reload();
  const app = page.frameLocator("#app");
  await expect(app.locator("#headerProjectName")).toHaveText("Product");
  await app.getByRole("button", { name: "Открыть настройки Vanessa" }).click();
  await app.locator("#vanessaProfileLoad").click();
  await expect(app.getByText("Менеджер тестирования", { exact: true })).toBeVisible();
  await expect(app.getByText("Пользователи тестового клиента", { exact: true })).toBeVisible();
  await expect(app.getByLabel("Менеджер: пароль")).toHaveAttribute("type", "password");
  await app.getByLabel("Идентификатор профиля").fill("edited-profile");
  await app.getByLabel("Имя нового профиля клиента").fill("Operator");
  await app.getByRole("button", { name: "Добавить пользователя" }).click();
  await app.getByLabel("Operator: пользователь").fill("Оператор");
  await app.getByLabel("Operator: пароль").fill("another-private-secret");
  await app.getByRole("button", { name: "Переместить пользователя Operator вверх" }).click();
  await page.setViewportSize({ width: 480, height: 900 });
  expect(await app.locator("#testingDialog").evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
  await app.locator("#vanessaProfileSave").click();
  await expect.poll(() => JSON.parse(fs.readFileSync(file, "utf8")).users.Operator?.name).toBe("Оператор");
  expect(JSON.parse(fs.readFileSync(file, "utf8")).id).toBe("edited-profile");
  expect(Object.keys(JSON.parse(fs.readFileSync(file, "utf8")).users)[0]).toBe("Operator");
  await app.locator("#vanessaStartButton").click();
  await expect(app.locator("#vanessaStartConfirm")).toBeVisible();
  await expect(app.locator("#vanessaStartTarget")).toContainText("edited-profile");
  await expect(app.locator("#vanessaStartTarget")).toContainText("manager");
  await expect(app.locator("#vanessaStartTarget")).not.toContainText("private-secret");
  await app.locator("#vanessaStartCancel").click();
  expect(host.calls.some(call => call.name === "settings.vanessa_start")).toBe(false);
  host.failNext("settings.vanessa_start", "Тестовая остановка до запуска процесса.");
  await app.locator("#vanessaStartButton").click();
  await app.locator("#vanessaStartConfirmButton").click();
  await expect(app.locator("#testingDialogNotice")).toContainText("Тестовая остановка до запуска процесса");
  const start = host.calls.find(call => call.name === "settings.vanessa_start");
  expect(start.arguments.authorization.effects).toEqual(["launch"]);
  expect(JSON.parse(start.arguments.authorization.scope).projectRoot).toBe(host.project);
  expect(JSON.parse(start.arguments.authorization.scope).clientName).toBe("Operator");
  expect(start.arguments.expectedRevision).toMatch(/^[a-f0-9]{64}$/);
});

test("keeps keyboard focus through Vanessa field and client changes", async ({ page }) => {
  seedVanessa();
  await page.reload();
  const app = page.frameLocator("#app");
  await app.getByRole("button", { name: "Открыть настройки Vanessa" }).click();
  await app.locator("#vanessaProfileLoad").click();
  const mode = app.getByLabel("Способ запуска", { exact: true });
  await mode.focus();
  await mode.selectOption("navigationUrl");
  await expect(mode).toBeFocused();
  await mode.press("Tab");
  await expect(app.getByLabel("Навигационная ссылка обработки", { exact: true })).toBeFocused();
  const base = app.getByLabel("База менеджера: тип", { exact: true });
  await base.focus();
  await base.selectOption("file");
  await expect(base).toBeFocused();
  await base.press("Tab");
  await expect(app.getByLabel("База менеджера: путь", { exact: true })).toBeFocused();

  await expect(app.getByRole("button", { name: "Удалить пользователя TestClient", exact: true })).toBeDisabled();
  await app.getByLabel("Имя нового профиля клиента").fill("Operator");
  await app.getByRole("button", { name: "Добавить пользователя", exact: true }).click();
  await expect(app.getByLabel("Operator: пользователь", { exact: true })).toBeFocused();
  await app.getByRole("button", { name: "Переместить пользователя Operator вверх", exact: true }).click();
  await expect(app.getByLabel("Operator: пользователь", { exact: true })).toBeFocused();
  await app.getByRole("button", { name: "Удалить пользователя Operator", exact: true }).click();
  await expect(app.getByLabel("TestClient: пользователь", { exact: true })).toBeFocused();
  await expect(app.getByRole("button", { name: "Удалить пользователя TestClient", exact: true })).toBeDisabled();
  await app.locator("#vanessaProfileDiscard").click();
  await expect(app.getByLabel("Идентификатор профиля", { exact: true })).toBeFocused();
  expect(host.calls.some(call => call.name === "settings.vanessa_save")).toBe(false);
});

test("fits long Vanessa client names on a narrow viewport", async ({ page }) => {
  const file = seedVanessa(), profile = JSON.parse(fs.readFileSync(file, "utf8"));
  const name = "ДлинноеИмяКлиента".repeat(12);
  profile.users[name] = { name: "Operator", password: "", interface: "taxi" };
  fs.writeFileSync(file, JSON.stringify(profile));
  await page.setViewportSize({ width: 375, height: 812 });
  await page.reload();
  const app = page.frameLocator("#app");
  await app.getByRole("button", { name: "Открыть настройки Vanessa" }).click();
  await app.locator("#vanessaProfileLoad").click();
  await expect(app.getByLabel(name + ": пользователь", { exact: true })).toBeVisible();
  expect(await app.locator("#testingDialog").evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
  await app.getByRole("button", { name: "Удалить пользователя " + name, exact: true }).click();
  await expect(app.getByLabel("TestClient: пользователь", { exact: true })).toBeFocused();
});

test("initializes the MCP App and reads the real settings server", async ({ page }) => {
  await expect.poll(() => page.evaluate(() => window.hostMessages.map(message => message.method)))
    .toContain("ui/initialize");
  await expect.poll(() => page.evaluate(() => window.hostMessages.map(message => message.method)))
    .toContain("ui/notifications/initialized");
  await expect.poll(() => host.calls.map(call => call.name)).toContain("settings.read");
  await expect(page.frameLocator("#app").locator("#checkTab")).toHaveAttribute("aria-selected", "true");
});

test("saves a local connection and discards a later draft", async ({ page }) => {
  const app = await openEdt(page);
  const local = path.join(host.project, ".ai/project.local.yaml");
  const shared = path.join(host.project, ".ai/project.yaml");
  const sharedBefore = fs.readFileSync(shared, "utf8");
  await app.locator("#connectionLocalButton").click();
  await app.locator("#edtUrl").fill("http://127.0.0.1:8123/mcp");
  await app.locator("#saveButton").click();
  await expect.poll(() => fs.existsSync(local) && load(local).connections?.edt?.url)
    .toBe("http://127.0.0.1:8123/mcp");
  await expect(app.locator("#saveButton")).toBeDisabled();
  expect(fs.readFileSync(shared, "utf8")).toBe(sharedBefore);

  await app.locator("#edtUrl").fill("http://127.0.0.1:9999/mcp");
  await app.locator("#componentDialogClose").click();
  await expect(app.locator("#componentCloseConfirm")).toBeVisible();
  await app.locator("#componentCloseStay").click();
  await expect(app.locator("#connectionDiagnostics")).not.toHaveAttribute("open");
  await expect(app.locator("#componentDiscard")).toBeVisible();
  await app.locator("#componentDiscard").click();
  await expect(app.locator("#edtUrl")).toHaveValue("http://127.0.0.1:8123/mcp");
  await expect(app.locator("#edtUrl")).toBeFocused();
  await app.locator("#componentDialogClose").click();
  await expect(app.locator("#componentDialog")).toBeHidden();
  expect(load(local).connections.edt.url).toBe("http://127.0.0.1:8123/mcp");
  expect(host.calls.filter(call => call.name === "settings.update")).toHaveLength(1);
});

for (const selectedScope of ["profile", "project_local"]) test(`saves a detected EDT address to ${selectedScope} without editing it`, async ({ page }) => {
  const shared = path.join(host.project, ".ai/project.yaml"), local = path.join(host.project, ".ai/project.local.yaml");
  const profile = load(shared), v8std = "http://10.10.0.10:8766/mcp";
  profile.connections = { v8std: { url: v8std } }; dump(profile, shared);
  const sharedBefore = fs.readFileSync(shared);
  const localV8std = "http://127.0.0.1:8766/mcp";
  if (selectedScope === "project_local") dump({ connections: { v8std: { url: localV8std } } }, local);
  const localBefore = fs.existsSync(local) ? fs.readFileSync(local) : null;
  const prefs = path.join(host.project, ".metadata/.plugins/org.eclipse.core.runtime/.settings/com.ditrix.edt.mcp.server.prefs");
  fs.mkdirSync(path.dirname(prefs), { recursive: true });
  fs.writeFileSync(prefs, "eclipse.preferences.version=1\n");

  await page.reload();
  await expect(page.frameLocator("#app").locator("#headerProjectName")).toHaveText("Product");
  const app = await openEdt(page), input = app.locator("#edtUrl"), save = app.locator("#saveButton");
  const detected = "http://127.0.0.1:8765/mcp";
  await expect(app.locator("#connectionSharedButton")).toHaveAttribute("aria-pressed", "true");
  await expect(input).toHaveValue(detected);
  await expect(app.locator("#edtSource")).toContainText("настройки EDT");
  await expect(save).toBeEnabled();
  await expect(app.locator("#componentDiscard")).toBeHidden();
  await expect(app.locator("#unsavedHint")).toBeHidden();
  expect(load(shared).connections.edt).toBeUndefined();
  expect(host.calls.filter(call => call.name === "settings.update")).toHaveLength(0);

  await app.locator("#componentDialogClose").click();
  await expect(app.locator("#componentDialog")).toBeHidden();
  await expect(app.locator("#componentCloseConfirm")).toBeHidden();
  expect(load(shared).connections.edt).toBeUndefined();
  if (localBefore) expect(fs.readFileSync(local)).toEqual(localBefore);
  else expect(fs.existsSync(local)).toBe(false);
  expect(host.calls.filter(call => call.name === "settings.update")).toHaveLength(0);
  await openEdt(page);
  await app.locator("#connectionLocalButton").click();
  await expect(save).toBeEnabled();
  await expect(app.locator("#componentDiscard")).toBeHidden();
  await expect(app.locator("#unsavedHint")).toBeHidden();
  await page.keyboard.press("Escape");
  await expect(app.locator("#componentDialog")).toBeHidden();
  await expect(app.locator("#componentCloseConfirm")).toBeHidden();
  expect(host.calls.filter(call => call.name === "settings.update")).toHaveLength(0);
  await openEdt(page);
  await input.fill("");
  await expect(save).toBeDisabled();
  await app.locator("#connectionSharedButton").focus();
  await expect(input).toHaveAttribute("placeholder", detected);
  await expect(save).toBeEnabled();
  await input.focus();
  await expect(input).toHaveValue(detected);
  await expect(save).toBeEnabled();

  await app.locator("#connectionLocalButton").click();
  await expect(save).toBeEnabled();
  if (selectedScope === "profile") await app.locator("#connectionSharedButton").click();
  await expect(save).toBeEnabled();
  await expect(app.locator("#edtSource")).toContainText(selectedScope === "profile" ? "общий профиль" : "локальные настройки");
  await save.click();
  const target = selectedScope === "profile" ? shared : local;
  await expect.poll(() => fs.existsSync(target) && load(target).connections?.edt?.url).toBe(detected);
  await expect(save).toBeDisabled();
  expect(load(shared).connections.v8std.url).toBe(v8std);
  if (selectedScope === "profile") expect(fs.existsSync(local)).toBe(false);
  else { expect(fs.readFileSync(shared)).toEqual(sharedBefore); expect(load(local).connections.v8std.url).toBe(localV8std); }
  const updates = host.calls.filter(call => call.name === "settings.update");
  expect(updates).toHaveLength(1);
  expect(updates[0].arguments.scope).toBe(selectedScope);
  expect(updates[0].arguments.set).toEqual({ edtUrl: detected });
  expect(updates[0].arguments.expectedRevision).toMatch(/^[a-f0-9]{64}$/);
});

for (const selectedScope of ["profile", "project_local"]) test(`refuses to save a detected EDT address to ${selectedScope} after the workspace port changes`, async ({ page }) => {
  const shared = path.join(host.project, ".ai/project.yaml"), local = path.join(host.project, ".ai/project.local.yaml");
  const prefs = path.join(host.project, ".metadata/.plugins/org.eclipse.core.runtime/.settings/com.ditrix.edt.mcp.server.prefs");
  fs.mkdirSync(path.dirname(prefs), { recursive: true });
  fs.writeFileSync(prefs, "mcpServerPort=8765\n");
  await page.reload();
  await expect(page.frameLocator("#app").locator("#headerProjectName")).toHaveText("Product");
  const app = await openEdt(page);
  await expect(app.locator("#edtUrl")).toHaveValue("http://127.0.0.1:8765/mcp");
  if (selectedScope === "project_local") await app.locator("#connectionLocalButton").click();
  await expect(app.locator("#saveButton")).toBeEnabled();
  fs.writeFileSync(prefs, "mcpServerPort=19801\n");
  await app.locator("#saveButton").click();
  await expect(app.locator("#componentDialogStatus")).toContainText("Настройки изменились");
  expect(load(shared).connections?.edt).toBeUndefined();
  expect(fs.existsSync(local)).toBe(false);
});

test("edits an inherited EDT URL in place and restores inheritance", async ({ page }) => {
  const shared = path.join(host.project, ".ai/project.yaml"), local = path.join(host.project, ".ai/project.local.yaml");
  const profile = load(shared), inherited = "http://localhost:8765/mcp", changed = "http://localhost:19801/mcp";
  profile.connections = { ...profile.connections, edt: { url: inherited } };
  dump(profile, shared);
  const sharedBefore = fs.readFileSync(shared);
  await page.reload();
  await expect(page.frameLocator("#app").locator("#headerProjectName")).toHaveText("Product");
  const app = await openEdt(page), input = app.locator("#edtUrl"), save = app.locator("#saveButton");
  await app.locator("#connectionLocalButton").click();
  await expect(input).toHaveValue("");
  await expect(input).toHaveAttribute("placeholder", inherited);
  await expect(input).toHaveAttribute("data-inherited", "true");
  const hintColor = await input.evaluate(el => getComputedStyle(el, "::placeholder").color);
  await input.click();
  await expect(input).toHaveValue(inherited);
  expect(await input.evaluate(el => getComputedStyle(el).color)).toBe(hintColor);
  await expect(save).toBeDisabled();
  await app.locator("#connectionLocalButton").focus();
  await expect(input).toHaveValue("");
  await input.click();
  await input.evaluate(el => { const at = el.value.indexOf("8765"); el.setSelectionRange(at, at + 4); });
  await page.keyboard.type("19801");
  await expect(input).toHaveValue(changed);
  await expect(input).toHaveAttribute("data-inherited", "false");
  expect(await input.evaluate(el => getComputedStyle(el).color)).not.toBe(hintColor);
  await expect(save).toBeEnabled();
  await save.click();
  await expect.poll(() => fs.existsSync(local) && load(local).connections?.edt?.url).toBe(changed);
  await expect(input).toHaveAttribute("data-inherited", "false");
  expect(fs.readFileSync(shared)).toEqual(sharedBefore);

  await input.fill("");
  await save.click();
  await expect.poll(() => load(local).connections?.edt?.url).toBeUndefined();
  await expect(input).toHaveAttribute("placeholder", inherited);
  await expect(input).toHaveAttribute("data-inherited", "true");
  await expect(save).toBeDisabled();
  expect(fs.readFileSync(shared)).toEqual(sharedBefore);
});

test("edits and removes a shared URL masked by a local override", async ({ page }) => {
  const shared = path.join(host.project, ".ai/project.yaml"), local = path.join(host.project, ".ai/project.local.yaml");
  const profile = load(shared), localUrl = "http://localhost:2222/mcp";
  profile.connections = { ...profile.connections, edt: { url: "http://localhost:1111/mcp" } };
  dump(profile, shared); dump({ connections: { edt: { url: localUrl } } }, local);
  await page.reload();
  await expect(page.frameLocator("#app").locator("#headerProjectName")).toHaveText("Product");
  const app = await openEdt(page), input = app.locator("#edtUrl"), save = app.locator("#saveButton");
  await app.locator("#connectionSharedButton").click();
  await input.click();
  await expect(input).toHaveValue(localUrl); await expect(save).toBeDisabled();
  await input.fill("http://localhost:3333/mcp"); await input.fill(localUrl);
  await expect(save).toBeEnabled(); await save.click();
  await expect.poll(() => load(shared).connections?.edt?.url).toBe(localUrl);
  expect(load(local).connections.edt.url).toBe(localUrl);

  await input.click(); await input.fill(""); await expect(save).toBeEnabled(); await save.click();
  await expect.poll(() => load(shared).connections?.edt?.url).toBeUndefined();
  expect(load(local).connections.edt.url).toBe(localUrl);

  await input.click(); await input.fill("http://localhost:3333/mcp"); await input.fill(localUrl);
  await expect(save).toBeEnabled(); await save.click();
  await expect.poll(() => load(shared).connections?.edt?.url).toBe(localUrl);
  expect(load(local).connections.edt.url).toBe(localUrl);
});

test("edits an inherited numeric OpenViking setting after clearing it", async ({ page }) => {
  const shared = path.join(host.project, ".ai/project.yaml"), local = path.join(host.project, ".ai/project.local.yaml");
  const profile = load(shared);
  profile.connections = { ...profile.connections, openviking: { enabled: true, url: "http://localhost:18193/mcp", timeout_seconds: 30 } };
  dump(profile, shared);
  const sharedBefore = fs.readFileSync(shared);
  await page.reload();
  await expect(page.frameLocator("#app").locator("#headerProjectName")).toHaveText("Product");
  const app = page.frameLocator("#app");
  await app.getByRole("button", { name: "Открыть настройки OpenViking" }).click();
  await app.locator("#connectionLocalButton").click();
  const timeout = app.locator("#openvikingTimeout");
  await expect(timeout).toHaveAttribute("placeholder", "30");
  await timeout.click();
  await expect(timeout).toHaveValue("30");
  await timeout.press("Control+A");
  await timeout.press("Backspace");
  await expect(timeout).toHaveValue("");
  await expect(app.locator("#saveButton")).toBeDisabled();
  await page.frame({ url: /\/settings$/ }).evaluate(() => renderCurrent(currentData, { preserveDraft: true }));
  await expect(timeout).toHaveValue("");
  await page.keyboard.type("45");
  await expect(timeout).toHaveValue("45");
  await app.locator("#saveButton").click();
  await expect.poll(() => fs.existsSync(local) && load(local).connections?.openviking?.timeout_seconds).toBe(45);
  expect(fs.readFileSync(shared)).toEqual(sharedBefore);
});

for (const selectedScope of ["profile", "project_local"]) test(`refreshes EDT port locally when ${selectedScope} is selected`, async ({ page }) => {
  const local = path.join(host.project, ".ai/project.local.yaml");
  const shared = path.join(host.project, ".ai/project.yaml");
  const profile = load(shared);
  profile.connections = { ...profile.connections, edt: { url: "http://localhost:8765/mcp" } };
  dump(profile, shared);
  if (selectedScope === "project_local") dump({ connections: { edt: { url: "http://localhost:8765/mcp" }, v8std: { url: "http://localhost:9000/mcp" } } }, local);
  const sharedBefore = fs.readFileSync(shared);
  const prefs = path.join(host.project, ".metadata/.plugins/org.eclipse.core.runtime/.settings/com.ditrix.edt.mcp.server.prefs");
  fs.mkdirSync(path.dirname(prefs), { recursive: true });
  fs.writeFileSync(prefs, "mcpServerPort=19801\n");

  await page.reload();
  await expect(page.frameLocator("#app").locator("#headerProjectName")).toHaveText("Product");
  const app = await openEdt(page);
  await app.locator(selectedScope === "profile" ? "#connectionSharedButton" : "#connectionLocalButton").click();
  await expect(app.locator("#edtPortText")).toContainText("локальные настройки");
  await app.locator("#useEdtPortButton").click();
  await expect.poll(() => fs.existsSync(local) && load(local).connections?.edt?.url).toBe("http://localhost:19801/mcp");
  await expect(app.locator("#edtPortHint")).toBeHidden();
  await expect(app.locator("#componentDialogStatus")).toContainText("Локальные настройки");
  await expect(app.locator("#connectionLocalButton")).toHaveAttribute("aria-pressed", "true");
  await expect(app.locator("#connectionSharedButton")).toHaveAttribute("aria-pressed", "false");
  await expect(app.locator("#connectionDestination")).toContainText("project.local.yaml");
  await expect(app.locator("#edtUrl")).toHaveValue("http://localhost:19801/mcp");
  expect(fs.readFileSync(shared)).toEqual(sharedBefore);
  if (selectedScope === "project_local") expect(load(local).connections.v8std.url).toBe("http://localhost:9000/mcp");
  const updates = host.calls.filter(call => call.name === "settings.update");
  expect(updates).toHaveLength(1);
  expect(updates[0].arguments.scope).toBe("project_local");
  expect(updates[0].arguments.set).toEqual({ edtUrl: "http://localhost:19801/mcp" });
});

test("shows an MCP failure and preserves the unsaved draft", async ({ page }) => {
  const app = await openEdt(page);
  await app.locator("#connectionLocalButton").click();
  await app.locator("#edtUrl").fill("http://127.0.0.1:8123/mcp");
  host.failNext("settings.update", "Проверочная ошибка сохранения");
  await app.locator("#saveButton").click();
  await expect(app.locator("#componentDialogStatus")).toContainText("Проверочная ошибка сохранения");
  await expect(app.locator("#edtUrl")).toHaveValue("http://127.0.0.1:8123/mcp");
  expect(fs.existsSync(path.join(host.project, ".ai/project.local.yaml"))).toBe(false);
  await app.locator("#saveButton").click();
  await expect.poll(() => fs.existsSync(path.join(host.project, ".ai/project.local.yaml"))).toBe(true);
});

test("views another project without changing the chat project", async ({ page }) => {
  const app = page.frameLocator("#app");
  await app.locator("#profileToggleButton").click();
  await app.locator("#profileHistory .profile-entry").filter({ hasText: "Other" }).click();
  await expect(app.locator("#headerProjectName")).toHaveText("Other");
  await expect(app.locator("#viewOnlyHint")).toBeVisible();
  const current = await host.client.call("settings.read", {});
  expect(current.structuredContent.values.projectRoot).toBe(host.project);
  await app.locator("#profileToggleButton").click();
  await app.locator("#profileHistory .profile-entry").filter({ hasText: "Product" }).click();
  await expect(app.locator("#headerProjectName")).toHaveText("Product");
  await expect(app.locator("#viewOnlyHint")).toBeHidden();
});

test("opens a profile section once, edits its fields and restores it after search", async ({ page }) => {
  const app = page.frameLocator("#app"), shared = path.join(host.project, ".ai/project.yaml");
  await app.locator("#editorTab").click();
  const section = app.locator("#jsonTree > details").filter({ hasText: "Тестирование" });
  await section.locator(":scope > summary").click();
  const field = app.getByLabel("testing.yaxunit", { exact: true });
  await expect(field).toBeVisible();
  await field.selectOption({ label: "true" });
  await expect(app.getByLabel("testing.yaxunit", { exact: true }).locator("option:checked")).toHaveText("true");
  await expect(section).toHaveAttribute("open");
  const search = app.locator("#editorSearch");
  await search.fill("testing.yaxunit");
  await expect(app.getByLabel("testing.yaxunit", { exact: true })).toBeVisible();
  await search.press("Escape");
  await expect(section).toHaveAttribute("open");
  await expect(app.getByLabel("testing.yaxunit", { exact: true }).locator("option:checked")).toHaveText("true");
  expect(load(shared).testing.yaxunit).toBe(false);
});

for (const scope of ["profile", "project_local"]) test(`saves ${scope} YAML directly without a review or replacement step`, async ({ page }) => {
  const app = page.frameLocator("#app"), shared = path.join(host.project, ".ai/project.yaml"), local = path.join(host.project, ".ai/project.local.yaml");
  const target = scope === "profile" ? shared : local, other = scope === "profile" ? local : shared;
  const otherBefore = fs.existsSync(other) ? fs.readFileSync(other) : null;
  await app.locator("#editorTab").click();
  if (scope === "project_local") await app.locator("#editorLocalButton").click();
  await app.locator("#editorYamlButton").click();
  const editor = app.locator("#settingsText"), save = app.locator("#applyButton");
  await expect(editor).toBeVisible();
  await expect(save).toBeDisabled();
  const draft = scope === "profile" ? fs.readFileSync(shared, "utf8").replace(/purpose:[^\r\n]*/, "purpose: Прямое редактирование YAML")
    : "connections:\n  edt:\n    url: http://localhost:8765/mcp\n# local comment\n";
  await editor.fill(draft);
  await expect(save).toBeEnabled();
  await expect(app.locator("#preview")).toBeHidden();
  if (scope === "project_local") await editor.press("Control+s");
  else await save.click();
  await expect.poll(() => fs.existsSync(target) && fs.readFileSync(target, "utf8")).toBe(canonical_yaml(draft));
  await expect(app.locator("#status")).toContainText("Настройки сохранены");
  await expect(save).toBeDisabled();
  await expect(app.locator("#preview")).toBeHidden();
  expect(host.calls.filter(call => call.name === "settings.apply")).toHaveLength(1);
  expect(host.calls.filter(call => call.name === "settings.preview")).toHaveLength(1);
  const applied = host.calls.find(call => call.name === "settings.apply");
  expect(applied.arguments.layerScope).toBe(scope);
  expect(applied.arguments.replace).toBe(true);
  if (otherBefore) expect(fs.readFileSync(other)).toEqual(otherBefore);
  else expect(fs.existsSync(other)).toBe(false);
});

test("saves the formatting shown by an optional preview without editing the document", async ({ page }) => {
  const app = page.frameLocator("#app"), shared = path.join(host.project, ".ai/project.yaml");
  const original = JSON.stringify(load(shared));
  fs.writeFileSync(shared, original);
  await page.reload();
  await expect(app.locator("#headerProjectName")).toHaveText("Product");
  await app.locator("#editorTab").click();
  await app.locator("#editorYamlButton").click();
  await expect(app.locator("#applyButton")).toBeDisabled();
  await app.locator("#reviewEditButton").click();
  await expect(app.locator("#applyButton")).toBeEnabled();
  await expect(app.locator("#editorDiscardButton")).toBeEnabled();
  host.failNext("settings.preview", "Тестовый отказ проверки.");
  await app.locator("#applyButton").click();
  await expect(app.locator("#status")).toContainText("Тестовый отказ проверки");
  await expect(app.locator("#applyButton")).toBeEnabled();
  await expect(app.locator("#editorDiscardButton")).toBeEnabled();
  expect(fs.readFileSync(shared, "utf8")).toBe(original);
  host.failNext("settings.apply", "Тестовый отказ записи.");
  await app.locator("#applyButton").click();
  await expect(app.locator("#status")).toContainText("Тестовый отказ записи");
  await expect(app.locator("#applyButton")).toBeEnabled();
  await expect(app.locator("#editorDiscardButton")).toBeEnabled();
  expect(fs.readFileSync(shared, "utf8")).toBe(original);
  await app.locator("#supportTab").click();
  await app.locator("#editorTab").click();
  await expect(app.locator("#preview")).toBeHidden();
  await app.locator("#applyButton").click();
  await expect.poll(() => fs.readFileSync(shared, "utf8")).toBe(canonical_yaml(original));
  await expect(app.locator("#applyButton")).toBeDisabled();
  await app.locator("#reviewEditButton").click();
  await expect(app.locator("#preview")).toBeVisible();
  await expect(app.locator("#applyButton")).toBeDisabled();
  await expect(app.locator("#unsavedHint")).toBeHidden();
  await app.locator("#editSettingsButton").click();
  await expect(app.locator("#preview")).toBeHidden();
});

test("saves Git ignore protection shown by a local preview without editing YAML", async ({ page }) => {
  const app = page.frameLocator("#app"), local = path.join(host.project, ".ai/project.local.yaml"), ignore = path.join(host.project, ".ai/.gitignore");
  dump({ project: { purpose: "Local purpose" } }, local);
  const original = fs.readFileSync(local, "utf8");
  expect(fs.existsSync(ignore)).toBe(false);
  await page.reload();
  await expect(app.locator("#headerProjectName")).toHaveText("Product");
  await app.locator("#editorTab").click();
  await app.locator("#editorLocalButton").click();
  await app.locator("#reviewEditButton").click();
  await expect(app.locator("#applyButton")).toBeEnabled();
  await app.locator("#applyButton").click();
  await expect(app.locator("#status")).toContainText("Настройки сохранены");
  expect(fs.readFileSync(ignore, "utf8")).toContain("/project.local.yaml");
  expect(fs.readFileSync(local, "utf8")).toBe(original);
});

test("keeps an invalid YAML draft and saves it after correction", async ({ page }) => {
  const app = page.frameLocator("#app"), shared = path.join(host.project, ".ai/project.yaml"), original = fs.readFileSync(shared, "utf8");
  await app.locator("#editorTab").click();
  await app.locator("#editorYamlButton").click();
  const editor = app.locator("#settingsText"), save = app.locator("#applyButton");
  for (const draft of ["project: [", original + "\nunexpected_setting: true\n"]) {
    await editor.fill(draft);
    await save.click();
    await expect(app.locator("#editorValidation")).toHaveClass(/error/);
    await expect(save).toBeEnabled();
    await expect(editor).toHaveValue(draft);
    expect(fs.readFileSync(shared, "utf8")).toBe(original);
    expect(host.calls.some(call => call.name === "settings.apply")).toBe(false);
  }
  const corrected = original + "\n# corrected draft\n";
  await editor.fill(corrected);
  await save.click();
  await expect.poll(() => fs.readFileSync(shared, "utf8")).toBe(canonical_yaml(corrected));
  await expect(save).toBeDisabled();
});

test("keeps external changes and the editor draft when its base revision is stale", async ({ page }) => {
  const app = page.frameLocator("#app"), shared = path.join(host.project, ".ai/project.yaml"), original = fs.readFileSync(shared, "utf8");
  await app.locator("#editorTab").click();
  await app.locator("#editorYamlButton").click();
  const draft = original + "\n# unsaved draft\n", external = original + "\n# external change\n";
  await app.locator("#settingsText").fill(draft);
  fs.writeFileSync(shared, external);
  await app.locator("#applyButton").click();
  await expect(app.locator("#editorValidation")).toHaveClass(/error/);
  await expect(app.locator("#settingsText")).toHaveValue(draft);
  await expect(app.locator("#applyButton")).toBeEnabled();
  expect(fs.readFileSync(shared, "utf8")).toBe(external);
  expect(host.calls.some(call => call.name === "settings.apply")).toBe(false);
});

test("previews the exact block YAML that the editor saves", async ({ page }) => {
  const app = page.frameLocator("#app"), shared = path.join(host.project, ".ai/project.yaml");
  const original = fs.readFileSync(shared, "utf8");
  await app.locator("#editorTab").click();
  await app.locator("#editorYamlButton").click();
  const editor = app.locator("#settingsText");
  await expect(editor).toBeVisible();
  const draft = original + '\nconnections: {edt: {url: "http://localhost:8765/mcp"}} # retained\n';
  await editor.fill(draft);
  await app.locator("#reviewEditButton").click();
  await expect(app.locator("#preview")).toBeVisible();
  const details = app.locator("#previewTextDiff details");
  await details.locator("summary").click();
  const formatted = await details.locator("pre").nth(1).textContent();
  expect(formatted).toBe(canonical_yaml(draft));
  expect(formatted).toContain('  edt:\n    url: "http://localhost:8765/mcp"');
  expect(formatted).toContain("# retained");
  await app.locator("#applyButton").click();
  await expect.poll(() => fs.readFileSync(shared, "utf8")).toBe(formatted);
});

for (const scope of ["profile", "project_local"]) test(`shows final YAML for an equivalent ${scope} draft without file changes`, async ({ page }) => {
  const app = page.frameLocator("#app"), target = path.join(host.project, ".ai", scope === "profile" ? "project.yaml" : "project.local.yaml");
  if (scope === "project_local") {
    dump({ connections: { edt: { url: "http://localhost:8765/mcp" } } }, target);
    await page.reload();
    await expect(app.locator("#headerProjectName")).toHaveText("Product");
  }
  const original = fs.readFileSync(target, "utf8"), draft = JSON.stringify(load(target));
  expect(canonical_yaml(draft)).toBe(original);
  await app.locator("#editorTab").click();
  await app.locator("#editorYamlButton").click();
  await expect(app.locator("#settingsText")).toHaveValue(original.trimEnd() + "\n");
  await app.locator("#settingsText").fill(draft);
  await app.locator("#reviewEditButton").click();
  await expect(app.locator("#preview")).toBeVisible();
  const details = app.locator("#previewTextDiff details");
  await details.locator("summary").click();
  await expect(details.locator("pre").last()).toHaveText(original);
  expect(fs.readFileSync(target, "utf8")).toBe(original);
  expect(host.calls.some(call => call.name === "settings.apply")).toBe(false);
});

test("discards a managed component draft without opening diagnostics", async ({ page }) => {
  const app = page.frameLocator("#app");
  await app.getByRole("button", { name: "Открыть настройки Code Index" }).click();
  const control = app.locator("#codeIndexEnabled"), discard = app.locator("#managedDiscardButton");
  const before = await control.isChecked();
  await expect(discard).toBeHidden();
  await control.click();
  await expect(discard).toBeVisible();
  await expect(app.locator("#managedDiagnostics")).not.toHaveAttribute("open");
  await discard.click();
  await expect(control).toHaveJSProperty("checked", before);
  await expect(control).toBeFocused();
  await expect(discard).toBeHidden();
  expect(host.calls.filter(call => call.name === "settings.update")).toHaveLength(0);
});

test("fits the form and component dialog on a narrow viewport", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 375, height: 812 });
  const app = await openEdt(page);
  const frame = page.frame({ url: /\/settings$/ });
  expect(frame).toBeTruthy();
  expect(await frame.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await app.locator("#edtUrl").fill("http://localhost:8123/mcp");
  await expect(app.locator("#componentDiscard")).toBeVisible();
  expect(await app.locator("#componentDialog").evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
  const dialog = await app.locator("#componentDialog").boundingBox();
  expect(dialog.x).toBeGreaterThanOrEqual(0);
  expect(dialog.x + dialog.width).toBeLessThanOrEqual(375);
  await testInfo.attach("settings-mobile", { body: await page.screenshot(), contentType: "image/png" });
});
