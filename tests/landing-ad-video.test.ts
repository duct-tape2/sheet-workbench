import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(process.cwd());
const mediaRoot = resolve(root, "apps", "web", "public", "media");
const ids = ["en-desktop", "ko-desktop", "en-mobile", "ko-mobile"];

describe("landing ad video deliverables", () => {
  it("ships four local MP4s with matching posters and a verified render manifest", async () => {
    const manifest = JSON.parse(
      await readFile(resolve(mediaRoot, "landing-demo-manifest.json"), "utf8"),
    ) as {
      render: {
        fps: number;
        durationSeconds: number;
        frameCount: number;
        audio: string;
      };
      variants: Array<{
        id: string;
        codec: string;
        duration: number;
        decodedFrames: number;
        width: number;
        height: number;
        sizeBytes: number;
        outputSha256: string;
      }>;
      visualQa: {
        deterministicFrameHash: string;
        decodedFrameContinuity: string;
      };
    };

    expect(manifest.render).toEqual({
      fps: 30,
      durationSeconds: 30,
      frameCount: 900,
      audio: "none (muted landing video)",
    });
    expect(manifest.visualQa.deterministicFrameHash).toBe("PASS");
    expect(manifest.visualQa.decodedFrameContinuity).toBe("PASS");

    for (const id of ids) {
      const videoPath = resolve(mediaRoot, `landing-demo-${id}.mp4`);
      const posterPath = resolve(mediaRoot, `landing-demo-${id}.jpg`);
      const [video, poster, bytes] = await Promise.all([
        stat(videoPath),
        stat(posterPath),
        readFile(videoPath),
      ]);
      const variant = manifest.variants.find(
        (candidate) => candidate.id === id,
      );
      expect(video.size).toBeGreaterThan(20_000);
      expect(video.size).toBeLessThanOrEqual(6 * 1024 * 1024);
      expect(poster.size).toBeGreaterThan(5_000);
      expect(bytes.subarray(4, 8).toString("ascii")).toBe("ftyp");
      expect(variant).toMatchObject({
        codec: "h264",
        duration: 30,
        decodedFrames: 900,
      });
      expect(variant!.width / variant!.height).toBe(
        id.endsWith("desktop") ? 1280 / 720 : 4 / 5,
      );
      expect(createHash("sha256").update(bytes).digest("hex")).toBe(
        variant!.outputSha256,
      );
    }
  });
});
