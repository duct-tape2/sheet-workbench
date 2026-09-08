import { useState } from "react";
import { Download, Upload, Trash2 } from "lucide-react";
import { api, download } from "./api";
import type { Workbench, Workspace } from "./useWorkbench";
import { portabilityText } from "./portabilityText";

export default function PortabilityPanel({
  workbench: w,
  onDeleted,
}: {
  workbench: Workbench;
  onDeleted: () => void;
}) {
  const t = portabilityText[w.locale];
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [message, setMessage] = useState("");
  const [archive, setArchive] = useState<unknown>(),
    [fileName, setFileName] = useState(""),
    [restoreName, setRestoreName] = useState(""),
    [confirmName, setConfirmName] = useState("");
  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError("");
    setMessage("");
    try {
      await fn();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const owner = w.workspace?.role === "owner";
  return (
    <section className="flow" aria-label={t.title}>
      <h3>{t.title}</h3>
      <p>{t.explanation}</p>
      {owner && (
        <button
          disabled={busy}
          onClick={() =>
            void run(async () => {
              const data = await api(`/workspaces/${w.workspace!.id}/export`);
              download(
                JSON.stringify(data, null, 2),
                `workspace-${w.workspace!.id}-${new Date().toISOString().slice(0, 10)}.json`,
                "application/json",
              );
              setMessage(t.downloaded);
            })
          }
        >
          <Download size={16} />
          {t.export}
        </button>
      )}
      <label>
        {t.archive}
        <input
          type="file"
          accept=".json,application/json"
          disabled={busy}
          onChange={(e) => {
            const file = e.target.files?.[0];
            setArchive(undefined);
            setFileName("");
            if (!file) return;
            void run(async () => {
              if (file.size > 40 * 1024 * 1024) throw new Error(t.tooLarge);
              const value: unknown = JSON.parse(await file.text());
              setArchive(value);
              setFileName(file.name);
            });
          }}
        />
      </label>
      {fileName && (
        <>
          <small>{fileName}</small>
          <label>
            {t.newName}
            <input
              value={restoreName}
              onChange={(e) => setRestoreName(e.target.value)}
              maxLength={120}
            />
          </label>
          <button
            disabled={busy || !archive}
            onClick={() =>
              void run(async () => {
                const restored = await api<Workspace>("/workspaces/restore", {
                  archive,
                  ...(restoreName.trim()
                    ? { newWorkspaceName: restoreName.trim() }
                    : {}),
                });
                await w.loadSession();
                await w.chooseWorkspace({ ...restored, role: "owner" });
                setArchive(undefined);
                setFileName("");
                setMessage(t.restored);
              })
            }
          >
            <Upload size={16} />
            {t.restore}
          </button>
        </>
      )}
      {owner && (
        <details className="flow">
          <summary>{t.danger}</summary>
          <p>{t.deleteWarning}</p>
          <label>
            {t.confirm}: <strong>{w.workspace!.name}</strong>
            <input
              value={confirmName}
              onChange={(e) => setConfirmName(e.target.value)}
              autoComplete="off"
            />
          </label>
          <button
            className="danger"
            disabled={busy || confirmName !== w.workspace!.name}
            onClick={() =>
              void run(async () => {
                await api(
                  `/workspaces/${w.workspace!.id}`,
                  { confirmName },
                  "DELETE",
                );
                w.leaveWorkspace();
                await w.loadSession();
                onDeleted();
              })
            }
          >
            <Trash2 size={16} />
            {t.delete}
          </button>
        </details>
      )}
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      {message && <p role="status">{message}</p>}
    </section>
  );
}
