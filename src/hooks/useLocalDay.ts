import { useEffect, useState } from 'react';
import { toLocalDateKey } from '../utils/date';

/** Refreshes date-based review counts when the local day changes or the app resumes. */
export function useLocalDay() {
  const [day, setDay] = useState(() => toLocalDateKey(new Date()));
  useEffect(() => {
    let timer: number;
    const refresh = () => {
      const now = new Date();
      setDay(toLocalDateKey(now));
      window.clearTimeout(timer);
      timer = window.setTimeout(refresh, new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1).getTime() - now.getTime() + 50);
    };
    refresh();
    window.addEventListener('focus', refresh);
    document.addEventListener('visibilitychange', refresh);
    return () => { window.clearTimeout(timer); window.removeEventListener('focus', refresh); document.removeEventListener('visibilitychange', refresh); };
  }, []);
  return day;
}
