import { useEffect, useMemo, useRef, useState } from "react";
import "./landing-demo.css";

type Locale = "en" | "ko";

type Copy = {
  eyebrow: string;
  heading: string;
  explanation: string;
  notice: string;
  play: string;
  pause: string;
  fallback: string;
  duration: string;
};

const copy: Record<Locale, Copy> = {
  en: {
    eyebrow: "Continuous workflow demo",
    heading: "From two files to one checked result.",
    explanation:
      "A 30-second loop shows append, column matching, review, and export with synthetic rows.",
    notice:
      "Illustration only. It does not access or process files in the background.",
    play: "Play demo",
    pause: "Pause demo",
    fallback: "Play the 30-second workflow demo",
    duration: "30 second loop",
  },
  ko: {
    eyebrow: "연속 작업 흐름 예시",
    heading: "두 파일부터 확인한 결과까지.",
    explanation:
      "가상 행으로 이어붙이기, 열 연결, 결과 확인, 내보내기를 30초 영상으로 보여줍니다.",
    notice: "가상 자료로 만든 기능 소개입니다. 실제 파일은 처리하지 않습니다.",
    play: "시연 재생",
    pause: "시연 일시 정지",
    fallback: "30초 작업 흐름 영상 재생",
    duration: "30초 반복 영상",
  },
};

const isCompactViewport = () =>
  typeof window !== "undefined" &&
  window.matchMedia("(max-width: 640px)").matches;

const prefersReducedMotion = () =>
  typeof window !== "undefined" &&
  window.matchMedia("(prefers-reduced-motion: reduce)").matches;

const hasSaveDataPreference = () => {
  if (typeof navigator === "undefined") return false;
  return Boolean(
    (navigator as Navigator & { connection?: { saveData?: boolean } })
      .connection?.saveData,
  );
};

export default function LandingDemo({ locale }: { locale: Locale }) {
  const text = copy[locale];
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const pausedForViewport = useRef(false);
  const pausedByUser = useRef(false);
  const isVisible = useRef(false);
  const [compact, setCompact] = useState(isCompactViewport);
  const [reducedMotion, setReducedMotion] = useState(prefersReducedMotion);
  const [saveData, setSaveData] = useState(hasSaveDataPreference);
  const [autoplayBlocked, setAutoplayBlocked] = useState(false);
  const [hasUserStarted, setHasUserStarted] = useState(false);
  const [isPlaying, setIsPlaying] = useState(false);

  const assetId = `${locale}-${compact ? "mobile" : "desktop"}`;
  const mediaPath = `${import.meta.env.BASE_URL}media/landing-demo-${assetId}`;
  const userGestureRequired = reducedMotion || saveData || autoplayBlocked;
  const showPoster = userGestureRequired && !hasUserStarted;

  const startPlayback = async (userInitiated = false) => {
    const video = videoRef.current;
    if (!video) return;
    if (!userInitiated && (reducedMotion || saveData || pausedByUser.current))
      return;
    if (userInitiated) pausedByUser.current = false;

    try {
      await video.play();
      setIsPlaying(true);
      if (userInitiated) {
        setHasUserStarted(true);
        setAutoplayBlocked(false);
      }
    } catch {
      if (!userInitiated) setAutoplayBlocked(true);
    }
  };

  useEffect(() => {
    const compactMedia = window.matchMedia("(max-width: 640px)");
    const reducedMedia = window.matchMedia("(prefers-reduced-motion: reduce)");
    const update = () => {
      setCompact(compactMedia.matches);
      setReducedMotion(reducedMedia.matches);
      setSaveData(hasSaveDataPreference());
    };
    update();
    compactMedia.addEventListener("change", update);
    reducedMedia.addEventListener("change", update);
    return () => {
      compactMedia.removeEventListener("change", update);
      reducedMedia.removeEventListener("change", update);
    };
  }, []);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    const observer = new IntersectionObserver(
      ([entry]) => {
        if (!entry) return;
        if (entry.intersectionRatio < 0.2) {
          isVisible.current = false;
          if (!video.paused) {
            pausedForViewport.current = true;
            video.pause();
          }
          return;
        }

        isVisible.current = true;
        if (
          (pausedForViewport.current || video.paused) &&
          !userGestureRequired
        ) {
          pausedForViewport.current = false;
          void startPlayback();
        }
      },
      { threshold: [0, 0.2] },
    );
    observer.observe(video);
    return () => observer.disconnect();
  }, [assetId, userGestureRequired]);

  useEffect(() => {
    if (userGestureRequired) {
      videoRef.current?.pause();
      setIsPlaying(false);
    }
  }, [userGestureRequired]);

  useEffect(() => {
    const pauseWhenHidden = () => {
      if (document.hidden) videoRef.current?.pause();
    };
    document.addEventListener("visibilitychange", pauseWhenHidden);
    return () =>
      document.removeEventListener("visibilitychange", pauseWhenHidden);
  }, []);

  const accessibleDescription = useMemo(
    () => `${text.explanation} ${text.notice}`,
    [text.explanation, text.notice],
  );

  return (
    <section
      className={`sw-demo${showPoster ? " sw-demo--poster" : ""}`}
      data-source={assetId}
      data-autoplay={showPoster ? "blocked" : "ready"}
      aria-labelledby="sw-demo-heading"
      aria-describedby="sw-demo-note"
    >
      <div className="sw-demo__intro">
        <p className="sw-demo__eyebrow">{text.eyebrow}</p>
        <h2 id="sw-demo-heading">{text.heading}</h2>
        <p>{text.explanation}</p>
      </div>

      <div className="sw-demo__media-frame">
        <video
          key={assetId}
          ref={videoRef}
          className="sw-demo__video"
          src={`${mediaPath}.mp4`}
          poster={`${mediaPath}.jpg`}
          muted
          loop
          playsInline
          autoPlay={!userGestureRequired && !pausedByUser.current}
          preload="metadata"
          tabIndex={-1}
          aria-hidden="true"
          onCanPlay={() => {
            if (!userGestureRequired && isVisible.current) void startPlayback();
          }}
          onPlay={() => setIsPlaying(true)}
          onPause={() => setIsPlaying(false)}
        />
        {showPoster && (
          <button
            type="button"
            className="sw-demo__poster-play"
            onClick={() => void startPlayback(true)}
            aria-label={text.fallback}
          >
            <span aria-hidden="true">▶</span>
            {text.play}
          </button>
        )}
        <p className="sw-demo__video-description">{accessibleDescription}</p>
      </div>

      <div className="sw-demo__meta">
        <span className="sw-demo__duration">{text.duration}</span>
        <button
          type="button"
          className="sw-demo__control"
          onClick={() => {
            if (isPlaying) {
              pausedByUser.current = true;
              videoRef.current?.pause();
              return;
            }
            void startPlayback(true);
          }}
        >
          <span aria-hidden="true">{isPlaying ? "Ⅱ" : "▶"}</span>
          {isPlaying ? text.pause : text.play}
        </button>
      </div>

      <p className="sw-demo__note" id="sw-demo-note">
        {text.notice}
      </p>
    </section>
  );
}
