import { useState } from "react";
import {
  Users,
  Plus,
  ArrowRight,
  Copy,
  ShieldCheck,
  KeyRound,
  Trash2,
  UserRoundCog,
} from "lucide-react";
import type { Workbench, Workspace } from "./useWorkbench";
import Modal from "./Modal";
import { api } from "./api";
import { en, ko } from "./i18n";
import PortabilityPanel from "./PortabilityPanel";
import { adminText } from "./adminText";
import { appHref, STATIC_DEMO } from "./environment";
import { staticDemoText } from "./staticDemoText";

type AdminMember = {
  id: string;
  name: string;
  email: string;
  role: "owner" | "editor" | "viewer";
};
type AccountDeletionStatus = {
  canDelete: boolean;
  blockedWorkspaces: Array<{ id: string; name: string }>;
};
export default function WorkspacePanel({
  workbench: w,
  onClose,
}: {
  workbench: Workbench;
  onClose: () => void;
}) {
  const t = w.locale === "ko" ? ko : en;
  const a = adminText[w.locale];
  const resetToken = new URLSearchParams(location.search).get("token");
  const resetEnabled = Boolean(
    (w.config as typeof w.config & { passwordResetEnabled?: boolean })
      .passwordResetEnabled,
  );
  const [mode, setMode] = useState<
    "sign-in" | "sign-up" | "request-reset" | "complete-reset"
  >(resetToken ? "complete-reset" : "sign-in");
  const [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [invite, setInvite] = useState(""),
    [notice, setNotice] = useState(""),
    [members, setMembers] = useState<AdminMember[] | null>(null),
    [datasetDeleteOpen, setDatasetDeleteOpen] = useState(false),
    [accountDeleteOpen, setAccountDeleteOpen] = useState(false),
    [accountDeletion, setAccountDeletion] =
      useState<AccountDeletionStatus | null>(null);
  const staticText = staticDemoText[w.locale];
  if (STATIC_DEMO)
    return (
      <Modal title={t.workspace} onClose={onClose} closeLabel={t.close}>
        <div className="modal-body flow">
          <p>{staticText.accountNotice}</p>
          <p>{staticText.accountHelp}</p>
          <a href={appHref("setup.html")} target="_blank" rel="noreferrer">
            {t.setup}
          </a>
        </div>
        <footer className="modal-actions">
          <button onClick={onClose}>{t.close}</button>
        </footer>
      </Modal>
    );
  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError("");
    setNotice("");
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
  const requestPasswordReset = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    void run(async () => {
      await api("/auth/request-password-reset", {
        email: String(data.get("email")),
        redirectTo: `${location.origin}/?reset-password=1`,
      });
      setNotice(a.resetRequested);
    });
  };
  const completePasswordReset = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    void run(async () => {
      if (!resetToken) throw new Error("Password reset token is missing.");
      await api("/auth/reset-password", {
        token: resetToken,
        newPassword: String(data.get("password")),
      });
      setMode("sign-in");
      setNotice(a.resetComplete);
      history.replaceState(null, "", location.pathname);
    });
  };
  return (
    <Modal title={t.workspace} onClose={onClose} closeLabel={t.close}>
      <div className="modal-body flow">
        {!w.config.teamMode ? (
          <div className="notice">
            <ShieldCheck />
            <p>{t.teamSetup}</p>
            <a href={appHref("setup.html")} target="_blank" rel="noreferrer">
              {t.setup}
            </a>
          </div>
        ) : !w.session?.user ? (
          mode === "request-reset" ? (
            <>
              <h3>{a.resetPassword}</h3>
              <p>{a.resetPasswordHelp}</p>
              <form className="flow" onSubmit={requestPasswordReset}>
                <label>
                  {t.email}
                  <input name="email" type="email" required autoComplete="email" />
                </label>
                <button className="primary" disabled={busy || !resetEnabled}>
                  <KeyRound size={16} />
                  {a.resetPassword}
                </button>
              </form>
              {!resetEnabled && <p className="notice">{a.resetPasswordDisabled}</p>}
              <button className="text-button" onClick={() => setMode("sign-in")}>
                {a.backToSignIn}
              </button>
            </>
          ) : mode === "complete-reset" ? (
            <>
              <h3>{a.resetPassword}</h3>
              <form className="flow" onSubmit={completePasswordReset}>
                <label>
                  {a.newPassword}
                  <input
                    name="password"
                    type="password"
                    required
                    minLength={12}
                    autoComplete="new-password"
                  />
                </label>
                <button className="primary" disabled={busy || !resetToken}>
                  <KeyRound size={16} />
                  {a.resetPassword}
                </button>
              </form>
              <button className="text-button" onClick={() => setMode("sign-in")}>
                {a.backToSignIn}
              </button>
            </>
          ) : (
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
              {mode === "sign-in" && (
                <button
                  className="text-button"
                  disabled={!resetEnabled}
                  title={!resetEnabled ? a.resetPasswordDisabled : undefined}
                  onClick={() => setMode("request-reset")}
                >
                  {a.forgotPassword}
                </button>
              )}
              {!resetEnabled && mode === "sign-in" && (
                <small>{a.resetPasswordDisabled}</small>
              )}
            </>
          )
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
            {w.workspace?.role === "owner" && (
              <section className="flow" aria-label={a.members}>
                <h3>{a.members}</h3>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() =>
                    void run(async () => {
                      const result = await api<AdminMember[]>(
                        `/workspaces/${w.workspace!.id}/members`,
                      );
                      setMembers(result);
                    })
                  }
                >
                  <UserRoundCog size={16} />
                  {a.manageMembers}
                </button>
                {members?.map((member) => (
                  <div className="account-row" key={member.id}>
                    <Users size={18} />
                    <div>
                      <strong>{member.name}</strong>
                      <small>{member.email}</small>
                    </div>
                    <select
                      aria-label={`${t.role}: ${member.name}`}
                      value={member.role}
                      disabled={busy}
                      onChange={(event) => {
                        const role = event.target.value as AdminMember["role"];
                        void run(async () => {
                          const updated = await api<AdminMember>(
                            `/workspaces/${w.workspace!.id}/members/${member.id}`,
                            { role },
                            "PATCH",
                          );
                          setMembers((current) =>
                            current?.map((item) =>
                              item.id === updated.id ? updated : item,
                            ) ?? null,
                          );
                          await w.loadSession();
                        });
                      }}
                    >
                      <option value="owner">{t.owner}</option>
                      <option value="editor">{t.editor}</option>
                      <option value="viewer">{t.viewer}</option>
                    </select>
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() =>
                        void run(async () => {
                          await api(
                            `/workspaces/${w.workspace!.id}/members/${member.id}`,
                            undefined,
                            "DELETE",
                          );
                          setMembers((current) =>
                            current?.filter((item) => item.id !== member.id) ??
                            null,
                          );
                          await w.loadSession();
                        })
                      }
                    >
                      {a.removeMember}
                    </button>
                  </div>
                ))}
              </section>
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
            {w.workspace && w.datasets.some((item) => item.id === w.dataset.id) && (
              <section className="flow" aria-label={a.deleteDataset}>
                <h3>{a.deleteDataset}</h3>
                <p>{a.deleteDatasetHelp}</p>
                {!datasetDeleteOpen ? (
                  <button
                    type="button"
                    disabled={busy || w.workspace.role !== "owner"}
                    onClick={() => setDatasetDeleteOpen(true)}
                  >
                    <Trash2 size={16} />
                    {a.deleteDataset}
                  </button>
                ) : (
                  <form
                    className="flow"
                    onSubmit={(event) => {
                      event.preventDefault();
                      const form = new FormData(event.currentTarget);
                      void run(async () => {
                        await api(
                          `/workspaces/${w.workspace!.id}/datasets/${w.dataset.id}`,
                          { confirmName: String(form.get("confirmName")) },
                          "DELETE",
                        );
                        setDatasetDeleteOpen(false);
                        await w.chooseWorkspace(w.workspace!);
                      });
                    }}
                  >
                    <label>
                      {a.confirmDatasetName}
                      <input name="confirmName" required autoComplete="off" />
                    </label>
                    <button className="primary" disabled={busy}>
                      <Trash2 size={16} />
                      {a.deleteDataset}
                    </button>
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => setDatasetDeleteOpen(false)}
                    >
                      {t.cancel}
                    </button>
                  </form>
                )}
              </section>
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
            <section className="flow" aria-label={a.deleteAccount}>
              <h3>{a.deleteAccount}</h3>
              <p>{a.deleteAccountHelp}</p>
              {!accountDeleteOpen ? (
                <button
                  type="button"
                  disabled={busy}
                  onClick={() =>
                    void run(async () => {
                      const status = await api<AccountDeletionStatus>(
                        "/account/deletion-status",
                      );
                      setAccountDeletion(status);
                      setAccountDeleteOpen(true);
                    })
                  }
                >
                  <Trash2 size={16} />
                  {a.deleteAccount}
                </button>
              ) : (
                <>
                  {accountDeletion?.blockedWorkspaces.length ? (
                    <>
                      <p>{a.transferOwnership}</p>
                      <ul>
                        {accountDeletion.blockedWorkspaces.map((workspace) => (
                          <li key={workspace.id}>{workspace.name}</li>
                        ))}
                      </ul>
                    </>
                  ) : (
                    <form
                      className="flow"
                      onSubmit={(event) => {
                        event.preventDefault();
                        const form = new FormData(event.currentTarget);
                        void run(async () => {
                          await api("/account/delete", {
                            confirmName: String(form.get("confirmName")),
                            confirmEmail: String(form.get("confirmEmail")),
                            password:
                              String(form.get("password") ?? "").trim() ||
                              undefined,
                          });
                          w.reset("team");
                          await w.loadSession();
                          onClose();
                        });
                      }}
                    >
                      <label>
                        {a.confirmAccountName}
                        <input name="confirmName" required autoComplete="off" />
                      </label>
                      <label>
                        {a.confirmAccountEmail}
                        <input
                          name="confirmEmail"
                          type="email"
                          required
                          autoComplete="off"
                        />
                      </label>
                      <label>
                        {a.currentPasswordOptional}
                        <input
                          name="password"
                          type="password"
                          minLength={12}
                          autoComplete="current-password"
                        />
                      </label>
                      <button className="primary" disabled={busy}>
                        <Trash2 size={16} />
                        {a.deleteAccount}
                      </button>
                    </form>
                  )}
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => setAccountDeleteOpen(false)}
                  >
                    {t.cancel}
                  </button>
                </>
              )}
            </section>
          </>
        )}
        {notice && <p className="notice">{notice}</p>}
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
