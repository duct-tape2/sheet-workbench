import { test, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { readFile } from 'node:fs/promises';

const tidyCsv = {
  name: "contacts.csv",
  mimeType: "text/csv",
  buffer: Buffer.from("Name,City\n Mina ,Seoul\nMina,Seoul\n,\n", "utf8"),
};

test('wide result tables stay inside their grid track and do not intercept operation clicks', async ({ page }) => {
  await page.goto('./?mode=local&lang=ko');
  await page.locator('input[type="file"][multiple]').setInputFiles({
    name: 'wide-layout.csv', mimeType: 'text/csv',
    buffer: Buffer.from('ID,작업,마감일,상태,담당자,금액,부서,추가열\n A100 ,로드맵 시작,2026-09-15,대기,가상 담당자,1250,샘플팀,값\n', 'utf8'),
  });
  await page.getByRole('button', {name: '원본 받아들이기', exact: true}).click();
  await openAdvancedOperations(page);
  await expect(page.locator('.local-result-pane')).toBeVisible();
  for (const width of [1280, 1366, 1920]) {
    await page.setViewportSize({width, height: 800});
    const result = (await page.locator('.local-result-pane').boundingBox())!;
    const operations = (await page.locator('.local-operations-pane').boundingBox())!;
    expect(result.x + result.width).toBeLessThanOrEqual(operations.x + 1);
    const checkbox = page.locator('.local-operation').getByRole('checkbox', {name: 'ID', exact: true});
    const before = await checkbox.isChecked();
    await checkbox.click();
    await expect(checkbox).toBeChecked({checked: !before});
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  }
});

async function evidence(page: import("@playwright/test").Page, name: string) {
  await page.screenshot({ path: `.local/renewal-review/${name}.png`, fullPage: true });
}

async function openAdvancedOperations(page: import("@playwright/test").Page) {
  const panel = page.locator(".local-advanced-operations");
  if (!(await panel.evaluate((element) => (element as HTMLDetailsElement).open)))
    await panel.locator("summary").click();
}

test("landing examples and controls fit mobile through desktop in both languages", async ({ page }, testInfo) => {
  test.setTimeout(90000);
  for (const lang of ["ko", "en"]) {
    await page.goto(`./?mode=local&lang=${lang}`);
    for (const width of [320, 375, 390, 414, 430, 768, 1024, 1280, 1920]) {
      await page.setViewportSize({ width, height: 800 });
      await expect(page.locator('.sw-case-tabs button')).toHaveCount(4);
      for (const control of await page.locator('.sw-landing button, .sw-landing summary').all()) {
        const box = (await control.boundingBox())!;
        expect(box.x).toBeGreaterThanOrEqual(-1);
        expect(box.x + box.width).toBeLessThanOrEqual(width + 1);
        expect(box.height).toBeGreaterThanOrEqual(44);
        expect(await control.evaluate(el => el.scrollWidth <= el.clientWidth + 1), await control.innerText()).toBe(true);
      }
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await evidence(page, `landing-new-${testInfo.project.name}-${lang}-${width}`);
      if (width === 320 || width === 1280) await page.locator('.sw-hero').screenshot({path: `.local/renewal-review/hero-${testInfo.project.name}-${lang}-${width}.png`});
    }
    for (const tab of await page.locator('.sw-case-tabs button').all()) {
      await tab.click();
      await expect(tab).toHaveAttribute('aria-pressed', 'true');
      await expect(page.locator('.sw-before')).toContainText('BEFORE');
      await expect(page.locator('.sw-after')).toContainText('AFTER');
    }
    await page.locator('.sw-faq summary').first().click();
    await expect(page.locator('.sw-faq details').first()).toHaveAttribute('open', '');
    const accessibility = await new AxeBuilder({page}).include('.sw-landing').analyze();
    expect(accessibility.violations).toEqual([]);
  }
});

test('landing film plays a continuous MP4 and respects reduced motion', async ({ page }, testInfo) => {
  await page.emulateMedia({reducedMotion:'reduce'});
  await page.goto('./?mode=local&lang=ko');
  const demo = page.locator('.sw-demo');
  const video=demo.locator('video');
  await demo.scrollIntoViewIfNeeded();
  await expect(demo).toHaveAttribute('data-autoplay','blocked');
  await expect(video).toHaveAttribute('src',new URL('./media/landing-demo-ko-desktop.mp4',page.url()).pathname+'?v=20260911-v3');
  await expect(video).toHaveAttribute('poster',/landing-demo-ko-desktop\.jpg\?v=20260911-v3$/);
  expect(await video.evaluate((el:HTMLVideoElement)=>el.paused)).toBe(true);
  await demo.getByRole('button',{name:'30초 작업 흐름 영상 재생'}).click();
  await expect.poll(()=>video.evaluate((el:HTMLVideoElement)=>el.currentTime)).toBeGreaterThan(0);
  await expect.poll(()=>video.evaluate((el:HTMLVideoElement)=>el.duration)).toBeCloseTo(30,0);
  await demo.getByRole('button',{name:'시연 일시 정지',exact:true}).click();
  expect(await video.evaluate((el:HTMLVideoElement)=>el.paused)).toBe(true);
  await demo.screenshot({path:`.local/renewal-review/video-${testInfo.project.name}.png`});
  await page.setViewportSize({width:390,height:844});
  await expect(video).toHaveAttribute('src',/landing-demo-ko-mobile\.mp4\?v=20260911-v3$/);
});

test('hero sample CTA opens a real append review without uploading files', async ({ page }, testInfo) => {
  const outside: string[] = [];
  page.on('request', req => {if (new URL(req.url()).hostname !== '127.0.0.1') outside.push(req.url());});
  await page.goto('./?mode=local&lang=ko');
  await page.getByRole('button', {name: '샘플로 시작', exact: true}).click();
  await expect(page.locator('.local-table tbody tr')).toHaveCount(1);
  await openAdvancedOperations(page);
  await page.getByRole('button', {name: '결과 확인', exact: true}).click();
  const dialog = page.getByRole('dialog', {name: '변경 확인'});
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText('Jae');
  await expect(dialog).toContainText('Busan');
  await dialog.getByRole('button', {name: '변경 적용', exact: true}).click();
  await expect(page.locator('.local-table tbody tr')).toHaveCount(2);
  await expect(page.locator('.local-table')).toContainText('Jae');
  await page.locator('.local-export').hover();
  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', {name: '결과 .csv', exact: true}).click();
  const download = await downloadPromise;
  const target = testInfo.outputPath('append-result.csv');
  await download.saveAs(target);
  const downloaded = await readFile(target, 'utf8');
  expect(downloaded).toContain('"Mina","Seoul"');
  expect(downloaded).toContain('"Jae","Busan"');
  expect(outside).toEqual([]);
});

test("column options form separate rows and device checkbox stays inline", async ({ page }) => {
  await page.goto("./?mode=local&lang=en");
  await page.getByRole("button", { name: "Cleaning sample", exact: true }).click();
  for (const width of [320, 768, 1280]) {
    await page.setViewportSize({ width, height: 800 });
    const panel = page.locator(".local-columns");
    if (!(await panel.getAttribute("open"))) {
      // An open boolean attribute is the empty string; inspect the DOM property instead.
      if (!(await panel.evaluate(el => (el as HTMLDetailsElement).open))) await panel.locator("summary").click();
    }
    const labels = await panel.locator("label").all();
    expect(labels.length).toBeGreaterThan(1);
    let bottom = 0;
    for (const label of labels) {
      const box = (await label.boundingBox())!;
      expect(box.y).toBeGreaterThanOrEqual(bottom);
      expect(box.x).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width).toBeLessThanOrEqual(width + 1);
      bottom = box.y + box.height;
    }
    expect(await page.locator(".local-check").first().evaluate(el => getComputedStyle(el).flexDirection)).toBe("row");
    await evidence(page, `column-options-${width}`);
  }
});

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
  await openAdvancedOperations(page);
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

test("a configured local recipe runs once, marks actual changed cells, reviews snapshots, and undoes atomically", async ({ page }) => {
  await page.goto("./?mode=local&lang=en");
  await page.getByRole("button", { name: "Open files", exact: true }).click();
  await page.locator('input[type="file"][multiple]').setInputFiles({
    name: "recipe.csv",
    mimeType: "text/csv",
    buffer: Buffer.from("Name,Status\n Mina ,open\nJae,done\n", "utf8"),
  });
  await page.getByRole("dialog", { name: "Review import" }).getByRole("button", { name: "Accept source", exact: true }).click();
  const recipe = {
    version: 1,
    name: "Disclosed status cleanup",
    primaryId: "source-recipe",
    sources: [{
      id: "source-recipe",
      name: "recipe.csv",
      columns: ["name", "status"],
      selection: { sheetName: "CSV", headerRow: 1, startColumn: 1, endColumn: 2, endRow: 3, encoding: "utf-8", delimiter: "," },
    }],
    steps: [
      { kind: "trim", columns: ["name"] },
      { kind: "replace", column: "status", from: "open", to: "ready" },
      { kind: "replace", column: "status", from: "done", to: "closed" },
    ],
  };
  await page.getByRole("button", { name: "Load recipe", exact: true }).click();
  await page.locator('input[accept="application/json,.json"]').setInputFiles({
    name: "weekly.sheet-recipe.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify(recipe)),
  });
  const mapping = page.getByRole("dialog", { name: "Match recipe sources" });
  await expect(mapping.getByRole("button", { name: "Configure one-click run", exact: true })).toBeEnabled();
  await mapping.getByRole("button", { name: "Configure one-click run", exact: true }).click();
  await expect(page.getByTestId("workflow-scope")).toHaveValue("recipe");
  await page.getByTestId("run-one-click-workflow").click();
  await expect(page.locator(".local-workflow-status")).toContainText("Completed and committed as one action.");
  const statusBox = await page.locator(".local-workflow-status").boundingBox();
  expect(statusBox).not.toBeNull();
  expect(statusBox!.y + statusBox!.height).toBeLessThanOrEqual(page.viewportSize()!.height);
  await expect(page.locator(".local-table")).toContainText("ready");
  await expect(page.locator(".local-table")).toContainText("closed");
  await expect(page.locator('[data-workflow-change="true"]')).toHaveCount(3);
  await evidence(page, "local-one-click-recipe-completed");
  await page.getByRole("button", { name: "Previous workflow step" }).click();
  await expect(page.locator(".local-workflow-preview")).toContainText("Reviewing an actual step result");
  await expect(page.locator(".local-views")).toHaveAttribute("inert", "");
  await expect(page.locator(".local-views")).toHaveAttribute("aria-disabled", "true");
  await expect(page.getByRole("button", { name: "Undo last confirmed action" })).toBeDisabled();
  await page.getByRole("button", { name: "Show latest batch result", exact: true }).click();
  await expect(page.locator(".local-views")).not.toHaveAttribute("inert", "");
  await page.getByRole("button", { name: "Undo last confirmed action" }).click();
  await expect(page.locator(".local-table")).toContainText(" Mina ");
  await expect(page.locator(".local-table")).toContainText("open");
});

test("a real one-click cancellation restores the source worksheet without draft markers", async ({ page }) => {
  await page.goto("./?mode=local&lang=en");
  await page.getByRole("button", { name: "Open files", exact: true }).click();
  await page.locator('input[type="file"][multiple]').setInputFiles({
    name: "cancel.csv", mimeType: "text/csv", buffer: Buffer.from("Name,Status\n Person 0 , waiting \n Person 1 , waiting \n", "utf8"),
  });
  await page.getByRole("dialog", { name: "Review import" }).getByRole("button", { name: "Accept source", exact: true }).click();
  const recipe = {
    version: 1,
    name: "Long explicit cleanup",
    primaryId: "source-cancel",
    sources: [{
      id: "source-cancel", name: "cancel.csv", columns: ["name", "status"],
      selection: { sheetName: "CSV", headerRow: 1, startColumn: 1, endColumn: 2, endRow: 3, encoding: "utf-8", delimiter: "," },
    }],
    // The maximum valid recipe length keeps a real worker request in flight
    // long enough to exercise the visible cancel control without test delays.
    steps: Array.from({ length: 100 }, () => ({ kind: "trim", columns: ["name", "status"] })),
  };
  await page.getByRole("button", { name: "Load recipe", exact: true }).click();
  await page.locator('input[accept="application/json,.json"]').setInputFiles({
    name: "cancel.sheet-recipe.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify(recipe)),
  });
  await page.getByRole("dialog", { name: "Match recipe sources" }).getByRole("button", { name: "Configure one-click run", exact: true }).click();
  await page.getByTestId("run-one-click-workflow").click();
  const cancel = page.locator("[data-workflow-cancel]");
  await expect(cancel).toBeVisible();
  await cancel.evaluate((button: HTMLButtonElement) => button.click());
  await expect(page.locator(".local-workflow-status")).toContainText("Cancelled — no draft changes were applied.");
  await expect(page.locator('[data-workflow-change="true"]')).toHaveCount(0);
  await expect(page.locator(".local-table td").first().locator("span")).toHaveAttribute("title", " Person 0 ");
  await expect(page.getByRole("button", { name: "Previous workflow step" })).toHaveCount(0);
});

test("a blocked later recipe step restores the original worksheet and exposes no draft review", async ({ page }) => {
  await page.goto("./?mode=local&lang=en");
  await page.getByRole("button", { name: "Open files", exact: true }).click();
  await page.locator('input[type="file"][multiple]').setInputFiles({
    name: "blocked.csv", mimeType: "text/csv", buffer: Buffer.from("Name,Status\n Mina ,open\n", "utf8"),
  });
  await page.getByRole("dialog", { name: "Review import" }).getByRole("button", { name: "Accept source", exact: true }).click();
  const recipe = {
    version: 1,
    name: "Valid then blocked cleanup",
    primaryId: "source-blocked",
    sources: [{
      id: "source-blocked", name: "blocked.csv", columns: ["name", "status"],
      selection: { sheetName: "CSV", headerRow: 1, startColumn: 1, endColumn: 2, endRow: 2, encoding: "utf-8", delimiter: "," },
    }],
    steps: [
      { kind: "trim", columns: ["name"] },
      { kind: "convert", column: "status", to: "date" },
    ],
  };
  await page.getByRole("button", { name: "Load recipe", exact: true }).click();
  await page.locator('input[accept="application/json,.json"]').setInputFiles({
    name: "blocked.sheet-recipe.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify(recipe)),
  });
  await page.getByRole("dialog", { name: "Match recipe sources" }).getByRole("button", { name: "Configure one-click run", exact: true }).click();
  await page.getByTestId("run-one-click-workflow").click();
  await expect(page.locator(".local-workflow-status")).toHaveClass(/is-failed/);
  await expect(page.locator(".local-error")).toContainText("not a real date");
  await expect(page.locator(".local-table td").first().locator("span")).toHaveAttribute("title", " Mina ");
  await expect(page.locator('[data-workflow-change="true"]')).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Previous workflow step" })).toHaveCount(0);
  await expect(page.locator(".local-export > button")).toBeEnabled();
});

test("local workbench switches Korean and stays inside a 320px viewport", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 700 });
  await page.goto("./?mode=local&lang=ko");
  await expect(page.locator('#sw-title')).toContainText('엑셀은 그대로.');
  await page.getByRole("button", { name: "파일 열기", exact: true }).click();
  await page.locator('input[type="file"][multiple]').setInputFiles(tidyCsv);
  const dialog = page.getByRole("dialog", { name: "가져오기 확인" });
  await dialog.getByRole("button", { name: "원본 받아들이기", exact: true }).click();
  const exportButton = page.getByRole("button", { name: /내보내기/ });
  const box = await exportButton.boundingBox();
  expect(box).not.toBeNull();
  expect(box!.x + box!.width).toBeLessThanOrEqual(320);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  for (const width of [320, 390, 430]) {
    await page.setViewportSize({ width, height: 700 });
    for (const button of await page.locator('.local-top-actions button').all()) {
      await expect(button).toBeVisible();
      const bounds = await button.boundingBox();
      expect(bounds!.x).toBeGreaterThanOrEqual(0);
      expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(width);
    }
    expect(await page.locator('.local-top-actions').evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
  }
  await page.setViewportSize({ width: 320, height: 700 });
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
  await openAdvancedOperations(page);
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
  await openAdvancedOperations(page);
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
  await openAdvancedOperations(page);
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
  await openAdvancedOperations(page);
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
  await openAdvancedOperations(page);
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
  await expect(page.locator('#sw-title')).toContainText('Keep the spreadsheet.');
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
