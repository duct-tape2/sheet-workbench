import { useRef, useState } from "react";
import Modal from "./Modal";
import type { Workbench } from "./useWorkbench";
import { api } from "./api";
import { en, ko } from "./i18n";
type Preview = {
  previewId: string;
  baseRevision: number;
  changes: {
    kind: string;
    recordId: string;
    fields?: Record<string, { before: unknown; after: unknown }>;
    before?: unknown;
    after?: unknown;
  }[];
  conflicts: { message: string }[];
};
export default function ReimportPanel({
  workbench: w,
  onClose,
}: {
  workbench: Workbench;
  onClose: () => void;
}) {
  const t = w.locale === "ko" ? ko : en;
  const [consent, setConsent] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [preview, setPreview] = useState<Preview | null>(null);
  const operationId = useRef(crypto.randomUUID());
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
  const upload = (file: File) =>
    run(async () => {
      setPreview(null);
      const form = new FormData();
      form.append("storageConsent", "true");
      form.append("file", file);
      const { uploadId } = await api<{ uploadId: string }>(
        `/workspaces/${w.workspace!.id}/uploads`,
        form,
      );
      const result = await api<Preview>(`${w.base}/reimport/preview`, {
        uploadId,
      });
      setPreview(result);
      operationId.current = crypto.randomUUID();
    });
  const confirm = () =>
    run(async () => {
      if (!preview) return;
      await api(`${w.base}/reimport/confirm`, {
        previewId: preview.previewId,
        baseRevision: preview.baseRevision,
        operationId: operationId.current,
      });
      await w.refresh();
      onClose();
    });
  return (
    <Modal
      title={t.compareReplacement}
      onClose={onClose}
      closeLabel={t.close}
      wide
    >
      <div className="modal-body flow">
        <p>{t.reimportHelp}</p>
        <label className="checkbox-label">
          <input
            type="checkbox"
            checked={consent}
            onChange={(e) => setConsent(e.target.checked)}
          />
          {t.consent}
        </label>
        <label>
          {t.upload}
          <input
            type="file"
            accept=".xlsx"
            disabled={!consent || busy}
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) void upload(file);
            }}
          />
        </label>
        {preview && (
          <>
            <h3>
              {preview.changes.length} {t.changes}
            </h3>
            {preview.conflicts.map((c, i) => (
              <p className="error" key={i}>
                {c.message}
              </p>
            ))}
            {preview.changes.map((c, i) => (
              <article className="history-entry" key={i}>
                <strong>{c.kind}</strong>
                <small> · {c.recordId}</small>
                <dl>
                  {Object.entries(c.fields ?? {}).map(([key, v]) => (
                    <div key={key}>
                      <dt>
                        {w.dataset.fields.find((f) => f.key === key)?.label ||
                          key}
                      </dt>
                      <dd>
                        <del>{String(v.before ?? "—")}</del> →{" "}
                        {String(v.after ?? "—")}
                      </dd>
                    </div>
                  ))}
                </dl>
                {c.before !== undefined && (
                  <pre>{JSON.stringify(c.before, null, 2)}</pre>
                )}
                {c.after !== undefined && (
                  <pre>{JSON.stringify(c.after, null, 2)}</pre>
                )}
              </article>
            ))}
          </>
        )}
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
      </div>
      <footer className="modal-actions">
        <button onClick={onClose}>{t.close}</button>
        <button
          className="primary"
          disabled={busy || !preview || preview.conflicts.length > 0}
          onClick={() => void confirm()}
        >
          {busy ? t.saving : t.apply}
        </button>
      </footer>
    </Modal>
  );
}
