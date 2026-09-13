import { useMemo, useState } from 'react';
import CalendarView from '../CalendarView';
import Modal from '../Modal';
import { report, weekRange, todayIn, addDays, type Dataset, type WorkRecord, type Locale } from '../../../../packages/core/src/index';
import type { TableData } from '../../../../packages/local/src/types';

/** Projection only: display mapping must never add a fake title/date to the file. */
export function projectForViews(table: TableData, locale: Locale, mapping: { title?: string; date?: string; status?: string; assignee?: string }): Dataset {
  const available = new Set(table.columns.map(c => c.key));
  const selected = (key?: string) => key && available.has(key) ? key : undefined;
  return {
    id: table.id, name: table.name, source: { kind: 'demo', readOnly: true }, revision: 0,
    fields: table.columns.map(c => ({ key: c.key, label: c.label, type: c.type === 'boolean' ? 'text' : c.type })),
    mapping: { title: selected(mapping.title) ?? table.columns[0]?.key ?? '', date: selected(mapping.date), status: selected(mapping.status), assignee: selected(mapping.assignee), category: selected(mapping.status) },
    records: table.rows.map(r => ({ id: r.id, revision: 0, values: r.values, lockedFields: r.locked })),
    locale, timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC', dateOrder: 'ymd', weekStartsOn: 1,
    updatedAt: '', completedStatuses: [],
  };
}
export default function LocalViews({ table, locale, disabled = false }: { table: TableData; locale: Locale; disabled?: boolean }) {
  const ko = locale === 'ko';
  const [view, setView] = useState<'calendar'|'board'|'report'>('calendar');
  const [mapping, setMapping] = useState<{ title?: string; date?: string; status?: string; assignee?: string }>({});
  const [selected, setSelected] = useState<WorkRecord | null>(null);
  const [copyState, setCopyState] = useState('');
  const d = useMemo(() => projectForViews(table, locale, mapping), [table, locale, mapping]);
  const [period, setPeriod] = useState(() => weekRange(todayIn(Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'), 1));
  const [allDates, setAllDates] = useState(true);
  const result = useMemo(() => report(d, allDates || !d.mapping.date ? {} : period), [d, allDates, period]);
  const board = useMemo(() => report(d), [d]);
  const text = !d.mapping.date ? result.markdown.replace(ko ? '주간 보고' : 'Weekly report', ko ? '자료 요약' : 'Data summary') : result.markdown;
  return <details className="local-views" inert={disabled} aria-disabled={disabled || undefined}>
    <summary>{ko ? '달력·상태 보드·보고서로 보기' : 'Calendar, status board and reports'}</summary>
    <p>{ko ? '필요한 열만 연결하세요. 원본 값은 바뀌지 않습니다. 달력은 YYYY-MM-DD 날짜를 표시합니다.' : 'Map only the columns you need. Source values stay unchanged. Calendar dates use YYYY-MM-DD.'}</p>
    <div className="local-view-mapping" style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--space-sm)' }}>
      {(['title','date','status','assignee'] as const).map((key, index) => <label key={key}>{(ko ? ['표시 이름','날짜','상태','담당자'] : ['Display name','Date','Status','Assignee'])[index]}
        <select aria-label={`${ko ? '보기' : 'View'} ${key}`} value={mapping[key] ?? ''} onChange={e => setMapping({ ...mapping, [key]: e.target.value || undefined })}>
          <option value="">{key === 'title' ? (ko ? '첫 번째 열' : 'First column') : (ko ? '연결하지 않음' : 'Not mapped')}</option>
          {table.columns.map(c => <option key={c.key} value={c.key}>{c.label}</option>)}
        </select></label>)}
    </div>
    <div className="segmented" style={{ flexWrap: 'wrap', marginBlock: 'var(--space-md)' }}>
      {(['calendar','board','report'] as const).map((key,index) => <button key={key} aria-pressed={key === view} onClick={() => setView(key)}>{(ko ? ['달력','상태 보드','보고서'] : ['Calendar','Status board','Report'])[index]}</button>)}
    </div>
    {view === 'calendar' && <CalendarView dataset={d} rows={d.records} locale={locale} canEdit={false} onSelect={setSelected} onMove={() => undefined} />}
    {view === 'board' && (!d.mapping.status ? <p>{ko ? '상태에 해당하는 열을 연결해 주세요.' : 'Choose a status column above.'}</p> : <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 16rem), 1fr))', gap: 'var(--space-md)' }}>
      {board.groups.map(([status,rows]) => <section key={status}><h3>{status} · {rows.length}</h3>{rows.map(row => <button key={row.id} style={{ display: 'block', maxWidth: '100%', marginBlock: 'var(--space-xs)', overflow: 'hidden', textOverflow: 'ellipsis' }} onClick={() => setSelected(row)}>{String(row.values[d.mapping.title] ?? row.id)}</button>)}</section>)}
    </div>)}
    {view === 'report' && <>
      {d.mapping.date && <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 'var(--space-sm)' }}>
        <label className="local-check"><input type="checkbox" checked={allDates} onChange={e => setAllDates(e.target.checked)} />{ko ? '전체 기간' : 'All dates'}</label>
        {!allDates && <><button onClick={() => setPeriod(weekRange(addDays(period.start, -7), 1))}>{ko ? '지난주' : 'Previous week'}</button><span>{period.start} – {period.end}</span><button onClick={() => setPeriod(weekRange(addDays(period.start, 7), 1))}>{ko ? '다음 주' : 'Next week'}</button></>}
      </div>}
      <p>{ko ? '위 결과 표의 확정 자료로 작성됩니다. 완료 상태는 자동 추정하지 않습니다.' : 'Generated from the confirmed result table. Completion is not inferred.'}</p>
      <textarea aria-label={ko ? '보고서 본문' : 'Report text'} readOnly value={text} rows={12} style={{ width: '100%' }} />
      <button onClick={async () => { try { await navigator.clipboard.writeText(text); setCopyState(ko ? '복사됨' : 'Copied'); } catch { setCopyState(ko ? '위 본문을 선택해 직접 복사해 주세요.' : 'Select the report text and copy it manually.'); } }}>{ko ? '보고서 복사' : 'Copy report'}</button><span role="status">{copyState}</span>
    </>}
    {selected && <Modal title={ko ? '자료 상세' : 'Record details'} closeLabel={ko ? '닫기' : 'Close'} onClose={() => setSelected(null)}><div className="modal-body"><dl>{table.columns.map(c => <div key={c.key}><dt>{c.label}</dt><dd style={{ overflowWrap: 'anywhere' }}>{String(selected.values[c.key] ?? '')}</dd></div>)}</dl></div><footer className="modal-actions"><button onClick={() => setSelected(null)}>{ko ? '닫기' : 'Close'}</button></footer></Modal>}
  </details>;
}
