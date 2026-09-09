import { describe, expect, it } from "vitest";
import {
  DEMO_DURATION_MS,
  LANDING_DEMO_STAGES,
  frameAtMs,
  frameForProgress,
  msForProgress,
  stepProgress,
} from "../apps/web/src/local/landing-demo-timeline";

describe("landing demo timeline", () => {
  it("has four explicit stages across the 20 second illustration", () => {
    expect(DEMO_DURATION_MS).toBe(20_000);
    expect(LANDING_DEMO_STAGES.map((stage) => [stage.id, stage.start])).toEqual(
      [
        ["incoming", 0],
        ["mapping", 15],
        ["combined", 50],
        ["download", 85],
      ],
    );
  });

  it("selects deterministic stage snapshots at the required seek positions", () => {
    const snapshots = [0, 15, 50, 85, 100].map((progress) => {
      const frame = frameForProgress(progress);
      return [progress, frame.stage.id, frame.stageIndex, frame.isComplete];
    });

    expect(snapshots).toEqual([
      [0, "incoming", 0, false],
      [15, "mapping", 1, false],
      [50, "combined", 2, false],
      [85, "download", 3, false],
      [100, "download", 3, true],
    ]);
  });

  it("clamps timeline input and keeps the progress math reversible", () => {
    expect(frameAtMs(-1).progress).toBe(0);
    expect(frameAtMs(DEMO_DURATION_MS + 1).progress).toBe(100);
    expect(msForProgress(15)).toBe(3_000);
    expect(frameAtMs(msForProgress(85)).stage.id).toBe("download");
  });

  it("steps only between the explicit stage starts", () => {
    expect(stepProgress(0, -1)).toBe(0);
    expect(stepProgress(0, 1)).toBe(15);
    expect(stepProgress(2, 1)).toBe(85);
    expect(stepProgress(3, 1)).toBe(85);
  });
});
