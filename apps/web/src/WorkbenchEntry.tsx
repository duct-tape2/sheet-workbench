import { lazy, Suspense, useEffect, useState } from 'react';
import { initialLocale } from './locale';
import { STATIC_DEMO } from './environment';
const TeamApp = lazy(() => import('./App'));
const LocalWorkbench = lazy(() => import('./local/LocalWorkbench'));
const WorkContinuation = lazy(() => import('./workflow/WorkContinuation'));
export default function WorkbenchEntry() {
  const [locale, setLocale] = useState(() => {
    let saved: unknown;
    try { saved = localStorage.getItem('sw.locale'); if (saved) saved = JSON.parse(saved as string); } catch { /* Language preference is optional. */ }
    return initialLocale(location.search, saved, navigator.language);
  });
  const search = new URLSearchParams(location.search);
  useEffect(() => { document.documentElement.lang = locale; }, [locale]);
  const mode = search.get('mode') ?? (search.has('invite') ? 'team' : import.meta.env.VITE_DEFAULT_MODE ?? 'local');
  const go = (next: string) => {
    const target = new URL(location.href);
    target.searchParams.set('mode', next);
    target.searchParams.set('lang', locale);
    location.assign(target.href);
  };
  return <Suspense fallback={<p role="status">{locale === 'ko' ? '작업 화면을 여는 중…' : 'Opening your workbench…'}</p>}>
    {mode === 'work' ? <WorkContinuation locale={locale} onBack={() => go('local')} /> : mode === 'team' || mode === 'demo' ? <><TeamApp /><div style={{ padding: 'var(--space-sm)' }}><button onClick={() => go('local')}>{locale === 'ko' ? '개인 파일 도구' : 'Personal file tools'}</button></div></> :
      <LocalWorkbench locale={locale} onLocale={value => {
        setLocale(value);
        try { localStorage.setItem('sw.locale', JSON.stringify(value)); } catch { /* Still works without preference storage. */ }
        const target = new URL(location.href); target.searchParams.set('lang', value); history.replaceState(null, '', target);
        document.documentElement.lang = value;
      }} onLegacy={() => go(STATIC_DEMO ? 'demo' : 'team')} onContinue={() => go('work')} />}
  </Suspense>;
}
