import { test, expect, type Page } from "@playwright/test";
import { PGlite } from "@electric-sql/pglite";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";
import { Pool } from "pg";
import { randomBytes } from "node:crypto";
import path from "node:path";
import { readFile } from "node:fs/promises";
import { createServer } from "../../apps/server/src/server";
import { migrate } from "../../apps/server/src/schema";
import staticPlugin from "@fastify/static";
import {
  createServer as createNetworkServer,
  type AddressInfo,
} from "node:net";

test("real auth and database: register, create team, import XLSX, edit and download", async ({
  page,
}) => {
  test.setTimeout(60000);
  if (test.info().project.name === "webkit")
    await page.setViewportSize({ width: 320, height: 844 });
  const db = await PGlite.create();
  const wire = new PGLiteSocketServer({ db, host: "127.0.0.1", port: 0 });
  await wire.start();
  const pool = new Pool({
    connectionString: `postgresql://postgres@${wire.getServerConn()}/postgres`,
    max: 1,
  });
  await migrate(pool);
  const port = await new Promise<number>((resolve, reject) => {
    const socket = createNetworkServer();
    socket.on("error", reject);
    socket.listen(0, "127.0.0.1", () => {
      const free = (socket.address() as AddressInfo).port;
      socket.close(() => resolve(free));
    });
  });
  const address = `http://127.0.0.1:${port}`;
  const app = createServer({
    db: pool,
    authConfig: {
      secret: randomBytes(48).toString("base64url"),
      baseURL: address,
      trustedOrigins: [address],
    },
    trustedOrigins: [address],
    storageLabel: "Isolated synthetic test database",
  });
  await app.register(staticPlugin, { root: path.resolve("dist/web") });
  await app.listen({ host: "127.0.0.1", port });
  let companion: Page | undefined;
  try {
    await page.goto(address);
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    const modal = page.getByRole("dialog");
    await modal
      .getByRole("button", { name: "Create account", exact: true })
      .click();
    await modal
      .getByLabel("Name", { exact: true })
      .fill("Synthetic Team Tester");
    await modal
      .getByLabel("Email address", { exact: true })
      .fill("browser-team@example.test");
    await modal
      .getByLabel("Password", { exact: true })
      .fill("Test-only-secure-password-32842");
    await modal
      .getByRole("button", { name: "Create account", exact: true })
      .click();
    await modal.getByLabel("Workspace name").fill("Sample office");
    await modal
      .getByRole("button", { name: "Create workspace", exact: true })
      .click();
    await expect(
      modal.getByRole("heading", { name: "Invite teammate" }),
    ).toBeVisible();
    await modal
      .getByRole("button", { name: "Close", exact: true })
      .last()
      .click();
    await page
      .getByRole("button", { name: "Connect data", exact: true })
      .click();
    await page.getByRole("checkbox").check();
    await page
      .locator("input[type=file]")
      .setInputFiles(path.resolve("samples/team.xlsx"));
    await expect(page.getByRole("dialog")).toContainText("Match your columns");
    await page
      .getByRole("button", { name: "Import reviewed data", exact: true })
      .click();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(page.locator(".source-status")).toContainText("Excel file");
    companion = await page.context().newPage();
    await companion.goto(address);
    await companion.locator(".workspace-switch").click();
    await companion.getByRole("dialog").locator(".workspace-item").click();
    await companion
      .getByRole("button", { name: "Report", exact: true })
      .click();
    await companion
      .getByLabel("Period start", { exact: true })
      .fill("2026-09-01");
    await companion
      .getByLabel("Period end", { exact: true })
      .fill("2026-09-30");
    await page.getByRole("button", { name: "Table", exact: true }).click();
    await page.locator(".record-link").first().click();
    await modal
      .getByLabel("Task", { exact: true })
      .fill("Team import edited in browser");
    await modal
      .getByRole("button", { name: "Save changes", exact: true })
      .click();
    await expect(page.locator(".record-link").first()).toContainText(
      "Team import edited in browser",
    );
    await expect(
      companion
        .locator(".report-row")
        .filter({ hasText: "Team import edited in browser" }),
    ).toHaveCount(1);
    await companion.close();
    companion = undefined;
    await page.getByRole("button", { name: "Export", exact: true }).click();
    const download = page.waitForEvent("download");
    await modal
      .getByRole("button", { name: "Download Excel", exact: true })
      .click();
    const file = await download;
    expect(file.suggestedFilename()).toBe("team.xlsx");
    await modal
      .getByRole("button", { name: "Close", exact: true })
      .last()
      .click();
    await page.locator(".workspace-switch").click();
    const backupEvent = page.waitForEvent("download");
    await modal
      .getByRole("button", { name: "Download backup", exact: true })
      .click();
    const backup = await backupEvent;
    const backupBytes = await readFile((await backup.path())!);
    const archived = JSON.parse(backupBytes.toString()).datasets[0].snapshot;
    expect(archived.records[0].values[archived.mapping.title]).toBe(
      "Team import edited in browser",
    );
    await modal.getByLabel("Workspace backup file").setInputFiles({
      name: "synthetic-backup.json",
      mimeType: "application/json",
      buffer: backupBytes,
    });
    await modal
      .getByLabel("New workspace name (optional)", { exact: true })
      .fill("Restored sample office");
    await modal
      .getByRole("button", { name: "Restore backup", exact: true })
      .click();
    await expect(modal.getByRole("status")).toContainText(
      "Restored into a new workspace",
    );
    await modal
      .getByRole("button", { name: "Close", exact: true })
      .last()
      .click();
    await expect(page.locator(".record-link").first()).toContainText(
      "Team import edited in browser",
    );
    await page
      .getByRole("button", { name: "Change history", exact: true })
      .click();
    await modal
      .getByRole("button", { name: "Undo", exact: true })
      .first()
      .click();
    await modal
      .getByRole("button", { name: "Close", exact: true })
      .last()
      .click();
    await expect(page.locator(".record-link").first()).not.toContainText(
      "Team import edited in browser",
    );
    await page.locator(".workspace-switch").click();
    await modal.getByText("Delete this workspace", { exact: true }).click();
    const deleteButton = modal.getByRole("button", {
      name: "Delete workspace",
      exact: true,
    });
    await expect(deleteButton).toBeDisabled();
    await modal
      .getByLabel("Type the exact workspace name", { exact: false })
      .fill("Restored sample office");
    await deleteButton.click();
    await expect(modal).toHaveCount(0);
    await expect(page.locator(".workspace-switch")).toContainText(
      "Sample workspace",
    );
    await page.locator(".workspace-switch").click();
    await expect(modal.locator(".workspace-item")).toHaveCount(1);
    await expect(modal.locator(".workspace-item")).toContainText(
      "Sample office",
    );
    await modal.locator(".workspace-item").click();
    await expect(page.locator(".record-link").first()).toContainText(
      "Team import edited in browser",
    );
    await page.screenshot({
      path: test.info().outputPath("team-real-auth.png"),
      fullPage: true,
    });
    const viewport = page.viewportSize()!;
    for (const button of await page
      .locator(".dataset-actions button,.account-button,.view-tabs button")
      .all()) {
      const box = await button.boundingBox();
      expect(box!.x).toBeGreaterThanOrEqual(0);
      expect(box!.x + box!.width).toBeLessThanOrEqual(viewport.width);
    }
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
  } finally {
    await companion?.close().catch(() => undefined);
    if (!page.isClosed()) await page.goto("about:blank").catch(() => undefined);
    await app.close();
    await pool.end();
    await wire.stop();
    await db.close();
  }
});
