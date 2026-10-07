/** Public builds opt in to the installed whole-commit RPCs. Each owned stream
 * opens only after complete copies of both sides are saved and reread. */
export const WHOLE_SYNC_ROLLOUT_ENABLED = import.meta.env?.VITE_WHOLE_SYNC_ENABLED === 'true';
