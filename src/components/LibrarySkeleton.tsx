import './LibrarySkeleton.css';

export function LibrarySkeleton({ label, rows = 3 }: { label: string; rows?: number }) {
  return <div className="library-skeleton" role="status" aria-label={label}>
    {Array.from({ length: rows }, (_, i) => <div className="library-skeleton__row" key={i} aria-hidden="true"><i/><span><b/><b/></span></div>)}
  </div>;
}
