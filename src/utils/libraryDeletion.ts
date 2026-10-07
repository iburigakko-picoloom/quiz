import { accountLocalStorage as localStorage } from './accountStorage';
import { saveSyncedLocalStorage } from './localStorageRecords';
import type { AppData } from '../types';
import { loadAppDataAsync, saveAppDataAsync, waitForPendingAppDataSaves } from '../storage';
import {
  deleteAllCategoryNotes,
  deleteCategoryNotesForProblemSetIds,
  waitForPendingCategoryNoteSaves,
  loadCategoryNoteRaw,
} from './noteStorage';
import { validMaterialRecord, type MaterialIndex } from './materialModel';
import { withCoordinatedDataMutation } from './dataCoordination';
import { WEAKNESS_STORAGE_KEYS, NOTES_EVENT } from './weaknessNotes';
import { advanceLocalDataRevision } from './localDataRevision';

export type LibraryDeletionFailure =
  | 'app-save-failed'
  | 'notes-delete-failed'
  | 'rollback-failed'
  | 'referenced-material'
  | 'coordination-failed';

export type LibraryDeletionResult =
  | { ok: true; data: AppData }
  | { ok: false; reason: LibraryDeletionFailure; error?: unknown };

export interface LibraryDeletionPlan {
  nextData: AppData;
  problemSetIds: readonly string[];
}

interface LibraryDeletionRequest {
  buildPlan: (currentData: AppData) => LibraryDeletionPlan;
  deleteAllNotes?: boolean;
}

interface LibraryDeletionDependencies {
  waitForAppSaves: () => Promise<boolean>;
  waitForNoteSaves: () => Promise<void>;
  coordinate: <T>(operation: () => Promise<T>) => Promise<T>;
  loadAppData: () => Promise<AppData>;
  saveAppData: (data: AppData) => Promise<boolean>;
  deleteNotes: (problemSetIds: readonly string[], deleteAll: boolean) => Promise<void>;
  readMaterialIds?: (problemSetIds: readonly string[]) => Promise<Set<string>>;
}

const defaultDependencies: LibraryDeletionDependencies = {
  waitForAppSaves: waitForPendingAppDataSaves,
  waitForNoteSaves: waitForPendingCategoryNoteSaves,
  coordinate: (operation) => withCoordinatedDataMutation(
    ['app', 'notes'],
    operation,
    { requireCrossContext: true },
  ),
  loadAppData: () => loadAppDataAsync({ coordinationLockHeld: true }),
  saveAppData: (data) => saveAppDataAsync(data, { coordinationLockHeld: true }),
  readMaterialIds: async ids => {
    const result=new Set<string>();
    for(const id of ids){
      const raw=await loadCategoryNoteRaw(`quizMake:notes:${id}:__materials_v1`,{coordinationLockHeld:true});
      if(!raw)continue;
      const index=JSON.parse(raw) as MaterialIndex;
      if(index.kind!=='quiz-material-index' || index.problemSetId!==id || !validMaterialRecord(index as unknown as Record<string,unknown>))throw new Error('削除する教材の資料情報を確認できません。原本を残して削除を中止しました。');
      index.materials.forEach(material=>result.add(material.id));
    }
    return result;
  },
  deleteNotes: async (problemSetIds, deleteAll) => {
    if (deleteAll) {
      const previous = WEAKNESS_STORAGE_KEYS.map(key => [key, localStorage.getItem(key)] as const);
      try {
        await saveSyncedLocalStorage(Object.fromEntries(WEAKNESS_STORAGE_KEYS.map(key => [key, '[]'])));
        await deleteAllCategoryNotes({ coordinationLockHeld: true });
      } catch (error) {
        await saveSyncedLocalStorage(Object.fromEntries(previous));
        throw error;
      }
      advanceLocalDataRevision();
      window.dispatchEvent(new Event(NOTES_EVENT));
      return;
    }
    await deleteCategoryNotesForProblemSetIds(problemSetIds, { coordinationLockHeld: true });
  },
};

/**
 * Persists a destructive library change and its note cleanup while holding the
 * same origin-wide data lock. If note cleanup fails, the previous AppData is
 * restored before another tab can save on top of the partial deletion.
 */
export async function persistLibraryDeletion(
  request: LibraryDeletionRequest,
  dependencies: LibraryDeletionDependencies = defaultDependencies,
): Promise<LibraryDeletionResult> {
  try {
    const [appReady] = await Promise.all([
      dependencies.waitForAppSaves(),
      dependencies.waitForNoteSaves(),
    ]);
    if (!appReady) return { ok: false, reason: 'app-save-failed' };

    return await dependencies.coordinate(async () => {
      // Another same-origin operation may have imported newer data while this
      // deletion was waiting for the shared lock. Build the deletion from the
      // durable snapshot read inside the lock, never from stale React state.
      const previousData = await dependencies.loadAppData();
      const plan = request.buildPlan(previousData);
      if(!request.deleteAllNotes && dependencies.readMaterialIds){
        const materials=await dependencies.readMaterialIds(plan.problemSetIds);
        const removed=new Set(plan.problemSetIds);
        const dependentIds=new Set(previousData.questions.filter(question=>!removed.has(question.setId)
          && question.materialReferences?.some(reference=>materials.has(reference.materialId))).map(question=>question.setId));
        if(dependentIds.size){
          const titles=previousData.problemSets.filter(set=>dependentIds.has(set.id)).map(set=>set.title);
          return {ok:false,reason:'referenced-material',error:new Error(`「${titles.join('」「')}」から資料を参照しています。参照を解除してから削除してください。`)};
        }
      }
      const saved = await dependencies.saveAppData(plan.nextData);
      if (!saved) return { ok: false, reason: 'app-save-failed' };

      try {
        await dependencies.deleteNotes(plan.problemSetIds, request.deleteAllNotes === true);
      } catch (error) {
        const restored = await dependencies.saveAppData(previousData);
        return restored
          ? { ok: false, reason: 'notes-delete-failed', error }
          : { ok: false, reason: 'rollback-failed', error };
      }

      return { ok: true, data: plan.nextData };
    });
  } catch (error) {
    return { ok: false, reason: 'coordination-failed', error };
  }
}
