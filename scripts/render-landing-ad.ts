import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { chromium } from "@playwright/test";

const execFileAsync = promisify(execFile);
const fps = 30;
const durationSeconds = 30;
const frameCount = fps * durationSeconds;
const root = resolve(process.cwd());
const evidenceRoot = resolve(root, "..", ".local", "ad-video");
const publicMediaRoot = resolve(root, "apps", "web", "public", "media");

type Locale = "en" | "ko";
type Shape = "desktop" | "mobile";
type Variant = {
  locale: Locale;
  shape: Shape;
  width: number;
  height: number;
};

const variants: Variant[] = [
  { locale: "en", shape: "desktop", width: 1280, height: 720 },
  { locale: "ko", shape: "desktop", width: 1280, height: 720 },
  { locale: "en", shape: "mobile", width: 800, height: 1000 },
  { locale: "ko", shape: "mobile", width: 800, height: 1000 },
];

const content = {
  en: {
    eyebrow: "SHEET WORKBENCH · LOCAL FILE TOOLS",
    title: "Keep the spreadsheet.\nLose the busywork.",
    note: "Synthetic illustration · nothing is uploaded",
    files: "1  OPEN TWO FILES",
    map: "2  MATCH THE COLUMNS",
    review: "3  REVIEW THE RESULT",
    export: "4  EXPORT A NEW FILE",
    current: "Current file",
    incoming: "Incoming file",
    source: "contacts.csv",
    added: "incoming.csv",
    name: "Name",
    city: "City",
    status: "Status",
    match: "Name  ↔  Name     City  ↔  City",
    matched: "Columns paired before rows are added",
    reviewTitle: "1 row will be added",
    reviewNote: "Original file stays unchanged",
    result: "contacts-result.csv",
    ready: "Checked result ready to export",
    final: "See what changes.\nThen take the result.",
    action: "Open local files",
  },
  ko: {
    eyebrow: "SHEET WORKBENCH · 로컬 파일 도구",
    title: "엑셀은 그대로.\n반복 작업은 덜어내세요.",
    note: "가상 자료 예시 · 파일을 업로드하지 않습니다",
    files: "1  두 파일 열기",
    map: "2  열 연결하기",
    review: "3  결과 확인하기",
    export: "4  새 파일로 내보내기",
    current: "현재 파일",
    incoming: "추가 파일",
    source: "contacts.csv",
    added: "incoming.csv",
    name: "이름",
    city: "지역",
    status: "상태",
    match: "이름  ↔  이름     지역  ↔  지역",
    matched: "행을 더하기 전에 같은 열끼리 연결합니다",
    reviewTitle: "추가될 행 1개",
    reviewNote: "원본 파일은 바뀌지 않습니다",
    result: "contacts-result.csv",
    ready: "확인한 결과를 새 파일로",
    final: "바뀔 내용을 확인하고.\n결과만 가져가세요.",
    action: "로컬 파일 열기",
  },
} as const;

const hash = (buffer: Buffer) =>
  createHash("sha256").update(buffer).digest("hex");

const run = async (command: string, args: string[]) => {
  const { stdout, stderr } = await execFileAsync(command, args, {
    windowsHide: true,
    maxBuffer: 12 * 1024 * 1024,
  });
  return { stdout, stderr };
};

const escapeHtml = (value: string) =>
  value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

const lines = (value: string) => escapeHtml(value).replace(/\n/g, "<br />");

async function bundledFontFaces() {
  const fonts = [
    { family: "AdGeist", weight: 400, file: "geist-latin-400-normal.woff2" },
    { family: "AdGeist", weight: 500, file: "geist-latin-500-normal.woff2" },
    { family: "AdGeist", weight: 700, file: "geist-latin-700-normal.woff2" },
    {
      family: "AdMono",
      weight: 500,
      file: "ibm-plex-mono-latin-500-normal.woff2",
    },
    {
      family: "AdMono",
      weight: 700,
      file: "ibm-plex-mono-latin-700-normal.woff2",
    },
  ] as const;
  const sources = await Promise.all(
    fonts.map(async ({ family, weight, file }) => {
      const packageName = family === "AdGeist" ? "geist" : "ibm-plex-mono";
      const source = await readFile(
        resolve(
          root,
          "node_modules",
          "@fontsource",
          packageName,
          "files",
          file,
        ),
        "base64",
      );
      return `@font-face { font-family: "${family}"; src: url(data:font/woff2;base64,${source}) format("woff2"); font-weight: ${weight}; font-style: normal; font-display: block; }`;
    }),
  );
  return sources.join("\n");
}

function pageHtml(locale: Locale, shape: Shape, fontFaces: string) {
  const t = content[locale];
  return `<!doctype html>
<html lang="${locale}">
<head>
  <meta charset="utf-8" />
  <style>
    ${fontFaces}
    * { box-sizing: border-box; }
    :root { --sans: "AdGeist", "Malgun Gothic", "Apple SD Gothic Neo", "Segoe UI", sans-serif; --mono: "AdMono", "Malgun Gothic", "Segoe UI", monospace; }
    html, body { width: 100%; height: 100%; margin: 0; overflow: hidden; }
    body {
      color: #1c2825;
      background: #f3f0e9;
      font-family: var(--sans);
    }
    .film {
      position: relative;
      width: 100%; height: 100%; overflow: hidden;
      padding: ${shape === "mobile" ? "64px 48px" : "52px 68px"};
      background:
        radial-gradient(circle at 12% 10%, rgba(87, 124, 111, .13), transparent 24%),
        radial-gradient(circle at 86% 86%, rgba(191, 168, 119, .14), transparent 25%),
        #f3f0e9;
    }
    .grain { position: absolute; inset: 0; opacity: .14; background-image: radial-gradient(#182520 0.6px, transparent .65px); background-size: 5px 5px; mix-blend-mode: multiply; pointer-events: none; }
    .topline { position: relative; display: flex; align-items: center; justify-content: space-between; padding-bottom: 15px; border-bottom: 1px solid #bdc7c0; color: #536a60; font: 600 13px/1.2 var(--mono); letter-spacing: 1.45px; }
    .topline b { color: #215948; font-weight: 700; }
    .headline { position: relative; margin: ${shape === "mobile" ? "54px 0 30px" : "42px 0 28px"}; font-size: ${shape === "mobile" ? "54px" : "52px"}; font-weight: 700; line-height: .98; letter-spacing: -2.7px; word-break: keep-all; }
    .headline em { color: #2d7d62; font-style: normal; }
    .stage { position: relative; height: ${shape === "mobile" ? "660px" : "430px"}; overflow: hidden; border: 1px solid #bbc6bf; background: rgba(255,255,252,.56); box-shadow: 0 18px 36px rgba(42, 58, 51, .10); }
    .stage::before { position: absolute; inset: 0; content: ""; background: linear-gradient(90deg, rgba(36, 94, 73,.05) 1px, transparent 1px), linear-gradient(rgba(36, 94, 73,.05) 1px, transparent 1px); background-size: 42px 42px; opacity: .5; }
    .step { position: absolute; inset: 0; opacity: 0; transform: translateY(18px) scale(.985); will-change: transform, opacity; }
    .step-title { position: absolute; top: 34px; left: 38px; color: #235e4a; font: 700 13px/1.2 var(--mono); letter-spacing: 1.2px; }
    .sheet { position: absolute; display: grid; gap: 0; border: 1px solid #859b90; background: #fffefb; box-shadow: 0 14px 22px rgba(39, 55, 48,.13); }
    .sheet header { padding: 13px 15px 10px; border-bottom: 1px solid #bac5be; color: #225945; font: 700 12px/1.1 var(--mono); letter-spacing: .7px; }
    .sheet p { margin: 0; padding: 12px 15px; border-bottom: 1px solid #d6ddd8; font: 400 16px/1.1 var(--sans); }
    .sheet p:last-child { border-bottom: 0; }
    .sheet .head { color: #637a6f; background: #edf1ed; font: 700 11px/1.1 var(--mono); letter-spacing: .5px; }
    .file-one { top: ${shape === "mobile" ? "110px" : "102px"}; left: ${shape === "mobile" ? "54px" : "96px"}; width: ${shape === "mobile" ? "300px" : "280px"}; }
    .file-two { top: ${shape === "mobile" ? "360px" : "152px"}; right: ${shape === "mobile" ? "54px" : "98px"}; width: ${shape === "mobile" ? "300px" : "280px"}; }
    .connector { position: absolute; width: ${shape === "mobile" ? "96px" : "170px"}; height: 2px; background: #2d7d62; transform-origin: left; }
    .connector::after { position: absolute; right: -5px; top: -4px; width: 8px; height: 8px; border-radius: 50%; content: ""; background: #2d7d62; }
    .connector-one { top: ${shape === "mobile" ? "335px" : "220px"}; left: ${shape === "mobile" ? "330px" : "355px"}; transform: rotate(${shape === "mobile" ? "45deg" : "9deg"}); }
    .connector-two { top: ${shape === "mobile" ? "390px" : "252px"}; left: ${shape === "mobile" ? "350px" : "430px"}; transform: rotate(${shape === "mobile" ? "-48deg" : "-7deg"}); }
    .mapping-card, .review-card, .export-card, .final-card { position: absolute; border: 1px solid #8ea297; background: #fffefb; box-shadow: 0 14px 24px rgba(39,55,48,.12); }
    .mapping-card { top: ${shape === "mobile" ? "185px" : "126px"}; left: 50%; width: ${shape === "mobile" ? "530px" : "620px"}; padding: 31px; transform: translateX(-50%); }
    .mapping-card .pair { display: grid; grid-template-columns: 1fr 50px 1fr; align-items: center; padding: 18px 0; border-top: 1px solid #d1dad3; font-size: ${shape === "mobile" ? "25px" : "22px"}; }
    .mapping-card .step-title, .review-card .step-title, .export-card .step-title { position: static; margin: 0; }
    .mapping-card .pair:first-of-type { margin-top: 16px; }
    .mapping-card .arrow { color: #28785e; text-align: center; font-family: var(--mono); }
    .mapping-card small, .review-card small, .export-card small { color: #637a6f; font: 12px/1.4 var(--mono); letter-spacing: .25px; }
    .review-card { top: ${shape === "mobile" ? "156px" : "108px"}; left: 50%; width: ${shape === "mobile" ? "535px" : "650px"}; padding: 32px; transform: translateX(-50%); }
    .review-card h2, .export-card h2 { margin: 10px 0 21px; font-size: ${shape === "mobile" ? "34px" : "35px"}; font-weight: 700; line-height: 1.03; letter-spacing: -1.5px; word-break: keep-all; overflow-wrap: normal; }
    .check-row { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 15px 0; border-top: 1px solid #d1dad3; font-size: ${shape === "mobile" ? "22px" : "18px"}; }
    .check { display: grid; width: 23px; height: 23px; place-items: center; border-radius: 50%; color: #fffefb; background: #2c7a60; font: 700 15px/1 var(--sans); }
    .export-card { top: ${shape === "mobile" ? "182px" : "124px"}; left: 50%; width: ${shape === "mobile" ? "540px" : "630px"}; padding: 32px; transform: translateX(-50%); }
    .export-file { display: flex; align-items: center; justify-content: space-between; gap: 18px; padding: 18px; border: 1px solid #98aa9f; background: #ecf4ee; color: #235f4b; font: 700 ${shape === "mobile" ? "24px" : "21px"}/1.1 var(--mono); }
    .export-file b { color: #2f7e63; font-size: 24px; }
    .final-card { top: ${shape === "mobile" ? "172px" : "100px"}; left: 50%; width: ${shape === "mobile" ? "535px" : "660px"}; padding: 48px 42px; text-align: center; transform: translateX(-50%); }
    .final-card h2 { margin: 9px 0 27px; font-size: ${shape === "mobile" ? "46px" : "42px"}; font-weight: 700; line-height: .98; letter-spacing: -2px; word-break: keep-all; }
    .final-card button { padding: 16px 24px; border: 0; color: #fffefb; background: #1d624b; font: 700 14px/1 var(--mono); letter-spacing: .4px; }
    .progress { position: absolute; right: 34px; bottom: 29px; left: 34px; height: 3px; overflow: hidden; background: #d5ddd8; }
    .progress i { display: block; width: 0; height: 100%; background: #2b7b60; }
    .footnote { position: absolute; right: 0; bottom: ${shape === "mobile" ? "26px" : "0"}; left: 0; color: #667a70; font: 11px/1.2 var(--mono); letter-spacing: .45px; text-align: center; }
  </style>
</head>
<body>
  <main class="film">
    <div class="grain"></div>
    <header class="topline"><span>${escapeHtml(t.eyebrow)}</span><b>30 SEC</b></header>
    <h1 class="headline">${lines(t.title)}</h1>
    <section class="stage" aria-label="${escapeHtml(t.note)}">
      <div class="step" id="files">
        <p class="step-title">${escapeHtml(t.files)}</p>
        <article class="sheet file-one"><header>${escapeHtml(t.current)} · ${escapeHtml(t.source)}</header><p class="head">${escapeHtml(t.name)} · ${escapeHtml(t.city)}</p><p>Mina · Seoul</p></article>
        <article class="sheet file-two"><header>${escapeHtml(t.incoming)} · ${escapeHtml(t.added)}</header><p class="head">${escapeHtml(t.name)} · ${escapeHtml(t.city)}</p><p>Jae · Busan</p></article>
        <i class="connector connector-one"></i><i class="connector connector-two"></i>
      </div>
      <div class="step" id="mapping">
        <article class="mapping-card"><p class="step-title">${escapeHtml(t.map)}</p><div class="pair"><span>${escapeHtml(t.name)}</span><span class="arrow">↔</span><span>${escapeHtml(t.name)}</span></div><div class="pair"><span>${escapeHtml(t.city)}</span><span class="arrow">↔</span><span>${escapeHtml(t.city)}</span></div><small>${escapeHtml(t.matched)}</small></article>
      </div>
      <div class="step" id="review">
        <article class="review-card"><p class="step-title">${escapeHtml(t.review)}</p><h2>${escapeHtml(t.reviewTitle)}</h2><div class="check-row"><span>Jae · Busan</span><b class="check">✓</b></div><div class="check-row"><span>${escapeHtml(t.reviewNote)}</span><b class="check">✓</b></div><small>${escapeHtml(t.match)}</small></article>
      </div>
      <div class="step" id="export">
        <article class="export-card"><p class="step-title">${escapeHtml(t.export)}</p><h2>${escapeHtml(t.ready)}</h2><div class="export-file"><span>${escapeHtml(t.result)}</span><b>↓</b></div><small>${escapeHtml(t.note)}</small></article>
      </div>
      <div class="step" id="final">
        <article class="final-card"><small>${escapeHtml(t.note)}</small><h2>${lines(t.final)}</h2><button type="button">${escapeHtml(t.action)} →</button></article>
      </div>
      <div class="progress"><i id="progress"></i></div>
    </section>
    <p class="footnote">${escapeHtml(t.note)}</p>
  </main>
  <script>
    const clamp = (value, min = 0, max = 1) => Math.min(max, Math.max(min, value));
    const ease = value => { const p = clamp(value); return p * p * (3 - 2 * p); };
    const between = (seconds, start, end) => ease((seconds - start) / (end - start));
    const layers = [
      ["files", 0, 8.0],
      ["mapping", 7.6, 14.7],
      ["review", 14.3, 22.0],
      ["export", 21.6, 28.0],
      ["final", 27.6, 30.0],
    ];
    window.renderAt = milliseconds => {
      const seconds = clamp(milliseconds / 1000, 0, 30);
      layers.forEach(([id, start, end]) => {
        const inProgress = id === "files" ? 1 : between(seconds, start, start + .4);
        const outProgress = id === "final" ? 0 : between(seconds, end - .4, end);
        const opacity = inProgress * (1 - outProgress);
        const layer = document.getElementById(id);
        layer.style.opacity = opacity.toFixed(5);
        layer.style.transform = 'translateY(' + ((1 - opacity) * 20).toFixed(3) + 'px) scale(' + (0.985 + opacity * .015).toFixed(5) + ')';
      });
      document.getElementById("progress").style.width = ((seconds / 30) * 100).toFixed(4) + "%";
    };
    window.renderAt(0);
  </script>
</body>
</html>`;
}

type Probe = {
  streams: Array<{
    codec_name: string;
    width: number;
    height: number;
    r_frame_rate: string;
    nb_read_frames: string;
  }>;
  format: { duration: string; size: string };
};

const frameName = (index: number) =>
  `frame-${String(index).padStart(4, "0")}.png`;

async function inspectVideo(output: string, expected: Variant) {
  await run("ffmpeg", ["-v", "error", "-i", output, "-f", "null", "-"]);
  const { stdout } = await run("ffprobe", [
    "-v",
    "error",
    "-count_frames",
    "-select_streams",
    "v:0",
    "-show_entries",
    "stream=codec_name,width,height,r_frame_rate,nb_read_frames:format=duration,size",
    "-of",
    "json",
    output,
  ]);
  const probe = JSON.parse(stdout) as Probe;
  const stream = probe.streams[0];
  const duration = Number(probe.format.duration);
  const frames = Number(stream.nb_read_frames);
  if (
    stream.codec_name !== "h264" ||
    stream.width !== expected.width ||
    stream.height !== expected.height ||
    stream.r_frame_rate !== "30/1" ||
    frames !== frameCount ||
    Math.abs(duration - durationSeconds) > 0.05
  ) {
    throw new Error(`Unexpected video metadata for ${output}: ${stdout}`);
  }

  const decoded = await run("ffprobe", [
    "-v",
    "error",
    "-select_streams",
    "v:0",
    "-show_entries",
    "frame=best_effort_timestamp_time",
    "-of",
    "csv=p=0",
    output,
  ]);
  const timestamps = decoded.stdout
    .trim()
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => Number(line.split(",")[0]))
    .filter(Number.isFinite);
  const maximumGap = timestamps
    .slice(1)
    .reduce(
      (largest, timestamp, index) =>
        Math.max(largest, timestamp - timestamps[index]),
      0,
    );
  if (timestamps.length !== frameCount || maximumGap > 1 / fps + 0.002) {
    throw new Error(`Decoded continuity check failed for ${output}`);
  }

  return {
    codec: stream.codec_name,
    width: stream.width,
    height: stream.height,
    frameRate: stream.r_frame_rate,
    duration,
    decodedFrames: timestamps.length,
    maxTimestampGapSeconds: maximumGap,
    sizeBytes: Number(probe.format.size),
  };
}

async function renderVariant(
  browser: Awaited<ReturnType<typeof chromium.launch>>,
  variant: Variant,
  fontFaces: string,
) {
  const id = `${variant.locale}-${variant.shape}`;
  const frameDirectory = resolve(evidenceRoot, "frames", id);
  const snapshotDirectory = resolve(evidenceRoot, "snapshots");
  const output = resolve(publicMediaRoot, `landing-demo-${id}.mp4`);
  const poster = resolve(publicMediaRoot, `landing-demo-${id}.jpg`);
  await rm(frameDirectory, { recursive: true, force: true });
  await mkdir(frameDirectory, { recursive: true });
  await mkdir(snapshotDirectory, { recursive: true });

  const context = await browser.newContext({
    viewport: { width: variant.width, height: variant.height },
    deviceScaleFactor: 1,
  });
  const page = await context.newPage();
  await page.setContent(pageHtml(variant.locale, variant.shape, fontFaces), {
    waitUntil: "load",
  });
  await page.evaluate(async () => document.fonts.ready);

  const snapshotTimes = [0, 4.5, 15, 25.5, 30];
  const snapshots: Array<{ percent: number; path: string; sha256: string }> =
    [];
  for (const seconds of snapshotTimes) {
    await page.evaluate(
      (milliseconds) => window.renderAt(milliseconds),
      seconds * 1000,
    );
    const buffer = await page.screenshot();
    const percent = Math.round((seconds / durationSeconds) * 100);
    const snapshotPath = resolve(snapshotDirectory, `${id}-${percent}.png`);
    await writeFile(snapshotPath, buffer);
    snapshots.push({ percent, path: snapshotPath, sha256: hash(buffer) });
  }

  await page.evaluate(() => window.renderAt(15_000));
  const deterministicFirst = await page.screenshot();
  await page.evaluate(() => window.renderAt(15_000));
  const deterministicSecond = await page.screenshot();
  if (hash(deterministicFirst) !== hash(deterministicSecond)) {
    throw new Error(`Deterministic screenshot check failed for ${id}`);
  }

  for (let frame = 0; frame < frameCount; frame += 1) {
    await page.evaluate(
      (milliseconds) => window.renderAt(milliseconds),
      (frame * 1000) / fps,
    );
    await page.screenshot({ path: resolve(frameDirectory, frameName(frame)) });
  }
  await context.close();

  await run("ffmpeg", [
    "-y",
    "-framerate",
    String(fps),
    "-i",
    resolve(frameDirectory, "frame-%04d.png"),
    "-frames:v",
    String(frameCount),
    "-an",
    "-c:v",
    "libx264",
    "-preset",
    "medium",
    "-crf",
    "24",
    "-movflags",
    "+faststart",
    "-pix_fmt",
    "yuv420p",
    "-profile:v",
    "high",
    "-level",
    "4.0",
    output,
  ]);
  await run("ffmpeg", [
    "-y",
    "-i",
    resolve(frameDirectory, frameName(Math.floor(frameCount / 2))),
    "-frames:v",
    "1",
    "-q:v",
    "2",
    poster,
  ]);

  const metadata = await inspectVideo(output, variant);
  const file = await readFile(output);
  if (file.byteLength > 6 * 1024 * 1024) {
    throw new Error(`${id} exceeds the 6 MB delivery target`);
  }
  const posterInfo = await stat(poster);

  return {
    id,
    source: `/media/landing-demo-${id}.mp4`,
    poster: `/media/landing-demo-${id}.jpg`,
    deterministicSnapshotHash: hash(deterministicFirst),
    snapshots,
    outputSha256: hash(file),
    posterBytes: posterInfo.size,
    ...metadata,
  };
}

async function main() {
  await mkdir(evidenceRoot, { recursive: true });
  await mkdir(publicMediaRoot, { recursive: true });
  const fontFaces = await bundledFontFaces();
  const browser = await chromium.launch({ headless: true });
  try {
    const rendered = [];
    for (const variant of variants)
      rendered.push(await renderVariant(browser, variant, fontFaces));
    const manifest = {
      version: 1,
      renderer: "Playwright deterministic HTML frames + FFmpeg",
      motionDirection: {
        tone: "editorial_clean",
        motionDensity: "low",
        motifSet: ["file-flow", "column-pairing", "checked-export"],
        transitionFamily: "soft crossfade",
        noGo: ["random motion", "neon glow", "decorative particles"],
      },
      render: {
        fps,
        durationSeconds,
        frameCount,
        audio: "none (muted landing video)",
      },
      variants: rendered,
      visualQa: {
        snapshots: [0, 15, 50, 85, 100],
        deterministicFrameHash: "PASS",
        decodedFrameContinuity: "PASS",
        humanInspection: "pending",
      },
      assumptions: [
        "The landing demo represents append, explicit column matching, review, and export using synthetic rows only.",
        "No browser, server, or AI processing is depicted or required.",
      ],
    };
    await writeFile(
      resolve(evidenceRoot, "manifest.json"),
      `${JSON.stringify(manifest, null, 2)}\n`,
    );
    await writeFile(
      resolve(publicMediaRoot, "landing-demo-manifest.json"),
      `${JSON.stringify(
        {
          version: manifest.version,
          renderer: manifest.renderer,
          render: manifest.render,
          variants: rendered.map(({ snapshots, ...variant }) => ({
            ...variant,
            snapshots: snapshots.map(({ percent, sha256 }) => ({
              percent,
              sha256,
            })),
          })),
          visualQa: manifest.visualQa,
        },
        null,
        2,
      )}\n`,
    );
    await rm(resolve(evidenceRoot, "frames"), { recursive: true, force: true });
    console.log(JSON.stringify(manifest, null, 2));
  } finally {
    await browser.close();
  }
}

void main();

declare global {
  interface Window {
    renderAt: (milliseconds: number) => void;
  }
}
