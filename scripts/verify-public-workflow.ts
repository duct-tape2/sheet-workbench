import { chromium, webkit } from "@playwright/test";
import { mkdir } from "node:fs/promises";

const base = new URL(
  process.argv[2] ?? "https://duct-tape2.github.io/sheet-workbench/",
);
if (base.protocol !== "https:")
  throw new Error("Public verification requires HTTPS.");
await mkdir(".local/public-workflow", { recursive: true });
for (const [name, engine] of [
  ["chromium", chromium],
  ["webkit", webkit],
] as const) {
  const browser = await engine.launch();
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    locale: "ko-KR",
    reducedMotion: "reduce",
  });
  try {
    const page = await context.newPage();
    const requests: string[] = [];
    page.on("request", (request) => requests.push(request.url()));
    const response = await page.goto(new URL("?lang=ko", base).href);
    if (response?.status() !== 200) throw new Error("Public home unavailable.");
    const demo = page.locator(".sw-demo");
    await demo.scrollIntoViewIfNeeded();
    await demo
      .getByRole("button", { name: "30초 작업 흐름 영상 재생" })
      .click();
    const video = demo.locator("video");
    await page.waitForFunction(() => {
      const element =
        document.querySelector<HTMLVideoElement>(".sw-demo video");
      return (
        element &&
        element.currentTime > 0.1 &&
        Math.abs(element.duration - 30) < 0.1
      );
    });
    if (!new URL((await video.getAttribute("src")) ?? "", base).pathname.endsWith("ko-mobile.mp4"))
      throw new Error("Wrong mobile video.");
    await demo
      .getByRole("button", { name: "시연 일시 정지", exact: true })
      .click();
    await demo.screenshot({
      path: `.local/public-workflow/${name}-mobile-video.png`,
    });
    await page.goto(new URL("?mode=work&lang=ko", base).href);
    await page.locator(".work-continuation").waitFor();
    if (await page.locator('input[type="file"]').count())
      throw new Error("Public PC mode exposed uploads.");
    if (
      requests.some((url) =>
        /https?:\/\/(?:127\.0\.0\.1|localhost)(?::|\/)/.test(url),
      )
    )
      throw new Error("Public page probed the PC.");
    const overflows = await page.evaluate(
      () => document.documentElement.scrollWidth > innerWidth + 1,
    );
    if (overflows) throw new Error("Mobile public guide overflows.");
    await page.screenshot({
      path: `.local/public-workflow/${name}-mobile-guide.png`,
      fullPage: true,
    });
    console.log(
      `PUBLIC_WORKFLOW_OK ${name} mobile_mp4_30s=true guide_readonly=true pc_probes=0`,
    );
  } finally {
    await context.close();
    await browser.close();
  }
}
