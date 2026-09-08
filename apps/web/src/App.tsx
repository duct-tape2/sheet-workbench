import { useMemo, useState } from "react";
import {
  ArrowDownToLine,
  ArrowRight,
  ArrowUpRight,
  CalendarDays,
  Check,
  ChevronDown,
  Clock3,
  Columns3,
  FileText,
  HelpCircle,
  History,
  LayoutGrid,
  Link2,
  ListChecks,
  Plus,
  Search,
  Settings,
  Sheet,
  SlidersHorizontal,
  Users,
  WifiOff,
  X,
} from "lucide-react";
import {
  categoryIndex,
  csv,
  filterRecords,
  issues,
  recordDate,
  report,
  todayIn,
  weekLabel,
  weekRange,
  type WorkRecord,
  type RecordFilter,
} from "../../../packages/core/src/index";
import { useWorkbench } from "./useWorkbench";
import { en, ko } from "./i18n";
import { download, getLocal, setLocal } from "./api";
import CalendarView from "./CalendarView";
import TableView from "./TableView";
import Modal from "./Modal";
import RecordEditor from "./RecordEditor";
import WorkspacePanel from "./WorkspacePanel";
import ImportPanel from "./ImportPanel";
import SettingsPanel from "./SettingsPanel";
import ReimportPanel from "./ReimportPanel";
import { colorFor } from "./colors";

export default function App() {
  const w = useWorkbench(),
    d = w.dataset,
    t = w.locale === "ko" ? ko : en;
  const [view, setView] = useState<"table" | "calendar" | "board" | "reports">(
    () => getLocal("sw.view", "calendar"),
  );
  const [panel, setPanel] = useState<
    | "account"
    | "import"
    | "history"
    | "settings"
    | "help"
    | "checks"
    | "export"
    | "reimport"
    | null
  >(new URLSearchParams(location.search).has("invite") ? "account" : null);
  const [editing, setEditing] = useState<{
      record: WorkRecord | null;
      initialDate?: string;
    } | null>(null),
    [filters, setFilters] = useState<RecordFilter>({}),
    [selected, setSelected] = useState(new Set<string>()),
    [bulkStatus, setBulkStatus] = useState(""),
    [copied, setCopied] = useState(false);
  const [period, setPeriod] = useState(() =>
    weekRange(todayIn(d.timeZone), d.weekStartsOn),
  );
  const rows = useMemo(() => filterRecords(d, filters), [d, filters]);
  const checks = useMemo(() => issues(d), [d]);
  const result = useMemo(
    () => report(d, { ...filters, ...period }),
    [d, filters, period],
  );
  const totalReport = report(d, filters);
  const viewReport = view === "reports" ? result : totalReport;
  const choices = (key: "status" | "category" | "assignee") => [
    ...new Set(
      d.records
        .map((r) => String(r.values[d.mapping[key] ?? ""] ?? ""))
        .filter(Boolean),
    ),
  ];
  const statusOptions = [
    ...new Set([
      ...(d.fields.find((f) => f.key === d.mapping.status)?.options ?? []),
      ...choices("status"),
    ]),
  ];
  const changeView = (next: typeof view) => {
    setView(next);
    setLocal("sw.view", next);
  };
  const invoke = async (fn: () => Promise<unknown>) => {
    w.setError("");
    try {
      await fn();
    } catch (e) {
      w.setError((e as Error).message);
    }
  };
  const bulk = async () => {
    const pending = new Set(selected);
    for (const r of d.records.filter((r) => selected.has(r.id))) {
      try {
        await w.patch({
          operationId: crypto.randomUUID(),
          recordId: r.id,
          baseRevision: r.revision,
          changes: { [d.mapping.status!]: bulkStatus },
        });
        pending.delete(r.id);
      } catch (e) {
        w.setError((e as Error).message);
      }
    }
    setSelected(pending);
  };
  const currentTitle = {
    table: t.table,
    calendar: t.calendar,
    board: t.board,
    reports: t.reports,
  }[view];
  return (
    <div className="app-shell">
      <a className="skip-link" href="#main" tabIndex={0}>
        {t.skipToWorkspace}
      </a>
      <aside className="sidebar">
        <a className="brand" href="/" aria-label="Sheet Workbench home">
          <span className="brand-symbol">
            <Sheet size={22} />
          </span>
          <span>
            sheet
            <br />
            <b>workbench</b>
          </span>
        </a>
        <button
          className="workspace-switch"
          onClick={() => setPanel("account")}
        >
          <span className="workspace-avatar">
            {w.workspace?.name.slice(0, 1) || "S"}
          </span>
          <span>
            <strong>{w.workspace?.name || t.sample}</strong>
            <small>{w.workspace ? t[w.workspace.role] : t.localDemo}</small>
          </span>
          <ChevronDown size={15} />
        </button>
        <div className="side-group">
          <p>{t.templates}</p>
          {(["team", "requests", "content"] as const).map((type, i) => (
            <button
              key={type}
              className={
                d.id === `demo-${type}` ? "side-link active" : "side-link"
              }
              onClick={() => {
                w.reset(type);
                setFilters({});
                setSelected(new Set());
              }}
            >
              {i === 0 ? (
                <ListChecks size={17} />
              ) : i === 1 ? (
                <Users size={17} />
              ) : (
                <CalendarDays size={17} />
              )}
              <span>{t[type]}</span>
            </button>
          ))}
        </div>
        {w.datasets.length > 0 && w.workspace && (
          <div className="side-group">
            {w.datasets.map((item) => (
              <button
                className="side-link"
                key={item.id}
                onClick={() =>
                  void invoke(() => w.openDataset(w.workspace!, item.id))
                }
              >
                <Sheet size={17} />
                {item.name}
              </button>
            ))}
          </div>
        )}
        <div className="sidebar-bottom">
          <button className="side-link" onClick={() => setPanel("help")}>
            <HelpCircle size={17} />
            {t.help}
          </button>
          <button className="side-link" onClick={() => setPanel("settings")}>
            <Settings size={17} />
            {t.settings}
          </button>
          <div className="language-toggle">
            <button
              aria-pressed={w.locale === "en"}
              onClick={() => w.setLocale("en")}
            >
              EN
            </button>
            <span>/</span>
            <button
              aria-pressed={w.locale === "ko"}
              onClick={() => w.setLocale("ko")}
            >
              한국어
            </button>
          </div>
          <p>{t.footer}</p>
        </div>
      </aside>
      <div className="main-wrap">
        <header className="topbar">
          <div className="breadcrumb">
            <LayoutGrid size={16} />
            <span>{w.workspace?.name || t.sample}</span>
            <span>/</span>
            <strong>{currentTitle}</strong>
          </div>
          <button
            className="account-button"
            onClick={() => setPanel("account")}
          >
            <Users size={16} />
            <span>{w.session?.user.name || t.signIn}</span>
          </button>
        </header>
        <main id="main" tabIndex={-1}>
          <section className="intro">
            <div>
              <h1>{t.overview}</h1>
              <p>{t.intro}</p>
            </div>
            <button className="primary" onClick={() => setPanel("import")}>
              <Link2 size={17} />
              {t.connect}
              <ArrowRight size={17} />
            </button>
          </section>
          <div className="dataset-heading">
            <div>
              <h2>{d.name}</h2>
              <p className="source-status">
                <span
                  className={w.online ? "status-dot" : "status-dot offline"}
                />
                {d.source.kind === "demo"
                  ? t.sampleNote
                  : `${d.source.kind === "xlsx" ? t.fileTitle : t.googleTitle} · ${d.source.fileName || d.source.sheetName || ""}`}
                <button
                  className="inline-icon"
                  aria-label={t.settings}
                  onClick={() => setPanel("settings")}
                >
                  <SlidersHorizontal size={14} />
                </button>
              </p>
            </div>
            <div className="dataset-actions">
              {d.source.kind === "xlsx" && (
                <button
                  disabled={!w.canEdit}
                  onClick={() => setPanel("reimport")}
                >
                  {t.compareFile}
                </button>
              )}
              {d.source.kind === "google" && (
                <button onClick={() => void w.refresh(true)}>
                  {t.refresh}
                </button>
              )}
              <button onClick={() => setPanel("history")}>
                <History size={16} />
                <span>{t.history}</span>
              </button>
              <button onClick={() => setPanel("export")}>
                <ArrowDownToLine size={16} />
                <span>{t.export}</span>
              </button>
            </div>
          </div>
          {d.source.readOnly && (
            <p className="notice">
              {t.viewOnly} {d.source.readOnlyReason}
            </p>
          )}
          {!w.online && (
            <div className="notice" role="status">
              <WifiOff size={18} />
              {t.offline}
            </div>
          )}
          {w.error && (
            <div className="error banner" role="alert">
              <span>{w.error}</span>
              <button
                className="icon-button"
                aria-label={t.close}
                onClick={() => w.setError("")}
              >
                <X size={16} />
              </button>
            </div>
          )}
          <section className="metrics" aria-label={t.recordSummary}>
            <div>
              <span>{t.due}</span>
              <strong>
                {viewReport.total}
                <small>{t.records}</small>
              </strong>
            </div>
            <div>
              <span>{t.done}</span>
              <strong>
                {viewReport.completed}
                <small>/ {viewReport.total}</small>
              </strong>
            </div>
            <button onClick={() => setPanel("checks")}>
              <span>
                {t.review}
                <ArrowUpRight size={15} />
              </span>
              <strong>
                {checks.length}
                <small>{t.items}</small>
              </strong>
            </button>
          </section>
          <section className="workbench">
            <div className="view-toolbar">
              <nav className="view-tabs" aria-label={t.view}>
                {(
                  [
                    { key: "table", icon: Sheet },
                    { key: "calendar", icon: CalendarDays },
                    { key: "board", icon: Columns3 },
                    { key: "reports", icon: FileText },
                  ] as const
                ).map(({ key, icon: Icon }) => (
                  <button
                    key={key}
                    aria-current={view === key ? "page" : undefined}
                    onClick={() => changeView(key)}
                  >
                    <Icon size={16} />
                    {t[key]}
                  </button>
                ))}
              </nav>
              <button
                className="new-button"
                disabled={!w.canAdd}
                onClick={() => setEditing({ record: null })}
              >
                <Plus size={17} />
                <span>{t.newRecord}</span>
              </button>
            </div>
            <div className="filter-toolbar">
              <label className="search-field">
                <span className="sr-only">{t.search}</span>
                <Search size={16} />
                <input
                  aria-label={t.search}
                  placeholder={t.search}
                  value={filters.query ?? ""}
                  onChange={(e) =>
                    setFilters((f) => ({ ...f, query: e.target.value }))
                  }
                />
              </label>
              <div className="filter-selects">
                {(["status", "assignee", "category"] as const)
                  .filter((k) => d.mapping[k])
                  .map((key) => (
                    <label key={key}>
                      <span className="sr-only">{t[key]}</span>
                      <select
                        aria-label={t[key]}
                        value={filters[key] ?? ""}
                        onChange={(e) =>
                          setFilters((f) => ({ ...f, [key]: e.target.value }))
                        }
                      >
                        <option value="">
                          {t[key]} · {t.all}
                        </option>
                        {choices(key).map((v) => (
                          <option key={v}>{v}</option>
                        ))}
                      </select>
                    </label>
                  ))}
                {Object.values(filters).some(Boolean) && (
                  <button
                    className="icon-button"
                    aria-label={t.clear}
                    onClick={() => setFilters({})}
                  >
                    <X size={16} />
                  </button>
                )}
              </div>
            </div>
            {selected.size > 0 && view === "table" && (
              <div className="bulk-toolbar">
                <strong>
                  {selected.size} {t.selected}
                </strong>
                {d.mapping.status && (
                  <>
                    <label>
                      <span className="sr-only">{t.bulkStatus}</span>
                      <select
                        aria-label={t.bulkStatus}
                        value={bulkStatus}
                        onChange={(e) => setBulkStatus(e.target.value)}
                      >
                        <option value="">{t.bulkStatus}</option>
                        {statusOptions.map((s) => (
                          <option key={s}>{s}</option>
                        ))}
                      </select>
                    </label>
                    <button
                      disabled={!bulkStatus || w.busy || !w.canEdit}
                      onClick={() => void bulk()}
                    >
                      {t.apply}
                    </button>
                  </>
                )}
                <small>{t.bulkHint}</small>
              </div>
            )}
            {view === "table" && (
              <TableView
                dataset={d}
                rows={rows}
                locale={w.locale}
                onSelect={(r) => setEditing({ record: r })}
                selected={selected}
                setSelected={setSelected}
              />
            )}
            {view === "calendar" && (
              <CalendarView
                dataset={d}
                rows={rows}
                locale={w.locale}
                canEdit={w.canEdit}
                onSelect={(r) => setEditing({ record: r })}
                onMove={(r, date) =>
                  setEditing({ record: r, initialDate: date })
                }
              />
            )}
            {view === "board" && (
              <div className="board">
                {[
                  ...statusOptions,
                  ...(rows.some((r) => !r.values[d.mapping.status ?? ""])
                    ? [""]
                    : []),
                ].map((status) => {
                  const members = rows.filter(
                    (r) =>
                      String(r.values[d.mapping.status ?? ""] ?? "") === status,
                  );
                  return (
                    <section className="board-column" key={status}>
                      <h3>
                        <span
                          className={`category-dot category-${categoryIndex(status)}`}
                        />
                        {status || t.noStatus}
                        <small>{members.length}</small>
                      </h3>
                      <div className="board-items">
                        {members.map((r) => (
                          <button
                            className="board-record"
                            key={r.id}
                            onClick={() => setEditing({ record: r })}
                          >
                            <span
                              className={`pill category-${colorFor(d, r.values[d.mapping.category ?? ""])}`}
                            >
                              {String(
                                r.values[d.mapping.category ?? ""] ?? "—",
                              )}
                            </span>
                            <strong>
                              {String(r.values[d.mapping.title] ?? "—")}
                            </strong>
                            <span className="board-meta">
                              <span>
                                {String(
                                  r.values[d.mapping.assignee ?? ""] ?? "—",
                                )}
                              </span>
                              <span>
                                <CalendarDays size={13} />
                                {recordDate(d, r) || "—"}
                              </span>
                            </span>
                          </button>
                        ))}
                      </div>
                    </section>
                  );
                })}
              </div>
            )}
            {view === "reports" && (
              <div className="report-view">
                <div className="report-controls">
                  <label>
                    {t.periodStart}
                    <input
                      type="date"
                      value={period.start}
                      onChange={(e) => {
                        if (e.target.value)
                          setPeriod((p) => ({ ...p, start: e.target.value }));
                      }}
                    />
                  </label>
                  <label>
                    {t.periodEnd}
                    <input
                      type="date"
                      value={period.end}
                      onChange={(e) => {
                        if (e.target.value)
                          setPeriod((p) => ({ ...p, end: e.target.value }));
                      }}
                    />
                  </label>
                  <button
                    onClick={() =>
                      void invoke(async () => {
                        await navigator.clipboard.writeText(result.text);
                        setCopied(true);
                        setTimeout(() => setCopied(false), 2500);
                      })
                    }
                  >
                    {copied ? <Check size={16} /> : <FileText size={16} />}{" "}
                    {copied ? t.copied : t.copy}
                  </button>
                  <button
                    onClick={() =>
                      download(result.markdown, `report-${period.start}.md`)
                    }
                  >
                    <ArrowDownToLine size={16} />
                    {t.downloadReport}
                  </button>
                </div>
                <p className="report-hint">{t.reportHint}</p>
                <article className="report-paper">
                  <div className="report-paper-heading">
                    <div>
                      <span>{t.reports}</span>
                      <h3>
                        {period.end ===
                        weekRange(period.start, d.weekStartsOn).end
                          ? weekLabel(period.start, w.locale, d.weekStartsOn)
                          : `${period.start} — ${period.end}`}
                      </h3>
                      <p>
                        {period.start} — {period.end}
                      </p>
                    </div>
                    <strong>
                      {result.total}
                      <small>{t.records}</small>
                    </strong>
                  </div>
                  {result.groups.map(([status, records]) => (
                    <section className="report-group" key={status}>
                      <h4>
                        {status}
                        <span>{records.length}</span>
                      </h4>
                      {records.map((r) => (
                        <button
                          className="report-row"
                          key={r.id}
                          onClick={() => setEditing({ record: r })}
                        >
                          <time>{recordDate(d, r)}</time>
                          <span>
                            {String(r.values[d.mapping.title] ?? "—")}
                          </span>
                          <small>
                            {String(r.values[d.mapping.assignee ?? ""] ?? "")}
                          </small>
                          <ArrowUpRight size={15} />
                        </button>
                      ))}
                    </section>
                  ))}
                  {!result.total && <p className="empty-state">{t.noRows}</p>}
                </article>
              </div>
            )}
            <footer className="workbench-footer">
              <span>
                {view === "reports" ? result.total : rows.length} {t.records}
              </span>
              {d.source.kind === "google" && (
                <span role="status">
                  {d.lastSyncError ? t.sourceCheckFailed : t.sourceChecked}
                  {": "}
                  {d.lastCheckedAt
                    ? new Intl.DateTimeFormat(
                        w.locale === "ko" ? "ko-KR" : "en-US",
                        {
                          hour: "2-digit",
                          minute: "2-digit",
                          second: "2-digit",
                        },
                      ).format(new Date(d.lastCheckedAt))
                    : "—"}
                </span>
              )}
              <span>
                <Clock3 size={13} />
                {t.lastUpdated}:{" "}
                {new Intl.DateTimeFormat(
                  w.locale === "ko" ? "ko-KR" : "en-US",
                  { hour: "2-digit", minute: "2-digit" },
                ).format(new Date(d.updatedAt))}
              </span>
            </footer>
          </section>
          <footer className="page-footer">
            <span>{t.tagline}</span>
            <button className="text-button" onClick={() => setPanel("help")}>
              {t.help}
              <ArrowUpRight size={14} />
            </button>
          </footer>
        </main>
      </div>
      {editing && (
        <RecordEditor
          key={`${editing.record?.id ?? "new"}:${editing.initialDate ?? ""}`}
          workbench={w}
          {...editing}
          onClose={() => setEditing(null)}
        />
      )}
      {panel === "account" && (
        <WorkspacePanel workbench={w} onClose={() => setPanel(null)} />
      )}
      {panel === "import" && (
        <ImportPanel
          workbench={w}
          onClose={() => setPanel(null)}
          onAccount={() => setPanel("account")}
        />
      )}
      {panel === "settings" && (
        <SettingsPanel workbench={w} onClose={() => setPanel(null)} />
      )}
      {panel === "reimport" && (
        <ReimportPanel workbench={w} onClose={() => setPanel(null)} />
      )}
      {panel === "history" && (
        <Modal
          title={t.history}
          onClose={() => setPanel(null)}
          closeLabel={t.close}
        >
          <div className="modal-body flow">
            {!w.history.length && <p>{t.nothingChanged}</p>}
            {w.history.map((entry) => (
              <article className="history-entry" key={entry.id}>
                <small>
                  {entry.actor} · {new Date(entry.at).toLocaleString(w.locale)}
                </small>
                <dl>
                  {Object.entries(entry.after).map(([key, value]) => (
                    <div key={key}>
                      <dt>
                        {d.fields.find((f) => f.key === key)?.label || key}
                      </dt>
                      <dd>
                        <del>{String(entry.before[key] ?? "—")}</del>
                        <ArrowRight size={12} />
                        <span>{String(value ?? "—")}</span>
                      </dd>
                    </div>
                  ))}
                </dl>
                <button
                  disabled={w.busy || !w.canEdit}
                  onClick={() => void w.undo(entry)}
                >
                  {t.undo}
                </button>
              </article>
            ))}
          </div>
          <footer className="modal-actions">
            <button onClick={() => setPanel(null)}>{t.close}</button>
          </footer>
        </Modal>
      )}
      {panel === "checks" && (
        <Modal
          title={t.dataChecks}
          onClose={() => setPanel(null)}
          closeLabel={t.close}
        >
          <div className="modal-body flow">
            {!checks.length && <p>{t.checksClear}</p>}
            {checks.map((c, i) => (
              <button
                className="check-item"
                key={`${c.recordId}-${i}`}
                onClick={() => {
                  setPanel(null);
                  const r = d.records.find((r) => r.id === c.recordId);
                  if (r) setEditing({ record: r });
                }}
              >
                <span>
                  <strong>
                    {String(
                      d.records.find((r) => r.id === c.recordId)?.values[
                        d.mapping.title
                      ] ?? "—",
                    )}
                  </strong>
                  <small>{c.message}</small>
                </span>
                <ArrowUpRight size={16} />
              </button>
            ))}
          </div>
          <footer className="modal-actions">
            <button onClick={() => setPanel(null)}>{t.close}</button>
          </footer>
        </Modal>
      )}
      {panel === "help" && (
        <Modal
          title={t.help}
          onClose={() => setPanel(null)}
          closeLabel={t.close}
        >
          <div className="modal-body flow">
            <h3>{t.helpTitle}</h3>
            <p>{t.helpBody}</p>
            <p>{t.privacy}</p>
            <label>
              {t.templates}
              <select
                defaultValue=""
                onChange={(e) => {
                  if (e.target.value) {
                    w.reset(e.target.value as "team" | "requests" | "content");
                    setPanel(null);
                  }
                }}
              >
                <option value="">{t.sample}</option>
                {(["team", "requests", "content"] as const).map((type) => (
                  <option key={type} value={type}>
                    {t[type]}
                  </option>
                ))}
              </select>
            </label>
            <label>
              {t.language}
              <select
                value={w.locale}
                onChange={(e) => w.setLocale(e.target.value as "en" | "ko")}
              >
                <option value="en">English</option>
                <option value="ko">한국어</option>
              </select>
            </label>
            <p>{t.sourceReadOnly}</p>
            <a href="/setup.html" target="_blank" rel="noreferrer">
              {t.setup}
            </a>
          </div>
          <footer className="modal-actions">
            <button onClick={() => setPanel(null)}>{t.close}</button>
            {d.source.kind === "demo" && (
              <button
                onClick={() => {
                  w.reset("team");
                  setPanel(null);
                }}
              >
                {t.reset}
              </button>
            )}
          </footer>
        </Modal>
      )}
      {panel === "export" && (
        <Modal
          title={t.export}
          onClose={() => setPanel(null)}
          closeLabel={t.close}
        >
          <div className="modal-body flow">
            <p>
              {d.source.kind === "xlsx"
                ? t.fileHelp
                : d.source.kind === "google"
                  ? t.googleHelp
                  : t.sampleNote}
            </p>
            <button
              onClick={() =>
                download(
                  csv(d, rows),
                  `${d.name}.csv`,
                  "text/csv;charset=utf-8",
                )
              }
            >
              <ArrowDownToLine size={16} />
              {t.downloadCSV}
            </button>
            {d.source.kind === "xlsx" && (
              <button
                onClick={() =>
                  void invoke(async () => {
                    const response = await fetch(`/api${w.base}/export`, {
                      credentials: "include",
                    });
                    if (!response.ok) {
                      const e = await response.json();
                      throw new Error(e.message || e.error);
                    }
                    download(
                      await response.blob(),
                      d.source.fileName || "updated.xlsx",
                      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
                    );
                  })
                }
              >
                {t.downloadXLSX}
              </button>
            )}
            <button
              onClick={() =>
                download(report(d, filters).markdown, `${d.name}-report.md`)
              }
            >
              {t.downloadReport}
            </button>
          </div>
          <footer className="modal-actions">
            <button onClick={() => setPanel(null)}>{t.close}</button>
          </footer>
        </Modal>
      )}
    </div>
  );
}
