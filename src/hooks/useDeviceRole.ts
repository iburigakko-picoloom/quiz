import { useSyncExternalStore } from 'react';
import { DEVICE_ROLE_EVENT, readDeviceRole } from '../utils/deviceRole';
const subscribe = (callback: () => void) => {
  window.addEventListener(DEVICE_ROLE_EVENT, callback); window.addEventListener('storage', callback);
  return () => { window.removeEventListener(DEVICE_ROLE_EVENT, callback); window.removeEventListener('storage', callback); };
};
export const useDeviceRole = () => useSyncExternalStore(subscribe, readDeviceRole, () => 'main' as const);
