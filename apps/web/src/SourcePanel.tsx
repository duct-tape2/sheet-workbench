/* Hallmark · component: source dialog · genre: modern-minimal · theme: existing Quiet · pre-emit critique: P4 H4 E4 S5 R5 V4 */
import { useEffect, useRef, useState } from "react";
import { api } from "./api";
import Modal from "./Modal";
import type { Workbench } from "./useWorkbench";
import { releaseText } from "./releaseText";
type Job = {
  operationId: string;
  status: string;
  attempts: number;
  errorMessage?: string;
  canRetry?: boolean;
};
type IdentityPreview = {
  fingerprint: string;
  added: number;
  dataset: {
    mapping: { title: string };
    records: Array<{
      sourceIdentity?: string;
      values: Record<string, string | number | boolean | null>;
    }>;
  };
};
export default function SourcePanel({
  workbench: w,
  onClose,
}: {
  workbench: Workbench;
  onClose: () => void;
}) {
  const t = releaseText[w.locale],
    [jobs, setJobs] = useState<Job[]>([]),
    [consent, setConsent] = useState(false),
    [busy, setBusy] = useState(false),
    [preview, setPreview] = useState<IdentityPreview | null>(null),
    [error, setError] = useState("");
  const op = useRef(crypto.randomUUID());
  const load = async () => {
    try {
      setJobs(await api<Job[]>(`${w.base}/source-jobs`));
    } catch (e) {
      setError((e as Error).message);
    }
  };
  useEffect(() => {
    void load();
    const id = setInterval(() => void load(), 5000);
    return () => clearInterval(id);
  }, [w.base]);
  const reviewIdentity = async () => {
    setBusy(true);
    setError("");
    setConsent(false);
    try {
      setPreview(
        await api<IdentityPreview>(`${w.base}/google/identity-preview`),
      );
    } catch (e) {
      setPreview(null);
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const enable = async () => {
    if (!preview) {
      setError(t.previewRequired);
      return;
    }
    setBusy(true);
    setError("");
    try {
      await api(`${w.base}/google/identity`, {
        operationId: op.current,
        consent: true,
        previewFingerprint: preview.fingerprint,
      });
      await w.refresh();
      setConsent(false);
      setPreview(null);
      op.current = crypto.randomUUID();
    } catch (e) {
      // A failed confirmation may be stale after its second server-side read.
      // Require an explicit fresh preview rather than reusing it.
      setPreview(null);
      setConsent(false);
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const metadataReady =
    w.dataset.source.identityStrategy === "developer-metadata" &&
    w.dataset.records.every((record) => Boolean(record.sourceIdentity));
  const canRepairIdentity =
    w.dataset.source.kind === "google" &&
    !metadataReady &&
    w.workspace?.role !== "viewer";
  const previewTitles = preview
    ? preview.dataset.records
        .filter((record) => !record.sourceIdentity)
        .slice(0, 5)
        .map((record) =>
          String(record.values[preview.dataset.mapping.title] ?? ""),
        )
        .filter(Boolean)
    : [];
  const retryJob = async (job: Job) => {
    setBusy(true);
    setError("");
    try {
      await api(`${w.base}/source-jobs/retry`, {
        operationId: job.operationId,
      });
      await w.refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
      await load();
    }
  };
  const states: Record<string, string> =
    w.locale === "ko"
      ? {
          queued: "대기",
          running: "원본 확인 중",
          succeeded: "저장 확인됨",
          failed: "확인 필요",
          conflicted: "충돌 확인 필요",
        }
      : {
          queued: "Queued",
          running: "Checking source",
          succeeded: "Confirmed",
          failed: "Needs review",
          conflicted: "Conflict",
        };
  return (
    <Modal title={t.identity} onClose={onClose} closeLabel={t.close}>
      <div className="modal-body flow">
        <p>{t.identityHelp}</p>
        {metadataReady && <p role="status">{t.identityReady}</p>}
        {canRepairIdentity && (
          <>
            {!preview ? (
              <button disabled={busy} onClick={() => void reviewIdentity()}>
                {busy ? t.loading : t.reviewIdentity}
              </button>
            ) : (
              <>
                <p role="status">
                  {preview.added > 0
                    ? `${preview.added} ${t.previewRows}`
                    : t.previewEmpty}
                </p>
                {!!previewTitles.length && (
                  <ul>
                    {previewTitles.map((title, index) => (
                      <li key={`${index}-${title}`}>{title}</li>
                    ))}
                  </ul>
                )}
                <label className="checkbox-label">
                  <input
                    type="checkbox"
                    checked={consent}
                    onChange={(e) => setConsent(e.target.checked)}
                  />
                  {t.consent}
                </label>
                <button
                  disabled={busy || !consent}
                  onClick={() => void enable()}
                >
                  {busy ? t.loading : t.enable}
                </button>
              </>
            )}
          </>
        )}
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        <h3>{t.jobs}</h3>
        {!jobs.length && <p>{t.noJobs}</p>}
        {jobs.map((job) => (
          <article className="history-entry" key={job.operationId}>
            <p>
              {states[job.status] || job.status} · {job.attempts}
            </p>
            <small>{job.operationId}</small>
            {job.errorMessage && <p>{job.errorMessage}</p>}
            {job.canRetry && ["failed", "conflicted"].includes(job.status) && (
              <button
                disabled={busy || w.workspace?.role === "viewer"}
                onClick={() => void retryJob(job)}
              >
                {t.retry}
              </button>
            )}
          </article>
        ))}
      </div>
      <footer className="modal-actions">
        <button onClick={() => void load()} disabled={busy}>
          {t.retry}
        </button>
        <button onClick={onClose}>{t.close}</button>
      </footer>
    </Modal>
  );
}
