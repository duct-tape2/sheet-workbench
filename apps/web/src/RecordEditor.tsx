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
  const operation = useRef({ id: crypto.randomUUID(), signature: "" });
  const latest = record
    ? w.dataset.records.find((r) => r.id === record.id)
    : undefined;
  const [revision, setRevision] = useState(record?.revision ?? 0);
  useEffect(() => {
    try {
      sessionStorage.setItem(draftKey, JSON.stringify(values));
    } catch {}
  }, [values, draftKey]);
  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    try {
      const changes = Object.fromEntries(
        Object.entries(values).filter(
          ([k, v]) => !record || v !== record.values[k],
        ),
      );
      const signature = JSON.stringify(changes);
      if (signature !== operation.current.signature)
        operation.current = { id: crypto.randomUUID(), signature };
      if (record && Object.keys(changes).length)
        await w.patch({
          operationId: operation.current.id,
          recordId: record.id,
          baseRevision: revision,
          changes,
        });
      else if (!record) await w.add(values, operation.current.id);
      try {
        sessionStorage.removeItem(draftKey);
      } catch {}
      onClose();
    } catch (e) {
      const message = (e as Error).message;
      setError(message);
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
                      disabled={locked}
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
                      disabled={locked}
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
                      disabled={locked}
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
                  setRevision(latest.revision);
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
          {w.canEdit && (
            <button
              className="primary"
              type="submit"
              disabled={w.busy || conflict}
            >
              {w.busy ? t.saving : t.save}
            </button>
          )}
        </footer>
      </form>
    </Modal>
  );
}
