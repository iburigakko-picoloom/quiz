import { useCallback, useEffect, useRef, useState } from 'react';
import type { AnswerLog } from '../types';
import { COMPANION_CARE_EVENT, type CompanionCare, type CompanionCareAction } from '../utils/companionCare';
import { readCompanionCare, saveCompanionCare } from '../utils/companionCareStorage';
import { isStudyCompanionEnabled, STUDY_COMPANION_EVENT } from '../utils/studyCompanion';
import { useLocalDay } from './useLocalDay';
import { WHOLE_EVENT } from '../utils/wholeSyncStorage';

export function useCompanionCare(logs: readonly AnswerLog[], ready: boolean, visiting: boolean) {
  const [care, setCare] = useState<CompanionCare | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [enabled, setEnabled] = useState(isStudyCompanionEnabled);
  const day = useLocalDay();
  const logsRef = useRef(logs);
  logsRef.current = logs;
  const readyRef = useRef(ready);
  readyRef.current = ready;
  const mounted = useRef(true);
  const actionBusy = useRef(false);
  const refresh = useCallback(() => {
    try { setCare(readCompanionCare()); setError(''); }
    catch (error) { setError(error instanceof Error ? error.message : '育成データを読み込めませんでした。'); }
  }, []);

  useEffect(() => {
    mounted.current = true;
    const preference = () => setEnabled(isStudyCompanionEnabled());
    const storage = () => { preference(); refresh(); };
    window.addEventListener(COMPANION_CARE_EVENT, refresh);
    window.addEventListener(STUDY_COMPANION_EVENT, preference);
    window.addEventListener('storage', storage);
    return () => {
      mounted.current = false;
      window.removeEventListener(COMPANION_CARE_EVENT, refresh);
      window.removeEventListener(STUDY_COMPANION_EVENT, preference);
      window.removeEventListener('storage', storage);
    };
  }, [refresh]);

  const reconcile = useCallback(async () => {
    if (!ready) return;
    try {
      const next = await saveCompanionCare(logsRef.current, { visit: visiting && enabled, automatic: true, isCurrent: () => mounted.current && readyRef.current });
      if (mounted.current) { setCare(next); setError(''); }
    } catch (error) {
      if (mounted.current) setError(error instanceof Error ? error.message : 'ごはんの獲得を保存できませんでした。もう一度お試しください。');
    }
  }, [ready, visiting, enabled]);

  useEffect(() => { void reconcile(); }, [logs, day, reconcile]);
  useEffect(() => {
    const synchronized = () => { refresh(); void reconcile(); };
    window.addEventListener(WHOLE_EVENT, synchronized);
    return () => window.removeEventListener(WHOLE_EVENT, synchronized);
  }, [reconcile, refresh]);

  const act = useCallback(async (action: CompanionCareAction) => {
    if (!ready || actionBusy.current) return null;
    actionBusy.current = true;
    setBusy(true);
    try {
      const next = await saveCompanionCare(logsRef.current, { visit: true, action });
      if (mounted.current) { setCare(next); setError(''); }
      return next;
    } catch (error) {
      if (mounted.current) setError(error instanceof Error ? error.message : 'お世話を保存できませんでした。もう一度お試しください。');
      return null;
    } finally {
      actionBusy.current = false;
      if (mounted.current) setBusy(false);
    }
  }, [ready]);
  return { care, error, busy, enabled, act, retry: reconcile };
}
