import { useState } from "react";
import { api } from "./api";
import { pickGoogleSheet } from "./googlePicker";
import Modal from "./Modal";
import type { Workbench } from "./useWorkbench";
import type { Dataset, Mapping } from "../../../packages/core/src/types";
import { en, ko } from "./i18n";
import { suggestColumns } from "./columnSuggestions";
type Inspection = {
  spreadsheetId: string;
  title: string;
  canEdit: boolean;
  previewTruncated: boolean;
  sheets: {
    id: number;
    name: string;
    hidden: boolean;
    sheetType: string;
    rowCount: number;
    columnCount: number;
    preview: string[][];
  }[];
};
function letter(column: number) {
  let out = "";
  while (column) {
    column--;
    out = String.fromCharCode(65 + (column % 26)) + out;
    column = Math.floor(column / 26);
  }
  return out;
}
export default function GoogleImport({
  workbench: w,
  onClose,
}: {
  workbench: Workbench;
  onClose: () => void;
}) {
  const t = w.locale === "ko" ? ko : en;
  const [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [picking, setPicking] = useState(false),
    [authUrl, setAuthUrl] = useState(""),
    [inspection, setInspection] = useState<Inspection | null>(null),
    [consent, setConsent] = useState(false);
  const [selection, setSelection] = useState({
    sheetId: 0,
    headerRow: 1,
    startColumn: 1,
    endColumn: 8,
    endRow: 100,
    name: "",
    dateOrder: "ymd" as Dataset["dateOrder"],
    timeZone: w.dataset.timeZone,
    weekStartsOn: w.dataset.weekStartsOn,
  });
  const [mapping, setMapping] = useState<Mapping>({ title: "g_A" }),
    [confirmed, setConfirmed] = useState(false);
  const run = async (fn: () => Promise<void>) => {
    setError("");
    setBusy(true);
    try {
      await fn();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
      setPicking(false);
    }
  };
  const authorize = () =>
    run(async () => {
      const result = await api<{ url: string }>("/google/start");
      setAuthUrl(result.url);
    });
  const pick = () =>
    run(async () => {
      setPicking(true);
      const file = await pickGoogleSheet();
      setPicking(false);
      if (!file) return;
      const data = await api<Inspection>(
        `/workspaces/${w.workspace!.id}/google/inspect`,
        { spreadsheetId: file.id },
      );
      setInspection(data);
      const sheet = data.sheets.find(
        (s) => !s.hidden && s.sheetType === "GRID",
      );
      if (!sheet) throw new Error(t.noSupportedSheet);
      setSelection((s) => ({
        ...s,
        sheetId: sheet.id,
        name: data.title,
        endColumn: Math.min(26, sheet.preview[0]?.length || 8),
        endRow: Math.min(10001, sheet.rowCount || 100),
      }));
      setConfirmed(false);
      setMapping(
        suggestColumns(
          (sheet.preview[0] ?? []).map((label, i) => ({
            key: `g_${letter(i + 1)}`,
            label,
          })),
        ),
      );
    });
  const sheet = inspection?.sheets.find((s) => s.id === selection.sheetId);
  const fields = Array.from(
    {
      length: Math.max(
        0,
        Math.min(100, selection.endColumn - selection.startColumn + 1),
      ),
    },
    (_, i) => {
      const col = selection.startColumn + i;
      return {
        key: `g_${letter(col)}`,
        label:
          sheet?.preview[selection.headerRow - 1]?.[col - 1] || letter(col),
      };
    },
  );
  const save = () =>
    run(async () => {
      if (!inspection || !confirmed || !consent) return;
      const result = await api<{ dataset: Dataset }>(
        `/workspaces/${w.workspace!.id}/google/import`,
        {
          spreadsheetId: inspection.spreadsheetId,
          ...selection,
          mapping,
          locale: w.locale,
          consent: true,
        },
      );
      await w.openDataset(w.workspace!, result.dataset.id);
      onClose();
    });
  if (picking)
    return (
      <div className="picker-wait" role="status">
        {t.googlePickerWait}
      </div>
    );
  return (
    <Modal title={t.googleTitle} onClose={onClose} closeLabel={t.close} wide>
      <div className="modal-body flow">
        <p>
          {t.googleHelp} {t.googleShareNotice}
        </p>
        {!w.config.googleEnabled ? (
          <p>{t.googleSetup}</p>
        ) : (
          <>
            <div className="account-row">
              <button disabled={busy} onClick={() => void authorize()}>
                {t.connectGoogle}
              </button>
              <button disabled={busy} onClick={() => void pick()}>
                {t.openPicker}
              </button>
            </div>
            {authUrl && (
              <a href={authUrl} target="_blank" rel="noopener noreferrer">
                {t.continueGoogle}
              </a>
            )}
          </>
        )}
        {inspection && (
          <>
            <h3>{inspection.title}</h3>
            <p>{t.googleNoUniqueId}</p>
            <div className="form-grid">
              <label>
                {t.sheet}
                <select
                  value={selection.sheetId}
                  onChange={(e) => {
                    setSelection((s) => ({
                      ...s,
                      sheetId: Number(e.target.value),
                    }));
                    setConfirmed(false);
                  }}
                >
                  {inspection.sheets
                    .filter((s) => !s.hidden && s.sheetType === "GRID")
                    .map((s) => (
                      <option value={s.id} key={s.id}>
                        {s.name}
                      </option>
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
                    value={selection[key]}
                    onChange={(e) => {
                      setSelection((s) => ({
                        ...s,
                        [key]: Number(e.target.value),
                      }));
                      setConfirmed(false);
                    }}
                  />
                </label>
              ))}
              <label>
                {t.rename}
                <input
                  value={selection.name}
                  onChange={(e) =>
                    setSelection((s) => ({ ...s, name: e.target.value }))
                  }
                />
              </label>
              <label>
                {t.dateOrder}
                <select
                  value={selection.dateOrder}
                  onChange={(e) => {
                    setSelection((s) => ({
                      ...s,
                      dateOrder: e.target.value as Dataset["dateOrder"],
                    }));
                    setConfirmed(false);
                  }}
                >
                  <option value="ymd">YYYY-MM-DD</option>
                  <option value="dmy">DD/MM/YYYY</option>
                  <option value="mdy">MM/DD/YYYY</option>
                </select>
              </label>
              <label>
                {t.timeZone}
                <input
                  value={selection.timeZone}
                  onChange={(e) =>
                    setSelection((s) => ({ ...s, timeZone: e.target.value }))
                  }
                />
              </label>
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
                    onChange={(e) => {
                      setMapping(
                        (m) =>
                          ({
                            ...m,
                            [key]: e.target.value || undefined,
                          }) as Mapping,
                      );
                      setConfirmed(false);
                    }}
                  >
                    <option value="">{t.unmapped}</option>
                    {fields.map((f) => (
                      <option key={f.key} value={f.key}>
                        {f.label} ({f.key.slice(2)})
                      </option>
                    ))}
                  </select>
                </label>
              ))}
            </div>
            <button
              onClick={() => {
                setMapping(suggestColumns(fields));
                setConfirmed(false);
              }}
            >
              {t.suggestMapping}
            </button>
            <small>
              {t.dateWarning} {t.googlePreviewLimit}
            </small>
            <div className="preview-table">
              <table>
                <thead>
                  <tr>
                    {fields.map((f) => (
                      <th key={f.key}>{f.label}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {sheet?.preview
                    .slice(selection.headerRow, selection.headerRow + 5)
                    .map((row, i) => (
                      <tr key={i}>
                        {fields.map((f, c) => (
                          <td key={f.key}>
                            {row[selection.startColumn + c - 1] ?? "—"}
                          </td>
                        ))}
                      </tr>
                    ))}
                </tbody>
              </table>
            </div>
            <label className="checkbox-label">
              <input
                type="checkbox"
                checked={consent}
                onChange={(e) => setConsent(e.target.checked)}
              />
              {t.consent}
            </label>
            <label className="checkbox-label">
              <input
                type="checkbox"
                checked={confirmed}
                onChange={(e) => setConfirmed(e.target.checked)}
              />
              {t.reviewGoogleRange}
            </label>
          </>
        )}
        {busy && <p role="status">{t.saving}</p>}
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
      </div>
      <footer className="modal-actions">
        <button onClick={onClose}>{t.close}</button>
        {inspection && (
          <button
            className="primary"
            disabled={busy || !confirmed || !consent || !mapping.title}
            onClick={() => void save()}
          >
            {t.import}
          </button>
        )}
      </footer>
    </Modal>
  );
}
