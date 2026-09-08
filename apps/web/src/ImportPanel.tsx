import { useState } from "react";
import {
  FileSpreadsheet,
  Sheet,
  ArrowRight,
  Upload,
  Check,
} from "lucide-react";
import type { Dataset, Mapping } from "../../../packages/core/src/types";
import type {
  WorkbookInspection,
  ImportWorkbookOptions,
} from "../../../packages/xlsx/src/index";
import Modal from "./Modal";
import type { Workbench } from "./useWorkbench";
import { api } from "./api";
import { en, ko } from "./i18n";
import GoogleImport from "./GoogleImport";
export default function ImportPanel({
  workbench: w,
  onClose,
  onAccount,
}: {
  workbench: Workbench;
  onClose: () => void;
  onAccount: () => void;
}) {
  const t = w.locale === "ko" ? ko : en;
  const [consent, setConsent] = useState(false),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  const [inspection, setInspection] = useState<WorkbookInspection | null>(null),
    [buffer, setBuffer] = useState<Uint8Array | null>(null),
    [uploadId, setUploadId] = useState(""),
    [preview, setPreview] = useState<Dataset | null>(null),
    [fileName, setFileName] = useState("");
  const [options, setOptions] = useState<ImportWorkbookOptions>({
    locale: w.locale,
    dateOrder: "ymd",
    timeZone: w.dataset.timeZone,
    weekStartsOn: 1,
  });
  const [mapping, setMapping] = useState<Mapping>({ title: "" });
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
  const inspect = async (file: File) =>
    run(async () => {
      if (!consent || !w.workspace || !w.session) throw new Error(t.logInFirst);
      const data = new Uint8Array(await file.arrayBuffer());
      const engine = await import("../../../packages/xlsx/src/index");
      const checked = engine.inspectWorkbook(data);
      const form = new FormData();
      form.append("storageConsent", "true");
      form.append("file", file);
      const uploaded = await api<{ uploadId: string }>(
        `/workspaces/${w.workspace.id}/uploads`,
        form,
      );
      const next = {
        ...options,
        ...checked.suggestedSelection,
        fileName: file.name,
      };
      setBuffer(data);
      setInspection(checked);
      setOptions(next);
      setFileName(file.name);
      setUploadId(uploaded.uploadId);
      const proposed = engine.importWorkbook(data, next);
      setPreview(proposed);
      setMapping(proposed.mapping);
    });
  const previewMapping = () =>
    run(async () => {
      if (!buffer) return;
      const engine = await import("../../../packages/xlsx/src/index");
      const result = engine.importWorkbook(buffer, {
        ...options,
        mapping: mapping.title ? mapping : undefined,
      });
      setPreview(result);
      setMapping(result.mapping);
    });
  const save = () =>
    run(async () => {
      if (!w.workspace || !preview) return;
      const { fileName: _fileName, ...selection } = options;
      const result = await api<Dataset | { dataset: Dataset }>(
        `/workspaces/${w.workspace.id}/import`,
        {
          ...selection,
          uploadId,
          mapping,
          name: options.name || preview.name,
        },
      );
      const d = "dataset" in result ? result.dataset : result;
      await w.openDataset(w.workspace, d.id);
      onClose();
    });
  const [googleMode, setGoogleMode] = useState(false);
  if (googleMode) return <GoogleImport workbench={w} onClose={onClose} />;
  const google = () => setGoogleMode(true);
  return (
    <Modal
      title={inspection ? t.mapTitle : t.sourceChoice}
      onClose={onClose}
      closeLabel={t.close}
      wide
    >
      <div className="modal-body flow">
        {!w.session || !w.workspace ? (
          <div className="notice">
            <p>{t.authHelp}</p>
            <button className="primary" onClick={onAccount}>
              {t.signIn}
              <ArrowRight size={16} />
            </button>
          </div>
        ) : !inspection ? (
          <>
            <small>
              {t.storage}: {w.config.storageLabel} · {w.workspace.name}
            </small>
            <label className="checkbox-label">
              <input
                type="checkbox"
                checked={consent}
                onChange={(e) => setConsent(e.target.checked)}
              />
              {t.consent}
            </label>
            <div className="source-options">
              <section>
                <FileSpreadsheet size={30} />
                <h3>{t.fileTitle}</h3>
                <p>{t.fileHelp}</p>
                <label
                  className={`file-button ${!consent || busy ? "disabled" : ""}`}
                >
                  <Upload size={16} />
                  {t.upload}
                  <input
                    type="file"
                    accept=".xlsx"
                    disabled={!consent || busy || !w.canEdit}
                    onChange={(e) => {
                      const file = e.target.files?.[0];
                      if (file) void inspect(file);
                    }}
                  />
                </label>
              </section>
              <section>
                <Sheet size={30} />
                <h3>{t.googleTitle}</h3>
                <p>{t.googleHelp}</p>
                <button
                  disabled={!consent || busy}
                  onClick={() => void google()}
                >
                  {t.openPicker}
                  <ArrowRight size={16} />
                </button>
                {!w.config.googleEnabled && <small>{t.googleSetup}</small>}
              </section>
            </div>
          </>
        ) : (
          <>
            <p>
              {t.mapHelp} <strong>{fileName}</strong>
            </p>
            <div className="form-grid">
              <label>
                {t.sheet}
                <select
                  value={options.sheetName}
                  onChange={(e) => {
                    setOptions((o) => ({ ...o, sheetName: e.target.value }));
                    setPreview(null);
                    setMapping({ title: "" });
                  }}
                >
                  {inspection.sheets
                    .filter((s) => !s.hidden)
                    .map((s) => (
                      <option key={s.name}>{s.name}</option>
                    ))}
                </select>
              </label>
              {(
                ["headerRow", "startColumn", "endColumn", "endRow"] as const
              ).map((key) => (
                <label key={key}>
                  {t[key]}
                  <input
                    type="number"
                    min={1}
                    value={options[key] ?? 1}
                    onChange={(e) => {
                      setOptions((o) => ({
                        ...o,
                        [key]: Number(e.target.value),
                      }));
                      setPreview(null);
                    }}
                  />
                </label>
              ))}
              <label>
                {t.dateOrder}
                <select
                  value={options.dateOrder}
                  onChange={(e) => {
                    setOptions((o) => ({
                      ...o,
                      dateOrder: e.target.value as Dataset["dateOrder"],
                    }));
                    setPreview(null);
                  }}
                >
                  <option value="ymd">YYYY-MM-DD</option>
                  <option value="dmy">DD/MM/YYYY</option>
                  <option value="mdy">MM/DD/YYYY</option>
                </select>
              </label>
            </div>
            <small>{t.dateWarning}</small>
            <button disabled={busy} onClick={() => void previewMapping()}>
              {t.preview}
            </button>
            {preview && (
              <>
                <div className="form-grid">
                  {(
                    [
                      "title",
                      "date",
                      "assignee",
                      "status",
                      "category",
                      "identity",
                      "url",
                    ] as const
                  ).map((key) => (
                    <label key={key}>
                      {key === "url" ? "URL" : t[key]}
                      <select
                        value={mapping[key] ?? ""}
                        onChange={(e) =>
                          setMapping((m) => ({
                            ...m,
                            [key]: e.target.value || undefined,
                          }))
                        }
                      >
                        <option value="">{t.unmapped}</option>
                        {preview.fields.map((f) => (
                          <option key={f.key} value={f.key}>
                            {f.label}
                          </option>
                        ))}
                      </select>
                    </label>
                  ))}
                  <label>
                    {t.rename}
                    <input
                      value={options.name ?? preview.name}
                      onChange={(e) =>
                        setOptions((o) => ({ ...o, name: e.target.value }))
                      }
                    />
                  </label>
                </div>
                <div className="preview-table">
                  <table>
                    <thead>
                      <tr>
                        {preview.fields.map((f) => (
                          <th key={f.key}>{f.label}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {preview.records.slice(0, 5).map((r) => (
                        <tr key={r.id}>
                          {preview.fields.map((f) => (
                            <td key={f.key}>
                              {String(r.values[f.key] ?? "—")}
                            </td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <small>
                  {preview.records.length} {t.records}
                </small>
              </>
            )}
          </>
        )}
        {busy && <p role="status">{t.saving}</p>}
        {error && (
          <p role="alert" className="error">
            {error}
          </p>
        )}
      </div>
      <footer className="modal-actions">
        <button onClick={onClose}>{t.close}</button>
        {inspection && (
          <button
            className="primary"
            disabled={busy || !preview || !mapping.title}
            onClick={() => void save()}
          >
            <Check size={16} />
            {t.import}
          </button>
        )}
      </footer>
    </Modal>
  );
}
