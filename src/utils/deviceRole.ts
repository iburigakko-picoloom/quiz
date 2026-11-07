import type { AppData } from '../types';

export type DeviceRole = 'main' | 'sub';
// Installation setting, deliberately outside backup/account/sync key namespaces.
export const DEVICE_ROLE_KEY = 'quizMakeDeviceRole:v1';
export const DEVICE_ROLE_EVENT = 'quiz-make-device-role';
export const DEVICE_ROLE_WORK_LOCK = 'quiz-make-device-role-work-v1';
export function readDeviceRole(storage: Pick<Storage, 'getItem'> = globalThis.localStorage): DeviceRole {
  try { const raw = storage.getItem(DEVICE_ROLE_KEY); return raw === null || raw === 'main' ? 'main' : 'sub'; }
  catch { return 'sub'; }
}
export function assertMainDevice() {
  if (readDeviceRole() !== 'main') throw new Error('この操作はメイン端末で行ってください。');
}
export function isContentChange(before: AppData, after: AppData): boolean {
  const changed = (a: unknown, b: unknown) => a !== b && JSON.stringify(a) !== JSON.stringify(b);
  if (before.version !== after.version || changed(before.folders, after.folders) || changed(before.questions, after.questions)) return true;
  if (before.problemSets === after.problemSets) return false;
  const content = (data: AppData) => data.problemSets.map(({ isStudyCompleted: _completed, updatedAt: _updated, ...set }) => set);
  return changed(content(before), content(after));
}
export type DeviceRoleChangeDependencies = {
  exclusive: (operation: () => Promise<void>) => Promise<boolean>;
  flush: () => Promise<boolean>;
  coordinate: (operation: () => Promise<void>) => Promise<void>;
  assertSafe: () => Promise<void>;
  storage: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
  changed: () => void;
};
/** Only the role key is written. Data, outboxes, device identity and epochs survive. */
export async function changeDeviceRole(role: DeviceRole, dependencies: DeviceRoleChangeDependencies): Promise<void> {
  const acquired = await dependencies.exclusive(async () => {
    if (!await dependencies.flush()) throw new Error('保存を完了できません。復旧後に端末を切り替えてください。');
    await dependencies.coordinate(async () => {
      await dependencies.assertSafe();
      const previous = dependencies.storage.getItem(DEVICE_ROLE_KEY);
      try {
        dependencies.storage.setItem(DEVICE_ROLE_KEY, role);
        if (dependencies.storage.getItem(DEVICE_ROLE_KEY) !== role) throw new Error('端末の設定を保存できません。');
      } catch (error) {
        if (previous === null) dependencies.storage.removeItem(DEVICE_ROLE_KEY);
        else dependencies.storage.setItem(DEVICE_ROLE_KEY, previous);
        throw error;
      }
    });
  });
  if (!acquired) throw new Error('ほかの画面で保存・学習・同期を行っています。完了してから切り替えてください。');
  dependencies.changed();
}
