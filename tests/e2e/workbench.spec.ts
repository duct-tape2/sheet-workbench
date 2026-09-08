import { test, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

test("core views have no serious accessibility violations", async ({
  page,
}) => {
  await page.goto("/");
  await expect(page.locator(".skip-link")).toBeAttached();
  await page.keyboard.press("Tab");
  await expect(page.locator(".skip-link")).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.locator("#main")).toBeFocused();
  for (const name of ["Calendar", "Table", "Board", "Report"]) {
    await page.getByRole("button", { name, exact: true }).click();
    const scan = await new AxeBuilder({ page })
      .withTags(["wcag2a", "wcag2aa", "wcag21aa"])
      .analyze();
    expect(
      scan.violations.map((v) => ({
        id: v.id,
        help: v.help,
        nodes: v.nodes.map((n) => n.target),
      })),
    ).toEqual([]);
  }
});

test("one confirmed edit is reflected in table, calendar, board and report, then undo", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("/");
  await expect(page.locator(".dataset-heading h2")).toBeVisible();
  await page.getByRole("button", { name: "Table", exact: true }).click();
  await page.locator(".data-table .record-link").first().click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await dialog.getByLabel("Task").fill("Cross-view acceptance record");
  await dialog
    .getByRole("button", { name: "Save changes", exact: true })
    .click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await page
    .getByRole("textbox", { name: "Search all fields" })
    .fill("Cross-view acceptance record");
  await expect(page.locator(".data-table tbody tr")).toHaveCount(1);
  await page.getByRole("button", { name: "Calendar", exact: true }).click();
  await expect(
    page
      .locator(".fc-event")
      .filter({ hasText: "Cross-view acceptance record" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Board", exact: true }).click();
  await expect(page.locator(".board-record")).toHaveCount(1);
  await page.getByRole("button", { name: "Report", exact: true }).click();
  await expect(page.locator(".report-row")).toHaveCount(1);
  await expect(page.locator(".report-row")).toContainText(
    "Cross-view acceptance record",
  );
  await page
    .getByRole("button", { name: "Change history", exact: true })
    .click();
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Close", exact: true })
    .last()
    .click();
  await expect(page.locator(".report-row")).toHaveCount(0);
  expect(errors).toEqual([]);
});

for (const width of [320, 375, 390, 414, 768, 1440])
  test(`navigation and modal remain inside ${width}px viewport`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 780 });
    await page.goto("/");
    await expect(page.locator(".month-title")).not.toBeEmpty();
    for (const name of ["Previous month", "Next month"]) {
      const button = page.getByRole("button", { name });
      const box = await button.boundingBox();
      expect(box).not.toBeNull();
      expect(box!.x).toBeGreaterThanOrEqual(0);
      expect(box!.x + box!.width).toBeLessThanOrEqual(width);
      await button.click();
    }
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await page.getByRole("button", { name: "New record", exact: true }).click();
    await page
      .getByRole("dialog")
      .getByLabel("Task")
      .fill("A deliberately long task title ".repeat(10));
    const close = page
      .getByRole("dialog")
      .getByRole("button", { name: "Close", exact: true })
      .last();
    const save = page.getByRole("button", {
      name: "Save changes",
      exact: true,
    });
    for (const button of [close, save]) {
      const b = await button.boundingBox();
      expect(b!.y).toBeGreaterThanOrEqual(0);
      expect(b!.y + b!.height).toBeLessThanOrEqual(780);
      expect(b!.x + b!.width).toBeLessThanOrEqual(width);
    }
    await close.click();
    await page.screenshot({
      path: test.info().outputPath(`workbench-${width}.png`),
      fullPage: true,
    });
  });

test("mobile view choice persists and real imports require sign-in", async ({
  page,
}) => {
  await page.setViewportSize({ width: 320, height: 700 });
  await page.goto("/");
  await page.getByRole("button", { name: "List", exact: true }).click();
  await page.reload();
  await expect(page.locator(".fc-listMonth-view")).toBeVisible();
  await page.getByRole("button", { name: "Connect data", exact: true }).click();
  await expect(page.getByRole("dialog")).toContainText("Sign in");
  await expect(page.locator("input[type=file]")).toHaveCount(0);
});

test("Korean controls survive a small effective viewport at high zoom", async ({
  page,
}) => {
  await page.setViewportSize({ width: 320, height: 260 });
  await page.addInitScript(() => localStorage.setItem("sw.locale", '"ko"'));
  await page.goto("/");
  await expect(page.locator(".month-title")).not.toBeEmpty();
  for (const name of ["이전 달", "다음 달"]) {
    const button = page.getByRole("button", { name, exact: true });
    const b = await button.boundingBox();
    expect(b!.x).toBeGreaterThanOrEqual(0);
    expect(b!.x + b!.width).toBeLessThanOrEqual(320);
    await button.click();
  }
  await page.getByRole("button", { name: "업무 추가", exact: true }).click();
  const modal = page.getByRole("dialog");
  for (const button of [
    modal.getByRole("button", { name: "닫기", exact: true }).last(),
    modal.getByRole("button", { name: "변경 저장", exact: true }),
  ]) {
    const b = await button.boundingBox();
    expect(b!.y).toBeGreaterThanOrEqual(0);
    expect(b!.y + b!.height).toBeLessThanOrEqual(260);
  }
  await page.screenshot({
    path: test.info().outputPath("korean-small-viewport.png"),
  });
});
