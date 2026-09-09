import { describe, expect, it } from 'vitest';
import { projectForViews } from '../apps/web/src/local/LocalViews';
import { report } from '../packages/core/src/index';
import type { TableData } from '../packages/local/src/types';

const fixture = (): TableData => ({ id: 'table', name: 'Requests', columns: [
  {key:'name',label:'Request',type:'text'}, {key:'date',label:'Due',type:'date'},
  {key:'status',label:'Status',type:'text'},
], rows: [
  {id:'a',values:{name:'First',date:'2026-09-09',status:'Pending'},origins:[]},
  {id:'b',values:{name:'Undated',date:'',status:'Done'},origins:[]},
] });

describe('optional local views share confirmed data', () => {
  it('does not manufacture dates or completed status and retains undated rows', () => {
    const table = fixture(); const before = structuredClone(table);
    const d = projectForViews(table, 'ko', {title:'name', status:'status'});
    expect(d.mapping.date).toBeUndefined();
    expect(d.completedStatuses).toEqual([]);
    expect(report(d).total).toBe(2);
    expect(d.records.map(r => r.values)).toEqual(table.rows.map(r => r.values));
    expect(table).toEqual(before);
  });
  it('reflects edited results while applying date filters only when requested', () => {
    const table = fixture(); table.rows[0].values.name = 'Confirmed revision';
    const d = projectForViews(table, 'en', {title:'name',date:'date',status:'status'});
    expect(report(d).markdown).toContain('Confirmed revision');
    expect(report(d).total).toBe(2);
    expect(report(d,{start:'2026-09-07',end:'2026-09-13'}).total).toBe(1);
  });
  it('drops stale column mappings after summary changes schema', () => {
    const d = projectForViews(fixture(), 'en', {title:'missing',date:'missing'});
    expect(d.mapping.title).toBe('name');
    expect(d.mapping.date).toBeUndefined();
    expect(d.source.readOnly).toBe(true);
  });
});
