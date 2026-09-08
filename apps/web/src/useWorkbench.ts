import { useEffect, useRef, useState } from "react";
import {
  applyRecordPatch,
  createRecord,
  DomainError,
  undoChange,
  validateDataset,
  type ChangeEntry,
  type Dataset,
  type Locale,
  type RecordPatch,
  type Role,
  type CellValue,
} from "../../../packages/core/src/index";
import { makeDemo, type Template } from "../../../packages/core/src/demo";
import { api, ApiError, getLocal, setLocal } from "./api";
import { en, ko } from "./i18n";
export interface Workspace {
  id: string;
  name: string;
  role: Role;
}
export interface Session {
  user: { id: string; name: string; email: string; emailVerified?: boolean };
}
export function useWorkbench() {
  const [locale, setLocale] = useState<Locale>(() =>
    getLocal("sw.locale", navigator.language.startsWith("ko") ? "ko" : "en"),
  );
  const t = locale === "ko" ? ko : en;
  const [dataset, setDataset] = useState<Dataset>(() => {
    try {
      const cached = getLocal<Dataset | null>("sw.demo", null);
      return cached && cached.source.kind === "demo"
        ? validateDataset(cached)
        : makeDemo("team", locale);
    } catch {
      return makeDemo("team", locale);
    }
  });
  const [history, setHistory] = useState<ChangeEntry[]>([]),
    [session, setSession] = useState<Session | null>(null),
    [workspaces, setWorkspaces] = useState<Workspace[]>([]),
    [workspace, setWorkspace] = useState<Workspace | null>(null);
  const [datasets, setDatasets] = useState<{ id: string; name: string }[]>([]),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [online, setOnline] = useState(navigator.onLine);
  const [config, setConfig] = useState({
    teamMode: false,
    googleEnabled: false,
    storageLabel: "Not connected",
    googleClientId: "",
    googlePickerKey: "",
    googleAppId: "",
  });
  const current = useRef(dataset),
    generation = useRef(0),
    refreshing = useRef(false),
    queuedRefresh = useRef<{ source: boolean } | null>(null),
    historyRef = useRef(history);
  useEffect(() => {
    historyRef.current = history;
  }, [history]);
  useEffect(() => {
    current.current = dataset;
    if (dataset.source.kind === "demo") setLocal("sw.demo", dataset);
  }, [dataset]);
  useEffect(() => {
    setLocal("sw.locale", locale);
    document.documentElement.lang = locale;
  }, [locale]);
  useEffect(() => {
    const up = () => setOnline(true),
      down = () => setOnline(false);
    window.addEventListener("online", up);
    window.addEventListener("offline", down);
    return () => {
      window.removeEventListener("online", up);
      window.removeEventListener("offline", down);
    };
  }, []);
  const clearSession = () => {
    generation.current++;
    setSession(null);
    setWorkspace(null);
    setWorkspaces([]);
    setDatasets([]);
    setHistory([]);
    if (current.current.source.kind !== "demo")
      setDataset(makeDemo("team", locale));
    try {
      for (const key of Object.keys(sessionStorage))
        if (key.startsWith("sw.draft.")) sessionStorage.removeItem(key);
    } catch {}
  };
  const loadSession = async () => {
    try {
      const s = await api<Session | null>("/auth/get-session");
      setSession(s);
      if (s?.user) {
        const w = await api<Workspace[] | { workspaces: Workspace[] }>(
          "/workspaces",
        );
        setWorkspaces(Array.isArray(w) ? w : w.workspaces);
      } else clearSession();
    } catch {
      setSession(null);
    }
  };
  useEffect(() => {
    api<typeof config>("/config")
      .then(setConfig)
      .catch(() => {});
    void loadSession();
  }, []);
  const base = workspace
    ? `/workspaces/${workspace.id}/datasets/${dataset.id}`
    : "";
  const refresh = async (source = false) => {
    if (!workspace || dataset.source.kind === "demo") return;
    if (refreshing.current) {
      queuedRefresh.current = {
        source: source || Boolean(queuedRefresh.current?.source),
      };
      return;
    }
    const gen = generation.current;
    refreshing.current = true;
    try {
      if (source && dataset.source.kind === "google")
        await api(`${base}/refresh`, {});
      const [d, h] = await Promise.all([
        api<Dataset>(base),
        api<ChangeEntry[] | { entries: ChangeEntry[] }>(`${base}/history`),
      ]);
      if (gen !== generation.current) return;
      setDataset((existing) =>
        existing.id === d.id && existing.revision > d.revision ? existing : d,
      );
      setHistory(
        (Array.isArray(h) ? h : h.entries).sort((a, b) =>
          b.at.localeCompare(a.at),
        ),
      );
      setError("");
    } catch (e) {
      if (gen === generation.current) setError((e as Error).message);
    } finally {
      refreshing.current = false;
      const queued = queuedRefresh.current;
      queuedRefresh.current = null;
      if (queued && gen === generation.current) void refresh(queued.source);
    }
  };
  useEffect(() => {
    if (!base || dataset.source.kind === "demo") return;
    const es = new EventSource(`/api${base}/events`, { withCredentials: true });
    const changed = () => void refresh();
    es.onmessage = changed;
    es.addEventListener("revision", changed);
    const sourceChanged = () => {
      if (document.visibilityState === "visible") void refresh(true);
    };
    const timer = setInterval(sourceChanged, 60000);
    document.addEventListener("visibilitychange", sourceChanged);
    window.addEventListener("online", sourceChanged);
    return () => {
      es.close();
      clearInterval(timer);
      document.removeEventListener("visibilitychange", sourceChanged);
      window.removeEventListener("online", sourceChanged);
    };
  }, [base]);
  const openDataset = async (w: Workspace, id: string) => {
    const gen = ++generation.current;
    const datasetPath = `/workspaces/${w.id}/datasets/${id}`;
    const [d, entries] = await Promise.all([
      api<Dataset>(datasetPath),
      api<ChangeEntry[]>(`${datasetPath}/history`),
    ]);
    if (gen !== generation.current) return;
    setWorkspace(w);
    setDataset(d);
    current.current = d;
    setHistory(entries.sort((a, b) => b.at.localeCompare(a.at)));
    setError("");
    const list = await api<{ id: string; name: string }[]>(
      `/workspaces/${w.id}/datasets`,
    );
    if (gen === generation.current) setDatasets(list);
  };
  const chooseWorkspace = async (w: Workspace) => {
    setWorkspace(w);
    const d = await api<
      | { id: string; name: string }[]
      | { datasets: { id: string; name: string }[] }
    >(`/workspaces/${w.id}/datasets`);
    const list = Array.isArray(d) ? d : d.datasets;
    setDatasets(list);
    if (list[0]) await openDataset(w, list[0].id);
    else reset("team");
  };
  const reset = (template: Template) => {
    generation.current++;
    const demo = makeDemo(template, locale);
    current.current = demo;
    setDataset(demo);
    setHistory([]);
    historyRef.current = [];
    setError("");
  };
  const leaveWorkspace = () => {
    setWorkspace(null);
    setDatasets([]);
    reset("team");
  };
  const patch = async (p: RecordPatch) => {
    setBusy(true);
    setError("");
    try {
      if (current.current.source.kind === "demo") {
        const found = historyRef.current.find(
          (h) => h.operationId === p.operationId,
        );
        if (found)
          return current.current.records.find((r) => r.id === found.recordId)!;
        const result = applyRecordPatch(current.current, p, t.demoUser);
        current.current = result.dataset;
        setDataset(result.dataset);
        historyRef.current = [result.entry, ...historyRef.current];
        setHistory(historyRef.current);
        return result.record;
      }
      if (!online) throw new DomainError("OFFLINE", t.offlineError);
      const result = await api<{
        record: Dataset["records"][number];
        entry: ChangeEntry;
        datasetRevision: number;
      }>(`${base}/patch`, p);
      setDataset((d) =>
        d.id !== dataset.id || d.revision > result.datasetRevision
          ? d
          : {
              ...d,
              records: d.records.map((r) =>
                r.id === result.record.id ? result.record : r,
              ),
              revision: result.datasetRevision,
              updatedAt: result.entry.at,
            },
      );
      setHistory((h) => [
        result.entry,
        ...h.filter((e) => e.id !== result.entry.id),
      ]);
      return result.record;
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) await refresh();
      throw e;
    } finally {
      setBusy(false);
    }
  };
  const add = async (
    values: Record<string, CellValue>,
    operationId: string,
  ) => {
    setBusy(true);
    try {
      if (dataset.source.kind === "demo") {
        if (current.current.records.some((r) => r.id === operationId)) return;
        const record = createRecord(current.current, values, operationId);
        const next = {
          ...current.current,
          records: [...current.current.records, record],
          revision: current.current.revision + 1,
          updatedAt: new Date().toISOString(),
        };
        current.current = next;
        setDataset(next);
      } else {
        await api(`${base}/records`, { values, operationId });
        await refresh();
      }
    } finally {
      setBusy(false);
    }
  };
  const undo = async (entry: ChangeEntry) => {
    setBusy(true);
    try {
      const operationId = crypto.randomUUID();
      if (dataset.source.kind === "demo") {
        const result = undoChange(dataset, entry, operationId, t.demoUser);
        setDataset(result.dataset);
        setHistory((h) => [result.entry, ...h]);
      } else {
        await api(`${base}/undo`, { entryId: entry.id, operationId });
        await refresh();
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const updateSettings = async (settings: Partial<Dataset>) => {
    if (dataset.source.kind === "demo")
      setDataset((d) => validateDataset({ ...d, ...settings }));
    else {
      await api(`${base}/settings`, {
        baseRevision: dataset.revision,
        ...settings,
        ...(settings.fields
          ? {
              fields: settings.fields.map(({ type: _type, ...field }) => field),
            }
          : {}),
      });
      await refresh();
    }
    if (settings.locale) setLocale(settings.locale);
  };
  return {
    dataset,
    setDataset,
    history,
    session,
    loadSession,
    config,
    workspace,
    workspaces,
    setWorkspaces,
    chooseWorkspace,
    leaveWorkspace,
    datasets,
    openDataset,
    busy,
    error,
    setError,
    online,
    locale,
    setLocale,
    patch,
    add,
    undo,
    reset,
    refresh,
    updateSettings,
    canEdit:
      dataset.source.kind === "demo" ||
      (!dataset.source.readOnly &&
        (workspace?.role === "owner" || workspace?.role === "editor")),
    canAdd:
      dataset.source.kind !== "google" &&
      (dataset.source.kind === "demo" ||
        workspace?.role === "owner" ||
        workspace?.role === "editor"),
    base,
  };
}
export type Workbench = ReturnType<typeof useWorkbench>;
