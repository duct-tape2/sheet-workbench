import { test, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  createCompanionService,
  createSyntheticWorkbook,
} from "../../packages/companion/src/index";

test("real loopback server accepts authenticated browser GET and multipart only from its own origin", async ({
  page,
}) => {
  const dataDir = await mkdtemp(
    path.join(os.tmpdir(), "sw-browser-companion-"),
  );
  const service = await createCompanionService({
    serveWeb: false,
    port: 0,
    dataDir,
  });
  try {
    const started = await service.start();
    await page.goto(started.url);
    const result = await page.evaluate(async () => {
      const token = document.cookie
        .split(";")
        .find((c) => c.trim().startsWith("companion_csrf="))!
        .trim()
        .slice(15);
      const valid = await fetch("/companion/health", {
        headers: { "X-Companion-CSRF": token },
      });
      const denied = await fetch("/companion/health");
      return { valid: valid.status, denied: denied.status };
    });
    expect(result).toEqual({ valid: 200, denied: 403 });
    const bytes = Array.from(
      createSyntheticWorkbook({
        sheetName: "Inputs",
        rows: [{ label: "SYNTHETIC", amount: 100 }],
      }),
    );
    const upload = await page.evaluate(async (data) => {
      const token = document.cookie
        .split(";")
        .find((c) => c.trim().startsWith("companion_csrf="))!
        .trim()
        .slice(15);
      const body = new FormData();
      body.append("file", new File([new Uint8Array(data)], "synthetic.xlsx"));
      const response = await fetch("/companion/files", {
        method: "POST",
        body,
        headers: { "X-Companion-CSRF": token },
      });
      const { file } = await response.json();
      const profile = await fetch(`/companion/files/${file.id}/profile`, {
        headers: { "X-Companion-CSRF": token },
      });
      return { upload: response.status, profile: profile.status };
    }, bytes);
    expect(upload).toEqual({ upload: 200, profile: 200 });
  } finally {
    await service.close();
    if (
      path.dirname(dataDir) !== path.resolve(os.tmpdir()) ||
      !path.basename(dataDir).startsWith("sw-browser-companion-")
    )
      throw new Error("Unsafe temporary cleanup target");
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("public work mode never probes a PC; guide fits small screens", async ({
  page,
}, info) => {
  const requests: string[] = [];
  page.on("request", (r) => {
    if (r.url().includes("/companion/")) requests.push(r.url());
  });
  await page.goto("/?mode=work&lang=ko");
  await expect(
    page.getByRole("heading", { name: "Windows PC에서 시작해 주세요" }),
  ).toBeVisible();
  for (const width of [320, 390, 768, 1280]) {
    await page.setViewportSize({ width, height: 800 });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await page.screenshot({
      path: `.local/workflow-review/guide-${info.project.name}-${width}.png`,
      fullPage: true,
    });
  }
  expect(requests).toEqual([]);
  expect(
    (await new AxeBuilder({ page }).include(".work-continuation").analyze())
      .violations,
  ).toEqual([]);
});

test("review uses evidence and exact values; retry keeps operation id; download uses CSRF", async ({
  page,
  context,
}, info) => {
  await context.addCookies([
    {
      name: "companion_csrf",
      value: "test-csrf",
      url: "http://127.0.0.1:4189",
    },
  ]);
  let uploaded = 0,
    failedOnce = false;
  const ids: string[] = [];
  await page.route("**/companion/**", async (route) => {
    const req = route.request(),
      path = new URL(req.url()).pathname;
    expect(req.headers()["x-companion-csrf"]).toBe("test-csrf");
    const json = (value: unknown) => route.fulfill({ json: value });
    if (path.endsWith("/health"))
      return json({
        ok: true,
        version: "test",
        capabilities: {
          excel: true,
          xlwings: true,
          docling: false,
          ollama: true,
        },
        limits: { uploadBytes: 100000, profileCellsPerSheet: 100 },
        cloud: {
          configured: true,
          provider: "https://synthetic-provider.invalid",
          model: "test-only",
        },
      });
    if (path.endsWith("/files"))
      return json({
        file: {
          id: ++uploaded === 1 ? "book" : "note",
          name: uploaded === 1 ? "original.xlsx" : "conversation.txt",
          size: 10,
          sha256: "a".repeat(64),
          kind: uploaded === 1 ? "xlsx" : "text",
          status: "ready",
        },
      });
    if (path.endsWith("/profile"))
      return json({
        profile: {
          sheets: [
            {
              name: "Inputs",
              hidden: false,
              populatedCells: [
                { address: "B2", value: 100 },
                { address: "C2", value: 200, formula: "=B2*2" },
              ],
              truncated: false,
            },
          ],
          flags: {},
          readOnlyReasons: [],
        },
      });
    if (path.endsWith("/extract"))
      return json({ extract: { content: "E001 allowance 150" } });
    if (path.endsWith("/ai/propose")) {
      expect(req.postDataJSON().mode).toBe("local");
      return json({
        summary: "Confirmed adjustment",
        questions: [],
        changes: [
          {
            sheet: "Inputs",
            address: "B2",
            before: 100,
            after: 150,
            evidence: [
              { fileId: "note", line: 1, quote: "E001 allowance 150" },
            ],
          },
        ],
      });
    }
    if (path.endsWith("/runs")) {
      const body = req.postDataJSON();
      ids.push(body.patch.requestId);
      expect(body.patch.changes[0].before).toBe(100);
      if (!failedOnce) {
        failedOnce = true;
        return route.fulfill({
          status: 503,
          json: { message: "Temporary failure" },
        });
      }
      return json({
        id: "run1",
        status: "draft",
        verification: "native-excel",
        download: "/companion/runs/run1/download",
      });
    }
    if (path.endsWith("/download"))
      return route.fulfill({
        body: Buffer.from("synthetic-download"),
        contentType:
          "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      });
    return route.abort();
  });
  await page.goto("/?mode=work&lang=ko");
  await page.getByLabel("기존 업무 파일 (.xlsx)").setInputFiles({
    name: "original.xlsx",
    mimeType: "application/octet-stream",
    buffer: Buffer.from("synthetic"),
  });
  await expect(page.getByText("original.xlsx ·")).toBeVisible();
  await page.getByLabel("또는 대화 붙여넣기").fill("E001 allowance 150");
  await page.getByRole("button", { name: "붙여넣은 내용 추가" }).click();
  await expect(
    page.locator("summary").filter({ hasText: "conversation.txt" }),
  ).toBeVisible();
  await page.getByLabel("대상 기간").fill("2026-10");
  await page.getByLabel("무엇을 바꿔야").fill("Update allowance");
  await page
    .getByLabel("확인한 업무 규칙")
    .fill("Match employee ID E001; preserve all formulas.");
  await page.getByLabel("AI 처리 위치").selectOption("cloud");
  await expect(
    page.getByRole("button", { name: "선택한 자료를 전송하고 변경안 만들기" }),
  ).toBeDisabled();
  await expect(page.getByRole("note")).toContainText(
    "synthetic-provider.invalid",
  );
  await page
    .getByLabel("이번 자료 전송과 제공자 비용 발생을 확인하고 동의합니다.")
    .check();
  await expect(
    page.getByRole("button", { name: "선택한 자료를 전송하고 변경안 만들기" }),
  ).toBeEnabled();
  await page.getByLabel("AI 처리 위치").selectOption("local");
  await page.getByRole("button", { name: "로컬 AI로 변경안 만들기" }).click();
  await expect(page.getByText("Inputs!B2")).toBeVisible();
  await expect(
    page.getByRole("button", { name: "작업 복사본 만들기" }),
  ).toBeDisabled();
  await page.getByLabel("근거·기간·모든 변경 내용을 확인했습니다.").check();
  await page.getByRole("button", { name: "작업 복사본 만들기" }).click();
  await expect(page.getByRole("alert")).toContainText("Temporary failure");
  await page.getByRole("button", { name: "작업 복사본 만들기" }).click();
  await expect(
    page.getByRole("heading", { name: "초안 — 검토 필요" }),
  ).toBeVisible();
  expect(ids).toHaveLength(2);
  expect(ids[0]).toBe(ids[1]);
  const download = page.waitForEvent("download");
  await page
    .getByRole("button", { name: "작업본 다운로드", exact: true })
    .click();
  expect((await download).suggestedFilename()).toBe("work-copy-run1.xlsx");
  await page.setViewportSize({ width: 320, height: 800 });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: `.local/workflow-review/result-${info.project.name}.png`,
    fullPage: true,
  });
  expect(
    (await new AxeBuilder({ page }).include(".work-continuation").analyze())
      .violations,
  ).toEqual([]);
});
