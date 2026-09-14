/** Settings-only pictograms: consistent strokes, no decorative tile. */
export function SettingsIcon({ kind }: { kind: 'companion' | 'sound' | 'sync' | 'backup' | 'transfer' | 'privacy' }) {
  return <svg className="settings-pictogram" width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
    {kind === 'companion' && <>
      <ellipse cx="5.5" cy="9" rx="2" ry="2.7" transform="rotate(-25 5.5 9)" />
      <ellipse cx="10" cy="5.7" rx="1.8" ry="2.6" />
      <ellipse cx="15" cy="5.7" rx="1.8" ry="2.6" />
      <ellipse cx="19" cy="9.5" rx="1.8" ry="2.5" transform="rotate(25 19 9.5)" />
      <path d="M7 15c2-1.5 2-4 5-4s3 2.5 5 4c3 3 .5 6-2 5-2-.8-4-.8-6 0-2.5 1-5-2-2-5Z" fill="currentColor" fillOpacity=".12" />
    </>}
    {kind === 'sound' && <><path d="M4 9h4l5-4v14l-5-4H4Z" fill="currentColor" fillOpacity=".12" /><path d="M16 8a6 6 0 0 1 0 8m3-11a10 10 0 0 1 0 14" /></>}
    {kind === 'sync' && <><path d="M5 7a8 8 0 0 1 14 1M19 3v5h-5M19 17a8 8 0 0 1-14-1m0 5v-5h5" /></>}
    {kind === 'backup' && <><rect x="4" y="8" width="16" height="12" rx="2" fill="currentColor" fillOpacity=".1" /><path d="M3 4h18v4H3zM9 12h6m-3 0v5m-2-2 2 2 2-2" /></>}
    {kind === 'transfer' && <><path d="M4 7h15m-4-4 4 4-4 4M20 17H5m4-4-4 4 4 4" /></>}
    {kind === 'privacy' && <><path d="m12 3 8 3v6c0 5-8 9-8 9s-8-4-8-9V6Z" fill="currentColor" fillOpacity=".1" /><rect x="9" y="10" width="6" height="6" rx="1" /><path d="M10 10V8a2 2 0 0 1 4 0v2" /></>}
  </svg>;
}
