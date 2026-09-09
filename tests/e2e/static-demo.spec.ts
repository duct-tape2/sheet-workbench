import { expect, test } from "@playwright/test";

test("static demo works below a project subpath without server requests", async ({
  page,
}) => {
  const apiRequests: string[] = [];
  const googleRequests: string[] = [];
  const pageErrors: string[] = [];
  page.on("request", (request) => {
    const url = request.url();
    if (new URL(url).pathname.includes("/api/")) apiRequests.push(url);
    if (/google\.com|googleapis\.com/i.test(url)) googleRequests.push(url);
  });
  page.on("pageerror", (error) => pageErrors.push(error.message));

  await page.goto("./");
  await expect(page).toHaveURL(/\/sheet-workbench\/$/);
  await expect(page.locator(".dataset-heading h2")).toBeVisible();
  await expect(page.locator(".brand")).toHaveAttribute(
    "href",
    "/sheet-workbench/",
  );

  await page.getByRole("button", { name: "Table", exact: true }).click();
  await expect(page.locator(".data-table")).toBeVisible();
  await page.locator(".record-link").first().click();
  const editor = page.getByRole("dialog");
  await editor.getByLabel("Task").fill("Static subpath acceptance record");
  await editor
    .getByRole("button", { name: "Save changes", exact: true })
    .click();

  await page.getByRole("button", { name: "Calendar", exact: true }).click();
  await expect(
    page
      .locator(".fc-event")
      .filter({ hasText: "Static subpath acceptance record" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Board", exact: true }).click();
  await expect(page.locator(".board")).toContainText(
    "Static subpath acceptance record",
  );
  await page.getByRole("button", { name: "Report", exact: true }).click();
  await expect(page.locator(".report-view")).toContainText(
    "Static subpath acceptance record",
  );

  const reportDownload = page.waitForEvent("download");
  await page
    .getByRole("button", { name: "Download report", exact: true })
    .click();
  await expect(reportDownload).resolves.toBeTruthy();
  await page.getByRole("button", { name: "Export", exact: true }).click();
  const exportDialog = page.getByRole("dialog");
  const csvDownload = page.waitForEvent("download");
  await exportDialog
    .getByRole("button", { name: "Download CSV", exact: true })
    .click();
  await expect(csvDownload).resolves.toBeTruthy();
  await exportDialog
    .getByRole("button", { name: "Close", exact: true })
    .last()
    .click();

  await page.getByRole("button", { name: "Connect data", exact: true }).click();
  const importDialog = page.getByRole("dialog");
  await expect(importDialog).toContainText("synthetic rows only");
  await expect(
    importDialog.locator("input[type=file], input[type=email], form"),
  ).toHaveCount(0);
  await expect(
    importDialog.getByRole("link", { name: "Setup guide" }),
  ).toHaveAttribute("href", "/sheet-workbench/setup.html");
  await importDialog
    .getByRole("button", { name: "Close", exact: true })
    .last()
    .click();

  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  const accountDialog = page.getByRole("dialog");
  await expect(accountDialog).toContainText("Account entry is disabled");
  await expect(
    accountDialog.locator("input[type=email], input[type=password], form"),
  ).toHaveCount(0);
  await accountDialog
    .getByRole("button", { name: "Close", exact: true })
    .last()
    .click();

  await page.goto("./?lang=ko");
  await expect(page.locator("html")).toHaveAttribute("lang", "ko");
  await page
    .locator(".topbar")
    .getByRole("button", { name: "사용 안내" })
    .click();
  await expect(page.getByRole("dialog")).toContainText(
    "로그인·파일 업로드·Google 연결을 제공하지 않습니다",
  );
  await expect(
    page.getByRole("dialog").getByRole("link", { name: "설치 안내" }),
  ).toHaveAttribute("href", "/sheet-workbench/setup.html");
  await page.goto("setup.html");
  await expect(
    page.getByRole("link", { name: "Open the workspace" }),
  ).toHaveAttribute("href", "./");
  expect(apiRequests).toEqual([]);
  expect(googleRequests).toEqual([]);
  expect(pageErrors).toEqual([]);
});
