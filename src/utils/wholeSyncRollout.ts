/** Release gate: enable only after the exact whole-commit SQL is approved and
 * installed, then verify one owned stream before broadening the deployment. */
export const WHOLE_SYNC_ROLLOUT_ENABLED = import.meta.env?.VITE_WHOLE_SYNC_ENABLED === 'true';
