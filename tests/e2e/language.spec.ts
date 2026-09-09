import { test, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { readFile } from "node:fs/promises";

test("Korean link overrides saved language and switching preserves edited records", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Table", exact: true }).click();
  await page.locator(".record-link").first().click();
  await page
    .getByRole("dialog")
    .getByLabel("Task")
    .fill("Keep this edited task");
  await page.getByRole("button", { name: "Save changes", exact: true }).click();
  const saved = await page.evaluate(() => localStorage.getItem("sw.demo"));
  await page.goto("/?lang=ko&test=retained#main");
  await expect(page.locator("html")).toHaveAttribute("lang", "ko");
  await expect(page.locator(".language-picker select")).toHaveValue("ko");
  await expect(page.locator(".record-link").first()).toHaveText(
    "Keep this edited task",
  );
  expect(await page.evaluate(() => localStorage.getItem("sw.demo"))).toBe(
    saved,
  );
  await page.getByRole("button", { name: "주간 보고", exact: true }).click();
  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "보고서 저장", exact: true }).click();
  const report = await readFile((await (await download).path())!, "utf8");
  expect(report).toContain("주간 보고");
  expect(report).toContain("Keep this edited task");
  expect(report).not.toContain("Weekly report");
  await page.getByLabel("Language / 언어", { exact: true }).selectOption("en");
  await expect(page).toHaveURL(/lang=en&test=retained#main$/);
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("lang", "en");
  await page.getByLabel("Language / 언어", { exact: true }).selectOption("ko");
  await page.goto("/");
  await expect(page.locator("html")).toHaveAttribute("lang", "ko");
  expect(await page.evaluate(() => localStorage.getItem("sw.demo"))).toBe(
    saved,
  );
});

test("Korean sample edit and report work with the in-app guide", async ({
  page,
}) => {
  await page.goto("/?lang=ko");
  await expect(page.locator(".dataset-heading h2")).toHaveText("우리 팀 업무");
  await page
    .locator(".topbar")
    .getByRole("button", { name: "사용 안내" })
    .click();
  const guide = page.getByRole("dialog");
  await expect(guide.locator(".quick-start-steps li")).toHaveCount(3);
  await expect(guide).toContainText("실제 Google 계정 연결은 아직");
  await expect(guide).toContainText(
    "PC에 있던 원본 파일을 자동으로 덮어쓰지는 않습니다",
  );
  await guide.getByRole("button", { name: "닫기", exact: true }).last().click();
  await page.getByRole("button", { name: "표", exact: true }).click();
  await page.locator(".record-link").first().click();
  await page
    .getByRole("dialog")
    .getByLabel("업무명")
    .fill("한국어 사용 안내 확인");
  await page.getByRole("button", { name: "변경 저장", exact: true }).click();
  await page.getByRole("button", { name: "달력", exact: true }).first().click();
  await expect(
    page.locator(".fc-event").filter({ hasText: "한국어 사용 안내 확인" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "상태 보드", exact: true }).click();
  await expect(page.locator(".board")).toContainText("한국어 사용 안내 확인");
  await page.getByRole("button", { name: "주간 보고", exact: true }).click();
  await expect(
    page.locator(".report-row").filter({ hasText: "한국어 사용 안내 확인" }),
  ).toBeVisible();
  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "보고서 저장", exact: true }).click();
  expect((await download).suggestedFilename()).toMatch(/\.md$/);
});

for (const width of [320, 375, 414, 768]) {
  test(`language and guide are accessible at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 700 });
    await page.goto("/");
    const language = page.getByLabel("Language / 언어", { exact: true });
    await expect(language).toBeVisible();
    await language.selectOption("ko");
    const dayNumbers = await page
      .locator(".fc-daygrid-day-number")
      .allTextContents();
    expect(dayNumbers.length).toBeGreaterThan(27);
    expect(dayNumbers.every((value) => /^\d{1,2}$/.test(value))).toBe(true);
    const help = page
      .locator(".topbar")
      .getByRole("button", { name: "사용 안내" });
    for (const control of [language, help]) {
      const box = (await control.boundingBox())!;
      expect(box.x).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width).toBeLessThanOrEqual(width);
      expect(box.y + box.height).toBeLessThanOrEqual(700);
    }
    await help.click();
    const guide = page.getByRole("dialog");
    await expect(guide.locator(".quick-start-steps")).toBeVisible();
    const scan = await new AxeBuilder({ page })
      .withTags(["wcag2a", "wcag2aa", "wcag21aa"])
      .analyze();
    expect(scan.violations).toEqual([]);
    const close = guide
      .getByRole("button", { name: "닫기", exact: true })
      .last();
    const closeBox = (await close.boundingBox())!;
    expect(closeBox.y + closeBox.height).toBeLessThanOrEqual(700);
    await page.screenshot({
      path: test.info().outputPath(`korean-guide-${width}.png`),
    });
    await close.click();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await page.screenshot({
      path: test.info().outputPath(`korean-workbench-${width}.png`),
      fullPage: true,
    });
  });
}
