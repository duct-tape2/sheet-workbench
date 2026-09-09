/* Hallmark · component: versions dialog · genre: modern-minimal · theme: existing Quiet · pre-emit critique: P4 H4 E4 S5 R5 V4 */
import { useEffect, useState } from "react";
import { api, download, downloadFromApi } from "./api";
import Modal from "./Modal";
import type { Workbench } from "./useWorkbench";
import { releaseText } from "./releaseText";
type Version = {
  revision: number;
  createdAt: string;
  recordCount: number;
  canExportXlsx: boolean;
};
type DownloadState =
  | { phase: "idle" }
  | { phase: "pending"; message: string }
  | { phase: "success"; message: string }
  | { phase: "error"; message: string };
export default function VersionsPanel({
  workbench: w,
  onClose,
}: {
  workbench: Workbench;
  onClose: () => void;
}) {
  const t = releaseText[w.locale],
    [versions, setVersions] = useState<Version[]>([]),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [downloadState, setDownloadState] = useState<DownloadState>({
      phase: "idle",
    });
  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError("");
    try {
      await fn();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const load = () =>
    run(async () => {
      setVersions(await api<Version[]>(`${w.base}/versions`));
    });
  useEffect(() => {
    void load();
  }, [w.base]);
  const startDownload = async (action: () => Promise<void>) => {
    setDownloadState({ phase: "pending", message: t.preparingDownload });
    setError("");
    setBusy(true);
    try {
      await action();
      setDownloadState({ phase: "success", message: t.downloadStarted });
    } catch (e) {
      const detail = e instanceof Error && e.message ? e.message : "";
      setDownloadState({
        phase: "error",
        message: detail ? `${t.downloadFailed} ${detail}` : t.downloadFailed,
      });
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal title={t.versions} onClose={onClose} closeLabel={t.close}>
      <div className="modal-body flow">
        <p>{t.versionsHelp}</p>
        {busy && <p role="status">{t.loading}</p>}
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        {downloadState.phase !== "idle" && (
          <p
            className={downloadState.phase === "error" ? "error" : "notice"}
            role={downloadState.phase === "error" ? "alert" : "status"}
            aria-live="polite"
          >
            {downloadState.message}
          </p>
        )}
        {!busy && !error && !versions.length && <p>{t.empty}</p>}
        {versions.map((v) => (
          <article className="history-entry" key={v.revision}>
            <h3>
              r{v.revision} · {v.recordCount} {t.rows}
            </h3>
            <time dateTime={v.createdAt}>
              {new Date(v.createdAt).toLocaleString(w.locale, {
                timeZone: w.dataset.timeZone,
              })}
            </time>
            <div className="account-row">
              <button
                disabled={busy}
                onClick={() =>
                  void startDownload(async () => {
                    const snapshot = await api(
                      `${w.base}/versions/${v.revision}`,
                    );
                    download(
                      JSON.stringify(snapshot, null, 2),
                      `revision-${v.revision}.json`,
                      "application/json",
                    );
                  })
                }
              >
                {t.snapshot}
              </button>
              {v.canExportXlsx && (
                <button
                  disabled={busy}
                  onClick={() =>
                    void startDownload(() =>
                      downloadFromApi(
                        `${w.base}/versions/${v.revision}?format=xlsx`,
                        `workbook-revision-${v.revision}.xlsx`,
                        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
                      ),
                    )
                  }
                >
                  {t.workbook}
                </button>
              )}
            </div>
          </article>
        ))}
      </div>
      <footer className="modal-actions">
        <button disabled={busy} onClick={() => void load()}>
          {t.retry}
        </button>
        <button onClick={onClose}>{t.close}</button>
      </footer>
    </Modal>
  );
}
