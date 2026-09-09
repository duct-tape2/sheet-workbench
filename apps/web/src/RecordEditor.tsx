import { useEffect, useState, useRef } from "react";
import { ExternalLink, LockKeyhole } from "lucide-react";
import {
  safeUrl,
  type CellValue,
  type WorkRecord,
} from "../../../packages/core/src/index";
import type { Workbench } from "./useWorkbench";
import Modal from "./Modal";
import { en, ko } from "./i18n";
import { api, ApiError } from "./api";
import { releaseText } from "./releaseText";
export default function RecordEditor({
  workbench: w,
  record,
  onClose,
  initialDate,
}: {
  workbench: Workbench;
  record: WorkRecord | null;
  onClose: () => void;
  initialDate?: string;
}) {
  const t = w.locale === "ko" ? ko : en,
    d = w.dataset;
  const draftKey = `sw.draft.${w.session?.user.id ?? "demo"}.${w.workspace?.id ?? "demo"}.${d.id}.${record?.id ?? "new"}`;
  const [values, setValues] = useState<Record<string, CellValue>>(() => {
    try {
      const raw = sessionStorage.getItem(draftKey);
      if (raw) return JSON.parse(raw);
    } catch {}
    return {
      ...(record?.values ??
        Object.fromEntries(d.fields.map((f) => [f.key, null]))),
      ...(initialDate && d.mapping.date
        ? { [d.mapping.date]: initialDate }
        : {}),
    };
  });
  const [error, setError] = useState(""),
    [conflict, setConflict] = useState(false);
  type DraftOperation = {
    id: string;
    signature: string;
    pending?: boolean;
    changes?: Record<string, CellValue>;
    baseRevision?: number;
  };
  const operationKey = `${draftKey}.operation`;
  const operation = useRef<DraftOperation>(
    (() => {
      try {
        const saved = sessionStorage.getItem(operationKey);
        if (saved) return JSON.parse(saved);
      } catch {}
      return { id: crypto.randomUUID(), signature: "" };
    })(),
  );
  const [pending, setPending] = useState(!!operation.current.pending);
  const [appendConsent, setAppendConsent] = useState(
    !!operation.current.pending,
  );
  const rt = releaseText[w.locale];
  const rememberOperation = () => {
    try {
      sessionStorage.setItem(operationKey, JSON.stringify(operation.current));
    } catch {}
  };
  const clearDraft = () => {
    try {
      sessionStorage.removeItem(draftKey);
      sessionStorage.removeItem(operationKey);
    } catch {}
  };
  const latest = record
    ? w.dataset.records.find((r) => r.id === record.id)
    : undefined;
  const [revision, setRevision] = useState(record?.revision ?? 0);
  const [baseValues, setBaseValues] = useState(record?.values ?? {});
  useEffect(() => {
    try {
      sessionStorage.setItem(draftKey, JSON.stringify(values));
    } catch {}
  }, [values, draftKey]);
  useEffect(() => {
    if (!pending || d.source.kind !== "google") return;
    let live = true;
    const check = async () => {
      try {
        const jobs = await api<
          Array<{ operationId: string; status: string; errorMessage?: string }>
        >(`${w.base}/source-jobs`);
        if (!live) return;
        const job = jobs.find((j) => j.operationId === operation.current.id);
        // Absence from a read is not proof that a delayed request was never
        // accepted. The only allowed resend uses this exact operation ID.
        if (!job) return;
        if (job.status === "succeeded") {
          clearDraft();
          await w.refresh();
          if (live) onClose();
        } else if (job.status === "failed" || job.status === "conflicted") {
          operation.current.pending = false;
          rememberOperation();
          setPending(false);
          setConflict(true);
          setError(job.errorMessage || rt.queuedFailed);
          await w.refresh();
        }
      } catch {
        /* A read failure is not proof that the original write failed. */
      }
    };
    void check();
    const timer = setInterval(() => void check(), 3000);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [pending, w.base]);
  const save = async (e?: React.FormEvent, retryOriginal = false) => {
    e?.preventDefault();
    if (pending && !retryOriginal) return;
    if (!record && d.source.kind === "google" && !appendConsent) return;
    setError("");
    try {
      const changes = Object.fromEntries(
        Object.entries(values).filter(
          ([k, v]) => !record || v !== baseValues[k],
        ),
      );
      const signature = JSON.stringify(changes);
      if (signature !== operation.current.signature)
        operation.current = {
          id: crypto.randomUUID(),
          signature,
          changes,
          baseRevision: revision,
        };
      rememberOperation();
      if (record && Object.keys(changes).length)
        await w.patch({
          operationId: operation.current.id,
          recordId: record.id,
          baseRevision: operation.current.baseRevision ?? revision,
          changes: operation.current.changes ?? changes,
        });
      else if (!record) await w.add(values, operation.current.id);
      clearDraft();
      onClose();
    } catch (e) {
      const message = (e as Error).message;
      setError(message);
      const code =
        e instanceof ApiError
          ? (e.payload as { code?: string; error?: { code?: string } })?.code ||
            (e.payload as { error?: { code?: string } })?.error?.code
          : undefined;
      if (
        d.source.kind === "google" &&
        (code === "SOURCE_RETRY_SCHEDULED" || e instanceof TypeError)
      ) {
        operation.current.pending = true;
        rememberOperation();
        setPending(true);
        setError(rt.uncertain);
      }
      if (/changed|conflict/i.test(message)) {
        setConflict(true);
        await w.refresh();
      }
    }
  };
  const url = d.mapping.url
    ? safeUrl(String(values[d.mapping.url] ?? ""))
    : null;
  return (
    <Modal
      title={record ? t.title : t.newRecord}
      onClose={onClose}
      closeLabel={t.close}
    >
      <form onSubmit={save} className="modal-form">
        <div className="modal-body">
          {!record && d.source.kind === "google" && (
            <p className="notice">{rt.append}</p>
          )}
          {!record && d.source.kind === "google" && (
            <label className="checkbox-label">
              <input
                type="checkbox"
                checked={appendConsent}
                disabled={pending}
                onChange={(e) => setAppendConsent(e.target.checked)}
              />
              {rt.appendConsent}
            </label>
          )}
          {pending && (
            <p role="status" className="notice">
              {rt.pending}
            </p>
          )}
          {initialDate && <p className="notice">{t.confirmMove}</p>}
          <div className="form-grid">
            {d.fields.map((f) => {
              const locked =
                record?.lockedFields?.includes(f.key) ||
                (!!record && f.key === d.mapping.identity) ||
                !w.canEdit;
              return (
                <label
                  key={f.key}
                  className={
                    f.key === d.mapping.title || f.key === "notes"
                      ? "span-all"
                      : ""
                  }
                >
                  <span>
                    {f.label}
                    {f.required ? " *" : ""}
                    {locked && <LockKeyhole size={13} />}
                  </span>
                  {f.type === "select" && f.options?.length ? (
                    <select
                      value={String(values[f.key] ?? "")}
                      disabled={locked || pending}
                      required={f.required}
                      onChange={(e) =>
                        setValues((v) => ({
                          ...v,
                          [f.key]: e.target.value || null,
                        }))
                      }
                    >
                      <option value="">—</option>
                      {f.options.map((o) => (
                        <option key={o}>{o}</option>
                      ))}
                    </select>
                  ) : f.key === "notes" ? (
                    <textarea
                      value={String(values[f.key] ?? "")}
                      disabled={locked || pending}
                      onChange={(e) =>
                        setValues((v) => ({ ...v, [f.key]: e.target.value }))
                      }
                    />
                  ) : (
                    <input
                      autoFocus={f.key === d.mapping.title}
                      type={
                        f.type === "date"
                          ? "date"
                          : f.type === "number"
                            ? "number"
                            : f.type === "url"
                              ? "url"
                              : "text"
                      }
                      step={f.type === "number" ? "any" : undefined}
                      value={String(values[f.key] ?? "")}
                      disabled={locked || pending}
                      required={f.required}
                      maxLength={10000}
                      onChange={(e) =>
                        setValues((v) => ({
                          ...v,
                          [f.key]:
                            e.target.value === ""
                              ? null
                              : f.type === "number"
                                ? Number(e.target.value)
                                : e.target.value,
                        }))
                      }
                    />
                  )}{" "}
                  {locked && <small>{t.formula}</small>}
                </label>
              );
            })}
          </div>
          {url && (
            <a
              className="text-link"
              href={url}
              target="_blank"
              rel="noreferrer noopener"
            >
              {t.openSource}
              <ExternalLink size={15} />
            </a>
          )}
          <small>{t.localDraft}</small>
          {conflict && latest && (
            <section className="conflict">
              <h3>{t.latest}</h3>
              <dl>
                {d.fields
                  .filter((f) => values[f.key] !== latest.values[f.key])
                  .map((f) => (
                    <div key={f.key}>
                      <dt>{f.label}</dt>
                      <dd>{String(latest.values[f.key] ?? "—")}</dd>
                    </div>
                  ))}
              </dl>
              <button
                type="button"
                onClick={() => {
                  setValues({ ...latest.values });
                  setBaseValues({ ...latest.values });
                  setRevision(latest.revision);
                  operation.current = {
                    id: crypto.randomUUID(),
                    signature: "",
                  };
                  rememberOperation();
                  setConflict(false);
                  setError("");
                }}
              >
                {t.useLatest}
              </button>
              <p>{t.conflict}</p>
            </section>
          )}
          {error && (
            <p role="alert" className="error">
              {error}
            </p>
          )}
        </div>
        <footer className="modal-actions">
          <button type="button" onClick={onClose}>
            {t.close}
          </button>
          {pending && (
            <button
              type="button"
              disabled={w.busy}
              onClick={() => void save(undefined, true)}
            >
              {rt.retry}
            </button>
          )}
          {w.canEdit && (
            <button
              className="primary"
              type="submit"
              disabled={
                w.busy ||
                conflict ||
                pending ||
                (!record && d.source.kind === "google" && !appendConsent)
              }
            >
              {w.busy ? t.saving : t.save}
            </button>
          )}
        </footer>
      </form>
    </Modal>
  );
}
