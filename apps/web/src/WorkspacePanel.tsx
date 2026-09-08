import { useState } from "react";
import { Users, Plus, ArrowRight, Copy, ShieldCheck } from "lucide-react";
import type { Workbench, Workspace } from "./useWorkbench";
import Modal from "./Modal";
import { api } from "./api";
import { en, ko } from "./i18n";
import PortabilityPanel from "./PortabilityPanel";
export default function WorkspacePanel({
  workbench: w,
  onClose,
}: {
  workbench: Workbench;
  onClose: () => void;
}) {
  const t = w.locale === "ko" ? ko : en;
  const [mode, setMode] = useState<"sign-in" | "sign-up">("sign-in");
  const [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [invite, setInvite] = useState("");
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
  const authenticate = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    void run(async () => {
      await api(`/auth/${mode}/email`, {
        name: String(data.get("name") ?? ""),
        email: String(data.get("email")),
        password: String(data.get("password")),
      });
      await w.loadSession();
    });
  };
  return (
    <Modal title={t.workspace} onClose={onClose} closeLabel={t.close}>
      <div className="modal-body flow">
        {!w.config.teamMode ? (
          <div className="notice">
            <ShieldCheck />
            <p>{t.teamSetup}</p>
            <a href="/setup.html" target="_blank" rel="noreferrer">
              {t.setup}
            </a>
          </div>
        ) : !w.session?.user ? (
          <>
            <p>{t.authHelp}</p>
            <small>
              {t.storage}: {w.config.storageLabel}
            </small>
            <form className="flow" onSubmit={authenticate}>
              {mode === "sign-up" && (
                <label>
                  {t.name}
                  <input name="name" required autoComplete="name" />
                </label>
              )}
              <label>
                {t.email}
                <input
                  name="email"
                  type="email"
                  required
                  autoComplete="email"
                />
              </label>
              <label>
                {t.password}
                <input
                  name="password"
                  type="password"
                  required
                  minLength={12}
                  autoComplete={
                    mode === "sign-in" ? "current-password" : "new-password"
                  }
                />
              </label>
              <button className="primary" disabled={busy}>
                {mode === "sign-in" ? t.signIn : t.createAccount}
                <ArrowRight size={16} />
              </button>
            </form>
            <button
              className="text-button"
              onClick={() =>
                setMode(mode === "sign-in" ? "sign-up" : "sign-in")
              }
            >
              {mode === "sign-in" ? t.createAccount : t.signIn}
            </button>
          </>
        ) : (
          <>
            <div className="account-row">
              <Users />
              <div>
                <strong>{w.session.user.name}</strong>
                <small>{w.session.user.email}</small>
              </div>
              <button
                onClick={() =>
                  void run(async () => {
                    await api("/auth/sign-out", {});
                    w.reset("team");
                    await w.loadSession();
                    onClose();
                  })
                }
              >
                {t.signOut}
              </button>
            </div>
            <div className="workspace-list">
              {w.workspaces.map((space) => (
                <button
                  className="workspace-item"
                  key={space.id}
                  onClick={() =>
                    void run(async () => {
                      await w.chooseWorkspace(space);
                      onClose();
                    })
                  }
                >
                  <Users size={18} />
                  <span>{space.name}</span>
                  <small>{t[space.role]}</small>
                  <ArrowRight size={16} />
                </button>
              ))}
            </div>
            <form
              className="flow"
              onSubmit={(e) => {
                e.preventDefault();
                const form = new FormData(e.currentTarget);
                void run(async () => {
                  const result = await api<
                    Workspace | { workspace: Workspace }
                  >("/workspaces", { name: String(form.get("name")) });
                  const space =
                    "workspace" in result ? result.workspace : result;
                  await w.loadSession();
                  await w.chooseWorkspace({ ...space, role: "owner" });
                });
              }}
            >
              <label>
                {t.workspaceName}
                <input name="name" required maxLength={100} />
              </label>
              <button disabled={busy}>
                <Plus size={16} />
                {t.createWorkspace}
              </button>
            </form>
            {w.workspace?.role === "owner" && (
              <form
                className="flow"
                onSubmit={(e) => {
                  e.preventDefault();
                  const form = new FormData(e.currentTarget);
                  void run(async () => {
                    const r = await api<{ token?: string; url?: string }>(
                      `/workspaces/${w.workspace!.id}/invitations`,
                      {
                        email: String(form.get("email")),
                        role: String(form.get("role")),
                      },
                    );
                    setInvite(
                      r.url ??
                        `${location.origin}/?invite=${encodeURIComponent(r.token ?? "")}`,
                    );
                  });
                }}
              >
                <h3>{t.invite}</h3>
                <label>
                  {t.email}
                  <input name="email" type="email" required />
                </label>
                <label>
                  {t.role}
                  <select name="role">
                    <option value="viewer">{t.viewer}</option>
                    <option value="editor">{t.editor}</option>
                  </select>
                </label>
                <button disabled={busy}>{t.invite}</button>
              </form>
            )}
            {invite && (
              <label>
                {t.invitation}
                <input readOnly value={invite} />
                <button
                  onClick={() => void navigator.clipboard.writeText(invite)}
                >
                  <Copy size={16} />
                  {t.copy}
                </button>
              </label>
            )}
            <PortabilityPanel workbench={w} onDeleted={onClose} />
            <form
              className="flow"
              onSubmit={(e) => {
                e.preventDefault();
                const form = new FormData(e.currentTarget);
                void run(async () => {
                  await api(
                    `/invitations/${encodeURIComponent(String(form.get("token")))}/accept`,
                    {},
                  );
                  await w.loadSession();
                });
              }}
            >
              <label>
                {t.token}
                <input
                  name="token"
                  defaultValue={
                    new URLSearchParams(location.search).get("invite") ?? ""
                  }
                  required
                />
              </label>
              <button disabled={busy}>{t.acceptInvite}</button>
            </form>
          </>
        )}
        {error && (
          <p role="alert" className="error">
            {error}
          </p>
        )}
      </div>
      <footer className="modal-actions">
        <button onClick={onClose}>{t.close}</button>
      </footer>
    </Modal>
  );
}
