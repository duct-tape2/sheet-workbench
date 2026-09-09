import { test, expect } from "@playwright/test";

const tidyCsv = {
  name: "contacts.csv",
  mimeType: "text/csv",
  buffer: Buffer.from("Name,City\n Mina ,Seoul\nMina,Seoul\n,\n", "utf8"),
};

async function evidence(page: import("@playwright/test").Page, name: string) {
  await page.screenshot({ path: `.local/renewal-review/${name}.png`, fullPage: true });
}

test("local CSV is reviewed, previewed, applied and exported without an API call", async ({ page }) => {
  const externalRequests: string[] = [];
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (url.hostname !== "127.0.0.1" && url.hostname !== "localhost") externalRequests.push(request.url());
  });
  await page.goto("./?mode=local&lang=en");
  await page.getByRole("button", { name: "Open files", exact: true }).click();
  await page.locator('input[type="file"][multiple]').setInputFiles(tidyCsv);
  const review = page.getByRole("dialog", { name: "Review import" });
  await expect(review).toContainText("contacts.csv");
  await expect(review).toContainText("Preview");
  await review.getByRole("button", { name: "Accept source", exact: true }).click();
  await expect(page.getByRole("heading", { name: "contacts", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Review result", exact: true }).click();
  const changes = page.getByRole("dialog", { name: "Review changes" });
  await expect(changes).toContainText("changes");
  await changes.getByRole("button", { name: "Apply changes", exact: true }).click();
  await expect(page.locator(".local-history ol li")).toHaveCount(1);
  await page.locator(".local-export").hover();
  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "Result .csv", exact: true }).click();
  expect((await download).suggestedFilename()).toBe("contacts-result.csv");
  expect(externalRequests).toEqual([]);
  await evidence(page, "local-upload-preview-apply-export");
});

test("local workbench switches Korean and stays inside a 320px viewport", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 700 });
  await page.goto("./?mode=local&lang=ko");
  await expect(page.getByRole("heading", { name: "시트 워크벤치", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "파일 열기", exact: true }).click();
  await page.locator('input[type="file"][multiple]').setInputFiles(tidyCsv);
  const dialog = page.getByRole("dialog", { name: "가져오기 확인" });
  await dialog.getByRole("button", { name: "원본 받아들이기", exact: true }).click();
  const exportButton = page.getByRole("button", { name: /내보내기/ });
  const box = await exportButton.boundingBox();
  expect(box).not.toBeNull();
  expect(box!.x + box!.width).toBeLessThanOrEqual(320);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await evidence(page, "local-ko-mobile-import");
});

test("rectangular paste is blocked while the result view is sorted", async ({ page }) => {
  await page.goto("./?mode=local&lang=en");
  await page.getByRole("button", { name: "Cleaning sample", exact: true }).click();
  const cell = page.locator(".local-table td").first();
  await cell.click();
  await page.locator(".local-grid-controls select").first().selectOption({ index: 1 });
  await cell.evaluate((node) => {
    const clipboard = new DataTransfer();
    clipboard.setData("text/plain", "Mina\tSeoul");
    node.dispatchEvent(new ClipboardEvent("paste", { bubbles: true, clipboardData: clipboard }));
  });
  await expect(page.locator(".local-error")).toContainText("Clear search, filters, sorting, and hidden columns");
  await expect(page.getByRole("dialog", { name: "Review changes" })).toHaveCount(0);
  await page.locator(".local-grid-controls select").first().selectOption("");
  await page.locator(".local-grid-controls select").nth(1).selectOption({ index: 1 });
  // Selecting a column with All values must not silently filter to blank rows.
  await expect(page.locator(".local-table tbody tr")).toHaveCount(3);
  await cell.click();
  await cell.evaluate((node) => {
    const clipboard = new DataTransfer();
    clipboard.setData("text/plain", "Mina\tSeoul");
    node.dispatchEvent(new ClipboardEvent("paste", { bubbles: true, clipboardData: clipboard }));
  });
  await expect(page.getByRole("dialog", { name: "Review changes" })).toHaveCount(0);
});

test("comparison keeps identity keys distinct from compared fields", async ({ page }) => {
  await page.goto("./?mode=local&lang=en");
  await page.getByRole("button", { name: "Compare sample", exact: true }).click();
  await page.getByLabel("Operation").selectOption("compare");
  await expect(page.locator(".local-file-roles")).toContainText("Current file");
  await expect(page.locator(".local-file-roles")).toContainText("current.csv");
  await expect(page.locator(".local-file-roles")).toContainText("Comparison file");
  await page.getByLabel("Comparison file").selectOption({ label: "updated.csv" });
  const mappings = page.locator(".local-mappings > div");
  await mappings.nth(0).locator("select").nth(0).selectOption("id");
  await mappings.nth(0).locator("select").nth(1).selectOption("id");
  await mappings.nth(1).locator("select").nth(0).selectOption("status");
  await mappings.nth(1).locator("select").nth(1).selectOption("status");
  await page.getByRole("button", { name: "Review result", exact: true }).click();
  const review = page.getByRole("dialog", { name: "Review changes" });
  await expect(review).toContainText("Compared with updated.csv");
  await review.getByRole("button", { name: "Apply changes", exact: true }).click();
  await expect(page.locator(".local-history ol li")).toContainText("Compare files");
  await evidence(page, "local-compare-key-value-mapping");
});

test("append sample applies mapped incoming rows to the current file", async ({ page }) => {
  await page.goto("./?mode=local&lang=en");
  await page.getByRole("button", { name: "Append sample", exact: true }).click();
  await expect(page.getByLabel("Operation")).toHaveValue("append");
  await expect(page.locator(".local-file-roles")).toContainText("Current file");
  await expect(page.locator(".local-file-roles")).toContainText("primary.csv");
  await expect(page.locator(".local-file-roles")).toContainText("Incoming file");
  await expect(page.locator(".local-file-roles")).toContainText("incoming.csv");
  await evidence(page, "local-append-file-roles");
  await page.getByRole("button", { name: "Review result", exact: true }).click();
  await page.getByRole("dialog", { name: "Review changes" }).getByRole("button", { name: "Apply changes", exact: true }).click();
  await expect(page.locator(".local-table")).toContainText("Jae");
  await expect(page.locator(".local-history ol li")).toContainText("Append source");
});

test("lookup sample labels its reference file and blocks duplicate ID keys", async ({ page }) => {
  await page.goto("./?mode=local&lang=en");
  await page.getByRole("button", { name: "Compare sample", exact: true }).click();
  await page.getByLabel("Operation").selectOption("lookup");
  await expect(page.locator(".local-file-roles")).toContainText("Reference file");
  await page.getByLabel("Reference file").selectOption({ label: "updated.csv" });
  await page.getByRole("button", { name: "Review result", exact: true }).click();
  await page.getByRole("dialog", { name: "Review changes" }).getByRole("button", { name: "Apply changes", exact: true }).click();
  await expect(page.locator(".local-table")).toContainText("updated.csv: Status");

  await page.getByRole("button", { name: "Open files", exact: true }).click();
  await page.locator('input[type="file"][multiple]').setInputFiles({ name: "duplicate-reference.csv", mimeType: "text/csv", buffer: Buffer.from("ID,Status\n001,Open\n001,Done\n") });
  await page.getByRole("dialog", { name: "Review import" }).getByRole("button", { name: "Accept source", exact: true }).click();
  await page.getByLabel("Reference file").selectOption({ label: "duplicate-reference.csv" });
  await page.getByRole("button", { name: "Review result", exact: true }).click();
  const blocked = page.getByRole("dialog", { name: "Review changes" });
  await expect(blocked).toContainText("duplicate comparison keys");
  await expect(blocked.getByRole("button", { name: "Apply changes", exact: true })).toBeDisabled();
  await evidence(page, "local-lookup-duplicate-key-stop");
});

test("recipes replay a larger renamed file by explicit mapping and undo restores paired steps", async ({ page }) => {
  await page.goto("./?mode=local&lang=en");
  await page.getByRole("button", { name: "Cleaning sample", exact: true }).click();
  await page.getByRole("button", { name: "Review result", exact: true }).click();
  await page.getByRole("dialog", { name: "Review changes" }).getByRole("button", { name: "Apply changes", exact: true }).click();
  const saved = page.waitForEvent("download");
  await page.getByRole("button", { name: "Save recipe", exact: true }).first().click();
  const recipe = page.getByRole("dialog", { name: "Save recipe" });
  await recipe.getByLabel("Recipe name").fill("Sample tidy");
  await recipe.getByRole("button", { name: "Save recipe", exact: true }).click();
  const recipePath = await (await saved).path();
  await page.getByRole("button", { name: "Undo last confirmed action" }).click();
  await expect(page.locator(".local-history ol")).toHaveCount(0);
  await page.getByRole("button", { name: "Redo last action" }).click();
  await expect(page.locator(".local-history ol li")).toHaveCount(1);
  await page.getByRole("button", { name: "Open files", exact: true }).click();
  await page.locator('input[type="file"][multiple]').setInputFiles({ name: "next-week-renamed.csv", mimeType: "text/csv", buffer: Buffer.from("Name,City\n Mina , Seoul\nJae,Busan\nSora,Incheon\n", "utf8") });
  await page.getByRole("dialog", { name: "Review import" }).getByRole("button", { name: "Accept source", exact: true }).click();
  await page.getByRole("button", { name: "Load recipe", exact: true }).click();
  await page.locator('input[accept="application/json,.json"]').setInputFiles(recipePath!);
  const mapping = page.getByRole("dialog", { name: "Match recipe sources" });
  await mapping.getByLabel("cleanup.csv").selectOption({ label: "next-week-renamed.csv" });
  await expect(mapping.getByRole("button", { name: "Review replay", exact: true })).toBeEnabled();
  await mapping.getByRole("button", { name: "Review replay", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "Review changes" })).toBeVisible();
  await evidence(page, "local-recipe-undo-replay");
});

test("adding a source preserves current confirmed work, and device storage loads only on request", async ({ page }) => {
  await page.goto("./?mode=local&lang=en");
  await page.evaluate(
    () => new Promise<void>((resolve, reject) => {
      const request = indexedDB.deleteDatabase("sheet-workbench-personal-v1");
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
      request.onblocked = () => resolve();
    }),
  );
  await page.getByRole("button", { name: "Cleaning sample", exact: true }).click();
  await page.getByRole("button", { name: "Review result", exact: true }).click();
  await page.getByRole("dialog", { name: "Review changes" }).getByRole("button", { name: "Apply changes", exact: true }).click();
  await page.getByRole("button", { name: "Open files", exact: true }).click();
  await page.locator('input[type="file"][multiple]').setInputFiles({ name: "later.csv", mimeType: "text/csv", buffer: Buffer.from("Name,City\nJae,Busan\n") });
  await page.getByRole("dialog", { name: "Review import" }).getByRole("button", { name: "Accept source", exact: true }).click();
  await expect(page.locator(".local-history ol li")).toHaveCount(1);
  await expect(page.locator(".local-table")).toContainText("Mina");
  await page.getByLabel("Keep on this device").check();
  await page.getByRole("button", { name: "Save device copy", exact: true }).click();
  await expect(page.locator(".local-message")).toContainText("Saved only on this device.");
  await page.reload();
  await expect(page.getByRole("heading", { name: "Sheet Workbench", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Load device copy", exact: true }).click();
  await expect(page.getByRole("heading", { name: "cleanup", exact: true })).toBeVisible();
  await evidence(page, "local-source-preserve-device-load");
});

test("Korean synthetic sample exposes the optional mobile details view without overflow", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 700 });
  await page.goto("./?mode=local&lang=ko");
  await page.getByRole("button", { name: "정리 샘플", exact: true }).click();
  const details = page.locator(".local-views > summary");
  await details.click();
  const box = await details.boundingBox();
  expect(box).not.toBeNull();
  expect(box!.x + box!.width).toBeLessThanOrEqual(320);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await evidence(page, "local-ko-sample-mobile-details");
});
