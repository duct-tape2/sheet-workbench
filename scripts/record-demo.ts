/** Record only the synthetic local demo. Never record a connected team session. */
import { chromium, expect } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import path from "node:path";
const address = process.env.DEMO_URL ?? "http://127.0.0.1:5173";
if (!["127.0.0.1", "localhost"].includes(new URL(address).hostname))
  throw new Error("Demo recording is restricted to localhost.");
const output = path.resolve("docs/media");
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ slowMo: 75 });
const context = await browser.newContext({
  viewport: { width: 1440, height: 1000 },
  locale: "en-US",
  recordVideo: {
    dir: path.resolve(".local/recordings"),
    size: { width: 1440, height: 1000 },
  },
});
const page = await context.newPage();
try {
  await page.goto(address);
  await expect(page.locator(".source-status")).toContainText("Synthetic");
  await page.waitForTimeout(2300);
  await page.screenshot({ path: path.join(output, "calendar.png") });
  await page.getByRole("button", { name: "Table", exact: true }).click();
  await page.waitForTimeout(1800);
  await page.locator(".record-link").first().click();
  const modal = page.getByRole("dialog");
  await modal.getByLabel("Task").fill("Prepare the weekly team update");
  await modal.getByLabel("Assignee").fill("Maya");
  await page.waitForTimeout(1500);
  await modal
    .getByRole("button", { name: "Save changes", exact: true })
    .click();
  await page.waitForTimeout(1000);
  await page.screenshot({ path: path.join(output, "table.png") });
  await page.getByRole("button", { name: "Calendar", exact: true }).click();
  await page.waitForTimeout(2300);
  await page.getByRole("button", { name: "Board", exact: true }).click();
  await page.waitForTimeout(2300);
  await page.screenshot({ path: path.join(output, "board.png") });
  await page.getByRole("button", { name: "Report", exact: true }).click();
  await page.waitForTimeout(2700);
  await page.screenshot({ path: path.join(output, "report.png") });
  await page.getByRole("button", { name: "Export", exact: true }).click();
  await page.waitForTimeout(2400);
  await modal
    .getByRole("button", { name: "Close", exact: true })
    .last()
    .click();
  await page.waitForTimeout(1500);
} finally {
  await context.close();
  await page.video()?.saveAs(path.join(output, "browser-demo.webm"));
  await browser.close();
}
console.log(
  "Recorded synthetic browser demo and four real UI screenshots in docs/media.",
);
