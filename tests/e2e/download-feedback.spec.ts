import { test, expect } from "@playwright/test";
import { readFile } from "node:fs/promises";

test("report download announces the browser download", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Report", exact: true }).click();
  const start = await page
    .getByLabel("Period start", { exact: true })
    .inputValue();
  const downloadEvent = page.waitForEvent("download");
  await page
    .getByRole("button", { name: "Download report", exact: true })
    .click();
  const file = await downloadEvent;
  expect(file.suggestedFilename()).toBe(`report-${start}.md`);
  expect(
    await readFile((await file.path())!).then((bytes) => bytes.toString()),
  ).toContain("Weekly report");
  await expect(page.getByRole("status")).toContainText(
    "Download started. Check your browser's Downloads folder.",
  );
  await page.screenshot({
    path: test.info().outputPath("report-download-status.png"),
    fullPage: true,
  });
});

test("clipboard failure exposes a selectable manual-copy fallback", async ({
  page,
}) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: async () => {
          throw new Error("clipboard blocked in this test");
        },
      },
    });
  });
  await page.goto("/");
  await page.getByRole("button", { name: "Report", exact: true }).click();
  const copyButton = page.getByRole("button", {
    name: "Copy report",
    exact: true,
  });
  await expect(copyButton).toBeEnabled();
  await copyButton.click();
  await expect(page.getByRole("alert")).toContainText(
    "Could not copy the report. Select the report text below and copy it manually.",
  );
  const fallback = page.getByLabel("Report text for manual copying", {
    exact: true,
  });
  await expect(fallback).toBeVisible();
  await expect(fallback).not.toHaveValue("");
  await page.screenshot({
    path: test.info().outputPath("clipboard-manual-fallback.png"),
    fullPage: true,
  });
});

test("clipboard success announces the copied report", async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: async () => undefined },
    });
  });
  await page.goto("/");
  await page.getByRole("button", { name: "Report", exact: true }).click();
  const copyButton = page.getByRole("button", {
    name: "Copy report",
    exact: true,
  });
  await expect(copyButton).toBeEnabled();
  await copyButton.click();
  await expect(page.getByRole("status")).toContainText(
    "Report copied to your clipboard.",
  );
  await expect(
    page.getByRole("button", { name: "Copied", exact: true }),
  ).toBeVisible();
});
