import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import {
  DEMO_DURATION_MS,
  LANDING_DEMO_STAGES,
  frameAtMs,
  msForProgress,
  stepProgress,
} from "./landing-demo-timeline";
import "./landing-demo.css";

type Locale = "en" | "ko";

type Copy = {
  eyebrow: string;
  heading: string;
  explanation: string;
  notProcessing: string;
  timeline: string;
  play: string;
  pause: string;
  replay: string;
  previous: string;
  next: string;
  stage: string;
  stages: Record<
    "incoming" | "mapping" | "combined" | "download",
    {
      shortLabel: string;
      title: string;
      detail: string;
      table: string[][];
      columns: string[];
    }
  >;
  sourceOne: string;
  sourceTwo: string;
  matched: string;
  confirmed: string;
  result: string;
  csv: string;
};

const copy: Record<Locale, Copy> = {
  en: {
    eyebrow: "Synthetic workflow illustration",
    heading: "A 20-second tour of file combining",
    explanation:
      "A sample path from a current file and an added file to one checked result.",
    notProcessing:
      "Illustration only. It does not access or process files in the background.",
    timeline: "Workflow timeline",
    play: "Play example",
    pause: "Pause example",
    replay: "Replay",
    previous: "Previous step",
    next: "Next step",
    stage: "Stage",
    stages: {
      incoming: {
        shortLabel: "1 File",
        title: "Incoming files",
        detail:
          "The current and added files each keep their Name and City columns.",
        columns: ["Name", "City", "File"],
        table: [
          ["Mina", "Seoul", "Current"],
          ["Jae", "Busan", "Added"],
        ],
      },
      mapping: {
        shortLabel: "2 Map",
        title: "Map columns",
        detail: "Name and City are paired before the rows are combined.",
        columns: ["Name", "City", "File"],
        table: [
          ["Mina", "Seoul", "Current"],
          ["Jae", "Busan", "Added"],
        ],
      },
      combined: {
        shortLabel: "3 Check",
        title: "Check result",
        detail: "The same two rows appear together for review.",
        columns: ["Name", "City"],
        table: [
          ["Mina", "Seoul"],
          ["Jae", "Busan"],
        ],
      },
      download: {
        shortLabel: "4 Save",
        title: "Save result",
        detail:
          "The unchanged checked rows appear in a downloadable-file example.",
        columns: ["Name", "City"],
        table: [
          ["Mina", "Seoul"],
          ["Jae", "Busan"],
        ],
      },
    },
    sourceOne: "Current file",
    sourceTwo: "Added file",
    matched: "Name ↔ Name · City ↔ City",
    confirmed: "Same two rows checked",
    result: "Download example",
    csv: "combined-rows.csv",
  },
  ko: {
    eyebrow: "가상 자료 예시",
    heading: "20초로 보는 파일 취합",
    explanation:
      "현재 파일과 추가 파일의 Name, City 열을 연결하고 결과를 확인해 저장합니다.",
    notProcessing:
      "가상 자료로 만든 기능 소개입니다. 실제 파일은 처리하지 않습니다.",
    timeline: "시연 진행 위치",
    play: "예시 재생",
    pause: "예시 일시 정지",
    replay: "다시 보기",
    previous: "이전 단계",
    next: "다음 단계",
    stage: "단계",
    stages: {
      incoming: {
        shortLabel: "1파일",
        title: "들어오는 파일",
        detail: "현재 파일과 추가 파일에 Name, City 열이 있습니다.",
        columns: ["Name", "City", "파일"],
        table: [
          ["Mina", "Seoul", "현재"],
          ["Jae", "Busan", "추가"],
        ],
      },
      mapping: {
        shortLabel: "2열연결",
        title: "열 연결",
        detail: "행을 합치기 전에 Name과 City 열을 같은 이름끼리 연결합니다.",
        columns: ["Name", "City", "파일"],
        table: [
          ["Mina", "Seoul", "현재"],
          ["Jae", "Busan", "추가"],
        ],
      },
      combined: {
        shortLabel: "3결과확인",
        title: "결과 확인",
        detail: "Mina, Seoul과 Jae, Busan이 바뀌지 않은 채 한 표에 보입니다.",
        columns: ["Name", "City"],
        table: [
          ["Mina", "Seoul"],
          ["Jae", "Busan"],
        ],
      },
      download: {
        shortLabel: "4저장",
        title: "저장할 결과",
        detail:
          "확인한 두 행을 새 파일로 저장합니다. 원본 파일은 그대로입니다.",
        columns: ["Name", "City"],
        table: [
          ["Mina", "Seoul"],
          ["Jae", "Busan"],
        ],
      },
    },
    sourceOne: "현재 파일",
    sourceTwo: "추가 파일",
    matched: "Name ↔ Name · City ↔ City",
    confirmed: "같은 두 행을 확인",
    result: "저장 파일 예시",
    csv: "combined-rows.csv",
  },
};

const formatClock = (elapsedMs: number) => {
  const seconds = Math.floor(elapsedMs / 1000);
  return `00:${String(seconds).padStart(2, "0")}`;
};

export default function LandingDemo({ locale }: { locale: Locale }) {
  const text = copy[locale];
  const [elapsedMs, setElapsedMs] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [reducedMotion, setReducedMotion] = useState(false);
  const [playCycle, setPlayCycle] = useState(0);
  const animationFrame = useRef<number | null>(null);

  const frame = useMemo(() => frameAtMs(elapsedMs), [elapsedMs]);
  const current = text.stages[frame.stage.id];

  const seekTo = useCallback((progress: number) => {
    setPlaying(false);
    setElapsedMs(msForProgress(progress));
  }, []);

  useEffect(() => {
    const media = window.matchMedia("(prefers-reduced-motion: reduce)");
    const updatePreference = () => {
      setReducedMotion(media.matches);
      if (media.matches) setPlaying(false);
    };
    updatePreference();
    media.addEventListener("change", updatePreference);
    return () => media.removeEventListener("change", updatePreference);
  }, []);

  useEffect(() => {
    const pauseWhenHidden = () => {
      if (document.hidden) setPlaying(false);
    };
    document.addEventListener("visibilitychange", pauseWhenHidden);
    return () =>
      document.removeEventListener("visibilitychange", pauseWhenHidden);
  }, []);

  useEffect(() => {
    if (!playing) return;

    const initialElapsed = elapsedMs;
    let startedAt: number | null = null;
    const tick = (now: number) => {
      if (startedAt === null) startedAt = now;
      const nextElapsed = Math.min(
        DEMO_DURATION_MS,
        initialElapsed + now - startedAt,
      );
      setElapsedMs(nextElapsed);
      if (nextElapsed < DEMO_DURATION_MS) {
        animationFrame.current = window.requestAnimationFrame(tick);
      } else {
        setPlaying(false);
      }
    };

    animationFrame.current = window.requestAnimationFrame(tick);
    return () => {
      if (animationFrame.current !== null) {
        window.cancelAnimationFrame(animationFrame.current);
        animationFrame.current = null;
      }
    };
  }, [playing, playCycle]);

  const play = () => {
    if (frame.isComplete) setElapsedMs(0);
    setPlaying(true);
  };

  const replay = () => {
    setElapsedMs(0);
    setPlaying(true);
    setPlayCycle((cycle) => cycle + 1);
  };

  const visualStyle = {
    "--sw-demo-incoming-shift": `${Math.round((1 - frame.incomingProgress) * 24)}px`,
    "--sw-demo-incoming-opacity": String(0.48 + frame.incomingProgress * 0.52),
    "--sw-demo-mapping-opacity": String(0.3 + frame.mappingProgress * 0.7),
    "--sw-demo-combined-opacity": String(0.3 + frame.combinedProgress * 0.7),
    "--sw-demo-download-opacity": String(0.3 + frame.downloadProgress * 0.7),
  } as CSSProperties;

  return (
    <section
      className={`sw-demo${reducedMotion ? " sw-demo--reduced" : ""}`}
      data-stage={frame.stage.id}
      aria-labelledby="sw-demo-heading"
      aria-describedby="sw-demo-note"
    >
      <div className="sw-demo__intro">
        <p className="sw-demo__eyebrow">{text.eyebrow}</p>
        <h2 id="sw-demo-heading">{text.heading}</h2>
        <p>{text.explanation}</p>
      </div>

      <div
        className="sw-demo__visual-wrap"
        style={visualStyle}
        aria-hidden="true"
      >
        <div className="sw-demo__visual">
          <div className="sw-demo__source-stack">
            <article className="sw-demo__source-card sw-demo__source-card--back">
              <span>{text.sourceOne}</span>
              <i />
              <i />
              <i />
            </article>
            <article className="sw-demo__source-card sw-demo__source-card--front">
              <span>{text.sourceTwo}</span>
              <i />
              <i />
              <i />
            </article>
          </div>

          <article className="sw-demo__sheet">
            <header className="sw-demo__sheet-heading">
              <span>
                {text.stage} {frame.stageIndex + 1} /{" "}
                {LANDING_DEMO_STAGES.length}
              </span>
              <strong>{current.title}</strong>
              <small>{current.detail}</small>
            </header>
            <div className="sw-demo__table" role="table">
              <div
                className={`sw-demo__tr sw-demo__tr--${current.columns.length} sw-demo__tr--header`}
                role="row"
              >
                {current.columns.map((column) => (
                  <span role="columnheader" key={column}>
                    {column}
                  </span>
                ))}
              </div>
              {current.table.map((row) => (
                <div
                  className={`sw-demo__tr sw-demo__tr--${current.columns.length}`}
                  role="row"
                  key={row.join("-")}
                >
                  {row.map((cell) => (
                    <span role="cell" key={cell}>
                      {cell}
                    </span>
                  ))}
                </div>
              ))}
            </div>
            <footer className="sw-demo__sheet-footer">
              {frame.stage.id === "incoming" && (
                <span>
                  {text.sourceOne} + {text.sourceTwo}
                </span>
              )}
              {frame.stage.id === "mapping" && (
                <span className="sw-demo__mapping">{text.matched}</span>
              )}
              {frame.stage.id === "combined" && (
                <span className="sw-demo__confirmed">{text.confirmed}</span>
              )}
              {frame.stage.id === "download" && (
                <span className="sw-demo__result">
                  <b>{text.result}</b>
                  <em>{text.csv}</em>
                </span>
              )}
            </footer>
          </article>
        </div>
      </div>

      <div className="sw-demo__controls" aria-label={text.timeline}>
        <div className="sw-demo__control-row">
          <button
            type="button"
            className="sw-demo__button sw-demo__button--play"
            data-testid="sw-demo-play"
            onClick={() => (playing ? setPlaying(false) : play())}
            aria-label={playing ? text.pause : text.play}
          >
            <span aria-hidden="true">{playing ? "Ⅱ" : "▶"}</span>
            {playing ? text.pause : text.play}
          </button>
          <button
            type="button"
            className="sw-demo__button"
            data-testid="sw-demo-replay"
            onClick={replay}
            aria-label={text.replay}
          >
            <span aria-hidden="true">↺</span>
            {text.replay}
          </button>
          <output
            className="sw-demo__clock"
            aria-label={`${formatClock(elapsedMs)} of 00:20`}
          >
            {formatClock(elapsedMs)} / 00:20
          </output>
        </div>

        <label className="sw-demo__seek-label" htmlFor="sw-demo-seek">
          <span>{text.timeline}</span>
          <input
            id="sw-demo-seek"
            data-testid="sw-demo-seek"
            type="range"
            min="0"
            max="100"
            step="1"
            value={Math.round(frame.progress)}
            onChange={(event) => seekTo(Number(event.currentTarget.value))}
            aria-valuetext={`${Math.round(frame.progress)}% — ${current.title}`}
          />
        </label>

        <div className="sw-demo__step-row">
          <button
            type="button"
            className="sw-demo__step-control"
            data-testid="sw-demo-previous"
            onClick={() => seekTo(stepProgress(frame.stageIndex, -1))}
            disabled={frame.stageIndex === 0}
          >
            <span aria-hidden="true">←</span>
            {text.previous}
          </button>
          <ol className="sw-demo__stages">
            {LANDING_DEMO_STAGES.map((stage, index) => (
              <li key={stage.id}>
                <button
                  type="button"
                  data-testid={`sw-demo-stage-${stage.id}`}
                  className={index === frame.stageIndex ? "is-current" : ""}
                  onClick={() => seekTo(stage.start)}
                  aria-current={index === frame.stageIndex ? "step" : undefined}
                  aria-label={`${text.stage} ${index + 1}: ${text.stages[stage.id].title}`}
                  title={text.stages[stage.id].title}
                >
                  {text.stages[stage.id].shortLabel}
                </button>
              </li>
            ))}
          </ol>
          <button
            type="button"
            className="sw-demo__step-control"
            data-testid="sw-demo-next"
            onClick={() => seekTo(stepProgress(frame.stageIndex, 1))}
            disabled={frame.stageIndex === LANDING_DEMO_STAGES.length - 1}
          >
            {text.next}
            <span aria-hidden="true">→</span>
          </button>
        </div>
      </div>

      <p className="sw-demo__note" id="sw-demo-note">
        {text.notProcessing}
      </p>
      <p className="sw-demo__announcer" aria-live="polite">
        {text.stage} {frame.stageIndex + 1}: {current.title}. {current.detail}
      </p>
    </section>
  );
}
