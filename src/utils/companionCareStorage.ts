import type { AnswerLog } from '../types';
import { accountLocalStorage, getAccountStorageSession } from './accountStorage';
import { withCoordinatedDataMutation } from './dataCoordination';
import { replayLocalStorageProjections, saveSyncedLocalStorage } from './localStorageRecords';
import { COMPANION_CARE_KEY, COMPANION_CARE_EVENT, applyCompanionCareAction, createCompanionCare,
  creditCompanionAnswers, parseCompanionCare, refreshCompanionDay, type CompanionCare, type CompanionCareAction } from './companionCare';
import { getStudyTimeZone } from './studyPlanStorage';
import { studyDay } from './studyPlans';
import { advanceLocalDataRevision } from './localDataRevision';

export function readCompanionCare(): CompanionCare | null {
  const raw = accountLocalStorage.getItem(COMPANION_CARE_KEY);
  return raw === null ? null : parseCompanionCare(raw);
}

/** Read/modify/write under the existing account/origin lock. Food and mastery commit together. */
export async function saveCompanionCare(logs: readonly Pick<AnswerLog, 'id'>[], options: { visit?: boolean; action?: CompanionCareAction; now?: Date } = {}): Promise<CompanionCare> {
  const owner = getAccountStorageSession(), native = globalThis.localStorage;
  const assertOwner = () => {
    if (owner !== getAccountStorageSession() || native !== globalThis.localStorage) throw new Error('アカウントが変わりました。育成画面を開き直してください。');
    owner?.assertCurrent();
  };
  return withCoordinatedDataMutation(['app'], async () => {
    assertOwner();
    await replayLocalStorageProjections(undefined, [COMPANION_CARE_KEY]);
    assertOwner();
    const day = studyDay(options.now ?? new Date(), getStudyTimeZone());
    const previous = readCompanionCare();
    let next = refreshCompanionDay(creditCompanionAnswers(previous ?? createCompanionCare(day), logs), day, options.visit);
    if (options.action) next = applyCompanionCareAction(next, options.action, day);
    if (previous !== next) {
      assertOwner();
      let committed = false;
      try {
        await saveSyncedLocalStorage({ [COMPANION_CARE_KEY]: JSON.stringify(next) }, () => { committed = true; advanceLocalDataRevision(); });
      } catch (error) {
        // A failed UI-cache refresh after the atomic IDB commit must not invite
        // a second food spend. The next operation replays that durable value.
        if (!committed) throw error;
      }
      assertOwner();
      if (typeof window !== 'undefined') window.dispatchEvent(new Event(COMPANION_CARE_EVENT));
    }
    return next;
  }, { requireCrossContext: typeof indexedDB !== 'undefined' });
}
