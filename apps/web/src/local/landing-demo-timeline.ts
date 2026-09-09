export const DEMO_DURATION_MS = 20_000;

export const LANDING_DEMO_STAGES = [
  { id: "incoming", start: 0 },
  { id: "mapping", start: 15 },
  { id: "combined", start: 50 },
  { id: "download", start: 85 },
] as const;

export type LandingDemoStage = (typeof LANDING_DEMO_STAGES)[number];
export type LandingDemoStageId = LandingDemoStage["id"];

export type LandingDemoFrame = {
  elapsedMs: number;
  progress: number;
  stage: LandingDemoStage;
  stageIndex: number;
  stageProgress: number;
  incomingProgress: number;
  mappingProgress: number;
  combinedProgress: number;
  downloadProgress: number;
  isComplete: boolean;
};

const clamp = (value: number, min = 0, max = 1) =>
  Math.min(max, Math.max(min, value));

export const progressForMs = (elapsedMs: number) =>
  clamp(elapsedMs / DEMO_DURATION_MS) * 100;

export const msForProgress = (progress: number) =>
  clamp(progress / 100) * DEMO_DURATION_MS;

export function stageIndexForProgress(progress: number) {
  const normalized = clamp(progress / 100) * 100;
  let index = 0;
  for (
    let candidate = 1;
    candidate < LANDING_DEMO_STAGES.length;
    candidate += 1
  ) {
    if (normalized >= LANDING_DEMO_STAGES[candidate].start) index = candidate;
  }
  return index;
}

const segmentProgress = (progress: number, start: number, end: number) =>
  clamp((progress - start) / (end - start));

export function frameForProgress(progress: number): LandingDemoFrame {
  const normalized = clamp(progress / 100) * 100;
  const stageIndex = stageIndexForProgress(normalized);
  const stage = LANDING_DEMO_STAGES[stageIndex];
  const nextStart = LANDING_DEMO_STAGES[stageIndex + 1]?.start ?? 100;

  return {
    elapsedMs: msForProgress(normalized),
    progress: normalized,
    stage,
    stageIndex,
    stageProgress: segmentProgress(normalized, stage.start, nextStart),
    incomingProgress: segmentProgress(normalized, 0, 15),
    mappingProgress: segmentProgress(normalized, 15, 50),
    combinedProgress: segmentProgress(normalized, 50, 85),
    downloadProgress: segmentProgress(normalized, 85, 100),
    isComplete: normalized >= 100,
  };
}

export const frameAtMs = (elapsedMs: number) =>
  frameForProgress(progressForMs(elapsedMs));

export const stepProgress = (stageIndex: number, direction: -1 | 1) => {
  const nextIndex = Math.min(
    LANDING_DEMO_STAGES.length - 1,
    Math.max(0, stageIndex + direction),
  );
  return LANDING_DEMO_STAGES[nextIndex].start;
};
