interface LoginEnvironment { userAgent: string; platform: string; maxTouchPoints: number; standalone: boolean }

export function lineWebLoginQuery(environment?: LoginEnvironment): Record<string, string> | undefined {
  if (!environment) {
    if (typeof window === 'undefined' || typeof navigator === 'undefined') return undefined;
    environment = {
      userAgent: navigator.userAgent,
      platform: navigator.platform,
      maxTouchPoints: navigator.maxTouchPoints,
      standalone: (navigator as Navigator & { standalone?: boolean }).standalone === true || window.matchMedia('(display-mode: standalone)').matches,
    };
  }
  const ios = /iPad|iPhone|iPod/.test(environment.userAgent) || (environment.platform === 'MacIntel' && environment.maxTouchPoints > 1);
  // iPadOS can identify as desktop Safari. Keep auth in the web flow instead of
  // switching to LINE and returning to an unrelated Safari storage session.
  return ios && environment.standalone ? { disable_auto_login: 'true', prompt: 'login' } : undefined;
}
