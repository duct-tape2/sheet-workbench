import { useState } from "react";
import Modal from "./Modal";
import type { Workbench } from "./useWorkbench";
import { colorNames, en, ko } from "./i18n";
import type { Dataset } from "../../../packages/core/src/types";
import { labelKey, categoryIndex } from "../../../packages/core/src/index";
export default function SettingsPanel({
  workbench: w,
  onClose,
}: {
  workbench: Workbench;
  onClose: () => void;
}) {
  const t = w.locale === "ko" ? ko : en;
  const [fields, setFields] = useState(w.dataset.fields),
    [colors, setColors] = useState(w.dataset.categoryColors ?? {});
  const categories = [
    ...new Set([
      ...(fields.find((f) => f.key === w.dataset.mapping.category)?.options ??
        []),
      ...w.dataset.records
        .map((r) => String(r.values[w.dataset.mapping.category ?? ""] ?? ""))
        .filter(Boolean),
    ]),
  ];
  const [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  return (
    <Modal title={t.settings} onClose={onClose} closeLabel={t.close}>
      <form
        className="modal-form"
        onSubmit={async (e) => {
          e.preventDefault();
          const f = new FormData(e.currentTarget);
          setBusy(true);
          setError("");
          try {
            await w.updateSettings({
              fields,
              categoryColors: colors,
              name: String(f.get("name")),
              locale: String(f.get("locale")) as Dataset["locale"],
              timeZone: String(f.get("timeZone")),
              weekStartsOn: Number(f.get("weekStartsOn")) as 0 | 1,
              completedStatuses: String(f.get("completed"))
                .split(",")
                .map((s) => s.trim())
                .filter(Boolean),
            });
            onClose();
          } catch (e) {
            setError((e as Error).message);
          } finally {
            setBusy(false);
          }
        }}
      >
        <div className="modal-body flow">
          <p>{t.settingsNote}</p>
          <label>
            {t.rename}
            <input
              name="name"
              defaultValue={w.dataset.name}
              required
              maxLength={160}
            />
          </label>
          <label>
            {t.language}
            <select name="locale" defaultValue={w.locale}>
              <option value="en">English</option>
              <option value="ko">한국어</option>
            </select>
          </label>
          <label>
            {t.timeZone}
            <input
              name="timeZone"
              defaultValue={w.dataset.timeZone}
              required
              list="timezones"
            />
            <datalist id="timezones">
              {[
                "UTC",
                "Asia/Seoul",
                "Asia/Tokyo",
                "America/New_York",
                "America/Los_Angeles",
                "Europe/London",
                "Europe/Paris",
                "Australia/Sydney",
              ].map((z) => (
                <option key={z}>{z}</option>
              ))}
            </datalist>
          </label>
          <label>
            {t.weekStart}
            <select name="weekStartsOn" defaultValue={w.dataset.weekStartsOn}>
              <option value="1">{t.monday}</option>
              <option value="0">{t.sunday}</option>
            </select>
          </label>
          <label>
            {t.completed}
            <input
              name="completed"
              defaultValue={w.dataset.completedStatuses.join(", ")}
            />
          </label>
          <h3>{t.inputFields}</h3>
          <p>{t.inputFieldsHelp}</p>
          {fields.map((field, i) => (
            <fieldset key={field.key}>
              <legend>{field.label}</legend>
              <label className="checkbox-label">
                <input
                  type="checkbox"
                  checked={!!field.required}
                  onChange={(e) =>
                    setFields((old) =>
                      old.map((f, n) =>
                        n === i ? { ...f, required: e.target.checked } : f,
                      ),
                    )
                  }
                />
                {t.required}
              </label>
              {field.type === "select" && (
                <label>
                  {t.choices}
                  <input
                    defaultValue={(field.options ?? []).join(", ")}
                    onChange={(e) =>
                      setFields((old) =>
                        old.map((f, n) =>
                          n === i
                            ? {
                                ...f,
                                options: e.target.value
                                  .split(",")
                                  .map((x) => x.trim())
                                  .filter(Boolean),
                              }
                            : f,
                        ),
                      )
                    }
                  />
                </label>
              )}
            </fieldset>
          ))}
          {categories.length > 0 && (
            <>
              <h3>{t.categoryColors}</h3>
              {categories.map((value) => (
                <label key={value}>
                  {value}
                  <select
                    value={colors[labelKey(value)] ?? categoryIndex(value)}
                    onChange={(e) =>
                      setColors((old) => ({
                        ...old,
                        [labelKey(value)]: Number(e.target.value),
                      }))
                    }
                  >
                    {colorNames[w.locale].map((name, i) => (
                      <option key={i} value={i}>
                        {name}
                      </option>
                    ))}
                  </select>
                </label>
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
          <button type="button" onClick={onClose}>
            {t.close}
          </button>
          <button className="primary" disabled={busy || !w.canEdit}>
            {busy ? t.saving : t.save}
          </button>
        </footer>
      </form>
    </Modal>
  );
}
