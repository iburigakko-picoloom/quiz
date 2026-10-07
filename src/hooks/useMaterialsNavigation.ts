import { useCallback, useEffect, useRef, useState } from 'react';
import type { MaterialsDrawerHandle } from '../components/MaterialsDrawer';

export type MaterialsExitGuard = (proceed: () => void) => Promise<boolean>;

export function useMaterialsNavigation(registerExitGuard?: (guard: MaterialsExitGuard | null) => void) {
  const drawer = useRef<MaterialsDrawerHandle>(null);
  const pending = useRef(false);
  const [open, setOpen] = useState(false);
  const [error, setError] = useState('');
  const transition = useCallback(async (proceed: () => void | Promise<void>) => {
    if (pending.current) return false;
    pending.current = true;
    try {
      await drawer.current?.flush();
      setError('');
      await proceed();
      return true;
    } catch {
      setError('資料の書き込みを保存できません。もう一度お試しください。');
      return false;
    } finally { pending.current = false; }
  }, []);
  useEffect(() => {
    registerExitGuard?.(transition);
    return () => registerExitGuard?.(null);
  }, [registerExitGuard, transition]);
  return { drawer, open, setOpen, error, transition };
}
