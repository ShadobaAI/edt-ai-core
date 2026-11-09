import fs from "node:fs";
import path from "node:path";
import { test, expect } from "@playwright/test";
import { load } from "../../scripts/common.mjs";
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
  await app.locator("#componentDiscard").locator("xpath=ancestor::details").locator("summary").first().click();
  await app.locator("#componentDiscard").click();
  await expect(app.locator("#edtUrl")).toHaveValue("http://127.0.0.1:8123/mcp");
  await app.locator("#componentDialogClose").click();
  await expect(app.locator("#componentDialog")).toBeHidden();
  expect(load(local).connections.edt.url).toBe("http://127.0.0.1:8123/mcp");
  expect(host.calls.filter(call => call.name === "settings.update")).toHaveLength(1);
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

test("fits the form and component dialog on a narrow viewport", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 375, height: 812 });
  const app = await openEdt(page);
  const frame = page.frame({ url: /\/settings$/ });
  expect(frame).toBeTruthy();
  expect(await frame.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  const dialog = await app.locator("#componentDialog").boundingBox();
  expect(dialog.x).toBeGreaterThanOrEqual(0);
  expect(dialog.x + dialog.width).toBeLessThanOrEqual(375);
  await testInfo.attach("settings-mobile", { body: await page.screenshot(), contentType: "image/png" });
});
