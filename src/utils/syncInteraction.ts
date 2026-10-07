let protectedInteraction = false;
export const isSyncInteractionProtected = () => protectedInteraction;
export function setSyncInteractionProtected(value: boolean) { protectedInteraction = value; }
export function isSyncDisplaySafe(screenName: string): boolean {
  return screenName === 'home' || (screenName === 'sync' && !protectedInteraction);
}
