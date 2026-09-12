import { useId, type SVGProps } from 'react';

type IconProps = SVGProps<SVGSVGElement> & {
  size?: number | string;
};

function iconProps(size: IconProps['size'], props: SVGProps<SVGSVGElement>) {
  return {
    width: size,
    height: size,
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.8,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
    focusable: 'false' as const,
    ...props,
    className: ['quiz-ui-icon', props.className].filter(Boolean).join(' '),
  };
}

export function FolderOutlineIcon({ size = 42, ...props }: IconProps) {
  const id = useId();
  return (
    <svg {...iconProps(size, props)} data-library-artwork="folder" viewBox="0 0 64 64" stroke="none" aria-hidden={props['aria-hidden'] ?? true}>
      <defs>
        <linearGradient id={`${id}-back`} x2="0.7" y2="1"><stop stopColor="#81d0f5" /><stop offset="1" stopColor="#519be9" /></linearGradient>
        <linearGradient id={`${id}-front`} x2="1" y2="0.3"><stop stopColor="#6564cf" /><stop offset="1" stopColor="#6bbaf2" /></linearGradient>
      </defs>
      <path d="M5 17a5 5 0 0 1 5-5h15a5 5 0 0 1 5 5v1h24a5 5 0 0 1 5 5v27H5Z" fill={`url(#${id}-back)`} />
      <path d="m9 25 45-3 1 24-46 2Z" fill="#e7dfd1" />
      <path d="m12 28 42-7 3 27-45 3Z" fill="#fff" />
      <path d="M5 32a5 5 0 0 1 5-5h44a5 5 0 0 1 5 5v19a5 5 0 0 1-5 5H10a5 5 0 0 1-5-5Z" fill={`url(#${id}-front)`} />
      <path d="M10 28h44" stroke="#a3d6fc" strokeWidth=".8" opacity=".45" />
    </svg>
  );
}

/** Proposal 1: stacked quiz cards; kept distinct from PDF/file icons. */
export function ProblemSetIcon({ size = 34, ...props }: IconProps) {
  const id = useId();
  return <svg {...iconProps(size, props)} data-library-artwork="set" viewBox="0 0 64 64" stroke="none" aria-hidden={props['aria-hidden'] ?? true}>
    <defs>
      <linearGradient id={`${id}-stack`} x2=".6" y2="1"><stop stopColor="#78cbf5" /><stop offset="1" stopColor="#6674d6" /></linearGradient>
      <linearGradient id={`${id}-paper`} x2=".9" y2="1"><stop stopColor="#fff" /><stop offset="1" stopColor="#f0f5ff" /></linearGradient>
      <linearGradient id={`${id}-ink`} x2="1" y2="1"><stop stopColor="#487adf" /><stop offset="1" stopColor="#6758c8" /></linearGradient>
    </defs>
    <rect x="10" y="14" width="45" height="39" rx="5" transform="rotate(-5 32 33)" fill={`url(#${id}-stack)`} />
    <rect x="9" y="18" width="46" height="37" rx="5" fill="#90c9f5" />
    <g transform="rotate(7 29 35)">
      <rect x="5" y="19" width="47" height="35" rx="4" fill="#4460aa" opacity=".12" />
      <rect x="4" y="17" width="47" height="35" rx="4" fill={`url(#${id}-paper)`} stroke="#e5edf8" strokeWidth=".7" />
      <path d="M14 29c0-7 12-8 12-1 0 4-6 4-6 8" fill="none" stroke={`url(#${id}-ink)`} strokeWidth="4" strokeLinecap="round" />
      <circle cx="20" cy="43" r="2.3" fill="#6263d0" />
      <path d="M32 28h12M32 34h10M32 40h8" stroke="#c0d5f5" strokeWidth="2.4" strokeLinecap="round" />
    </g>
    <path d="m54 8 1-4m3 8 3-2m-1 7h3" stroke="#70a7ed" strokeWidth="2" strokeLinecap="round" />
  </svg>;
}

/** Filled quiz cards, without decorative sparkles or a wand. */
export function AiCreationIcon({ size = 40, ...props }: IconProps) {
  const id = useId();
  return <svg {...iconProps(size, props)} data-creation-artwork="ai-quiz" viewBox="0 0 64 64" stroke="none" aria-hidden={props['aria-hidden'] ?? true}>
    <defs><linearGradient id={`${id}-cards`} x2=".8" y2="1"><stop stopColor="#79c7f2"/><stop offset="1" stopColor="#536bca"/></linearGradient></defs>
    <rect x="15" y="7" width="43" height="43" rx="7" fill="#b7ddf7" transform="rotate(7 36 28)"/>
    <rect x="10" y="12" width="43" height="43" rx="7" fill={`url(#${id}-cards)`}/>
    <rect x="4" y="19" width="43" height="39" rx="6" fill="#f6faff" stroke="#91b6e4" strokeWidth="1.5"/>
    <path d="M15 32c0-7 13-7 13 0 0 5-7 5-7 10" fill="none" stroke="#466bb7" strokeWidth="4" strokeLinecap="round"/>
    <circle cx="21" cy="49" r="2.1" fill="#466bb7"/>
    <path d="M34 31h6M34 38h6M34 45h4" stroke="#a9c7e8" strokeWidth="3" strokeLinecap="round"/>
  </svg>;
}

/** A memo notebook with a quiz card in front. */
export function WeaknessMemoIcon({ size = 40, ...props }: IconProps) {
  const id = useId();
  return <svg {...iconProps(size, props)} data-creation-artwork="question-memo" viewBox="0 0 64 64" stroke="none" aria-hidden={props['aria-hidden'] ?? true}>
    <defs><linearGradient id={`${id}-memo`} x2=".8" y2="1"><stop stopColor="#79c7f2"/><stop offset="1" stopColor="#536bca"/></linearGradient></defs>
    <rect x="7" y="6" width="36" height="49" rx="6" fill={`url(#${id}-memo)`}/>
    <path d="M15 9h23a2 2 0 0 1 2 2v40H15Z" fill="#eff7ff"/>
    <path d="M5 17h9M5 29h9M5 41h9" stroke="#466bb7" strokeWidth="3" strokeLinecap="round"/>
    <path d="M21 18h12M21 25h9" stroke="#aac6e8" strokeWidth="3" strokeLinecap="round"/>
    <rect x="25" y="31" width="34" height="29" rx="5" fill="#3f5f9f" opacity=".12"/>
    <rect x="23" y="28" width="35" height="29" rx="5" fill="#fff" stroke="#91b6e4" strokeWidth="1.5"/>
    <path d="M32 38c0-5 9-5 9 0 0 3-4.5 3-4.5 7" fill="none" stroke="#466bb7" strokeWidth="3" strokeLinecap="round"/>
    <circle cx="36.5" cy="50" r="1.6" fill="#466bb7"/>
    <path d="M47 38h5M47 44h5" stroke="#a9c7e8" strokeWidth="2.5" strokeLinecap="round"/>
  </svg>;
}

/** An open reference book and a speech bubble for detailed explanations. */
export function MemoExplanationIcon({ size = 40, ...props }: IconProps) {
  const id = useId();
  return <svg {...iconProps(size, props)} data-creation-artwork="memo-explanation" viewBox="0 0 64 64" stroke="none" aria-hidden={props['aria-hidden'] ?? true}>
    <defs><linearGradient id={`${id}-book`} x2=".8" y2="1"><stop stopColor="#79c7f2"/><stop offset="1" stopColor="#536bca"/></linearGradient></defs>
    <path d="M4 24q14-5 27 2 14-7 28-2v32q-15-4-28 2-13-6-27-2Z" fill={`url(#${id}-book)`}/>
    <path d="M7 20q12-3 24 3v30q-12-6-24-3Z" fill="#f8fbff"/>
    <path d="M31 23q12-6 25-3v30q-13-3-25 3Z" fill="#e5f0fc"/>
    <path d="M31 24v29" stroke="#91b6e4" strokeWidth="1.5"/>
    <path d="m13 32 11 2m-11 5 11 2m14-7 11-2m-11 9 11-2" stroke="#a0bfe4" strokeWidth="2.5" strokeLinecap="round"/>
    <path d="M35 5h20a6 6 0 0 1 6 6v10a6 6 0 0 1-6 6H43l-8 6v-7a6 6 0 0 1-6-6v-9a6 6 0 0 1 6-6Z" fill={`url(#${id}-book)`} stroke="#fff" strokeWidth="1.5"/>
    <path d="M37 13h15M37 19h10" stroke="#fff" strokeWidth="2.5" strokeLinecap="round"/>
  </svg>;
}

export function DocumentOutlineIcon({ size = 34, ...props }: IconProps) {
  return (
    <svg {...iconProps(size, props)} aria-hidden={props['aria-hidden'] ?? true}>
      <path d="M8.5 2.75h7.1l3.15 3.2v11.8" fill="currentColor" opacity="0.08" />
      <path d="M8.5 2.75h7.1l3.15 3.2v11.8" opacity="0.52" />
      <path d="M5.25 5.75h7.1l4.4 4.4v10.1H5.25z" fill="currentColor" opacity="0.12" />
      <path d="M5.25 5.75h7.1l4.4 4.4v10.1H5.25z" />
      <path d="M12.25 5.75v4.75H17M8.25 14h5.25M8.25 17h4" opacity="0.68" />
    </svg>
  );
}

export function StudyIcon({ size = 24, ...props }: IconProps) {
  return (
    <svg {...iconProps(size, props)} aria-hidden={props['aria-hidden'] ?? true}>
      <path d="M5 4.25h6.8v15H5a2 2 0 0 1-2-2v-11a2 2 0 0 1 2-2Z" fill="currentColor" opacity="0.12" />
      <path d="M19 4.25h-7.2v15H19a2 2 0 0 0 2-2v-11a2 2 0 0 0-2-2Z" fill="currentColor" opacity="0.07" />
      <path d="M5 4.25h6.8v15H5a2 2 0 0 1-2-2v-11a2 2 0 0 1 2-2ZM19 4.25h-7.2v15H19a2 2 0 0 0 2-2v-11a2 2 0 0 0-2-2Z" />
      <path d="M7.25 8h2.4M14.25 8h3M14.25 11h3" opacity="0.58" />
    </svg>
  );
}

export function BookmarkIcon({ size = 24, ...props }: IconProps) {
  return (
    <svg {...iconProps(size, props)} aria-hidden={props['aria-hidden'] ?? true}>
      <path d="M6.25 3.5h11.5v17l-5.75-4-5.75 4Z" fill="currentColor" opacity="0.12" />
      <path d="M6.25 3.5h11.5v17l-5.75-4-5.75 4Z" />
      <path d="M9 7h6" opacity="0.5" />
    </svg>
  );
}

export function TagIcon({ size = 24, ...props }: IconProps) {
  return (
    <svg {...iconProps(size, props)} aria-hidden={props['aria-hidden'] ?? true}>
      <path d="M4 4.5h7.25L20 13.25 13.25 20 4.5 11.25Z" fill="currentColor" opacity="0.1" />
      <path d="M4 4.5h7.25L20 13.25 13.25 20 4.5 11.25Z" />
      <circle cx="8.25" cy="8.5" r="1.45" fill="currentColor" opacity="0.3" />
      <path d="m11.25 12.25 3.25 3.25" opacity="0.5" />
    </svg>
  );
}

export function ProgressIcon({ size = 24, ...props }: IconProps) {
  return (
    <svg {...iconProps(size, props)} aria-hidden={props['aria-hidden'] ?? true}>
      <path d="M4 19.5h16" />
      <path d="M6.25 19.5v-5h3v5M10.5 19.5v-8h3v8M14.75 19.5v-11h3v11" fill="currentColor" opacity="0.12" />
      <path d="M6.25 19.5v-5h3v5M10.5 19.5v-8h3v8M14.75 19.5v-11h3v11" />
      <path d="m5 10.5 4-3 3 1.5 6-5M15.5 4H18v2.5" />
    </svg>
  );
}

export function HistoryIcon({ size = 24, ...props }: IconProps) {
  return (
    <svg {...iconProps(size, props)} aria-hidden={props['aria-hidden'] ?? true}>
      <circle cx="12" cy="12" r="8.25" fill="currentColor" opacity="0.08" />
      <path d="M4.4 8.75A8.25 8.25 0 1 1 4 13M4.4 8.75H8M4.4 8.75V5.2" />
      <path d="M12 7.5v5l3.5 2" />
    </svg>
  );
}

export function ProfileIcon({ size = 24, ...props }: IconProps) {
  return (
    <svg {...iconProps(size, props)} aria-hidden={props['aria-hidden'] ?? true}>
      <circle cx="12" cy="12" r="9" fill="currentColor" opacity="0.08" />
      <circle cx="12" cy="9" r="3.1" fill="currentColor" opacity="0.16" />
      <circle cx="12" cy="9" r="3.1" />
      <path d="M6.4 18.4c.55-3.1 2.35-4.65 5.6-4.65s5.05 1.55 5.6 4.65" fill="currentColor" opacity="0.12" />
      <path d="M6.4 18.4c.55-3.1 2.35-4.65 5.6-4.65s5.05 1.55 5.6 4.65" />
    </svg>
  );
}

export function PlusIcon({ size = 24, ...props }: IconProps) {
  return (
    <svg {...iconProps(size, props)} aria-hidden={props['aria-hidden'] ?? true}>
      <path d="M12 5v14M5 12h14" />
    </svg>
  );
}

export function TrashIcon({ size = 22, ...props }: IconProps) {
  return (
    <svg {...iconProps(size, props)} aria-hidden={props['aria-hidden'] ?? true}>
      <path d="M5.5 7.25h13M9.25 4.5h5.5l.75 2.75H8.5zM7.5 7.25l.7 12.25h7.6l.7-12.25" />
      <path d="M10 10.25v6.5M14 10.25v6.5" />
    </svg>
  );
}

export function CheckIcon({ size = 22, ...props }: IconProps) {
  return (
    <svg {...iconProps(size, props)} aria-hidden={props['aria-hidden'] ?? true}>
      <path d="m5.5 12.25 4.1 4.1L18.75 7.5" />
    </svg>
  );
}

export function MenuIcon({ size = 23, ...props }: IconProps) {
  return (
    <svg {...iconProps(size, props)} aria-hidden={props['aria-hidden'] ?? true}>
      <path d="M4.5 7h15M4.5 12h15M4.5 17h15" />
    </svg>
  );
}

export function ChevronRightIcon({ size = 22, ...props }: IconProps) {
  return (
    <svg {...iconProps(size, props)} aria-hidden={props['aria-hidden'] ?? true}>
      <path d="m9 5 7 7-7 7" />
    </svg>
  );
}

export function ChevronDownIcon({ size = 22, ...props }: IconProps) {
  return (
    <svg {...iconProps(size, props)} aria-hidden={props['aria-hidden'] ?? true}>
      <path d="m5 9 7 7 7-7" />
    </svg>
  );
}

export function CopyIcon({ size = 22, ...props }: IconProps) {
  return (
    <svg {...iconProps(size, props)} aria-hidden={props['aria-hidden'] ?? true}>
      <rect x="8" y="8" width="11" height="11" rx="2" />
      <path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2" />
    </svg>
  );
}

export function DownloadIcon({ size = 22, ...props }: IconProps) {
  return (
    <svg {...iconProps(size, props)} aria-hidden={props['aria-hidden'] ?? true}>
      <path d="M12 4v10M8 10l4 4 4-4M5 19h14" />
    </svg>
  );
}

export function UploadIcon({ size = 22, ...props }: IconProps) {
  return (
    <svg {...iconProps(size, props)} aria-hidden={props['aria-hidden'] ?? true}>
      <path d="M12 15V5M8 9l4-4 4 4M5 19h14" />
    </svg>
  );
}

export function SyncIcon({ size = 22, ...props }: IconProps) {
  return (
    <svg {...iconProps(size, props)} aria-hidden={props['aria-hidden'] ?? true}>
      <path d="M19 7v4h-4M5 17v-4h4" />
      <path d="M18 11a6.5 6.5 0 0 0-11-3.5L5 10M6 13a6.5 6.5 0 0 0 11 3.5l2-2.5" />
    </svg>
  );
}

export function HomeIcon({ size = 24, ...props }: IconProps) {
  return (
    <svg {...iconProps(size, props)} aria-hidden={props['aria-hidden'] ?? true}>
      <path d="m3.75 10.5 8.25-7 8.25 7" />
      <path d="M5.75 9.1v10.15h12.5V9.1M9.5 19.25v-6h5v6" />
    </svg>
  );
}

export function SearchIcon({ size = 24, ...props }: IconProps) {
  return (
    <svg {...iconProps(size, props)} aria-hidden={props['aria-hidden'] ?? true}>
      <circle cx="10.75" cy="10.75" r="6.25" />
      <path d="m15.4 15.4 4.1 4.1" />
    </svg>
  );
}

export function GroupIcon({ size = 24, ...props }: IconProps) {
  return (
    <svg {...iconProps(size, props)} aria-hidden={props['aria-hidden'] ?? true}>
      <circle cx="9" cy="8.25" r="3.25" />
      <path d="M3.25 19c.35-3.25 2.2-5 5.75-5s5.4 1.75 5.75 5" />
      <path d="M15.25 5.65a3 3 0 0 1 0 5.2M16 14c2.9.25 4.4 1.9 4.75 4.5" />
    </svg>
  );
}

export function AddSquareIcon({ size = 24, ...props }: IconProps) {
  return (
    <svg {...iconProps(size, props)} aria-hidden={props['aria-hidden'] ?? true}>
      <rect x="3.75" y="3.75" width="16.5" height="16.5" rx="4" />
      <path d="M12 8v8M8 12h8" />
    </svg>
  );
}

export function SettingsIcon({ size = 24, ...props }: IconProps) {
  return (
    <svg {...iconProps(size, props)} aria-hidden={props['aria-hidden'] ?? true}>
      <circle cx="12" cy="12" r="3.25" fill="currentColor" opacity="0.15" />
      <circle cx="12" cy="12" r="3.25" />
      <path d="M19.1 13.7a7.9 7.9 0 0 0 0-3.4l1.55-1.2-1.8-3.1-1.85.75a7.5 7.5 0 0 0-2.9-1.7L13.8 3h-3.6l-.3 2.05A7.5 7.5 0 0 0 7 6.75L5.15 6l-1.8 3.1 1.55 1.2a7.9 7.9 0 0 0 0 3.4l-1.55 1.2 1.8 3.1L7 17.25a7.5 7.5 0 0 0 2.9 1.7l.3 2.05h3.6l.3-2.05a7.5 7.5 0 0 0 2.9-1.7l1.85.75 1.8-3.1z" />
    </svg>
  );
}

export function QuizMakeMarkIcon({ size = 28, ...props }: IconProps) {
  return (
    <svg {...iconProps(size, props)} strokeWidth={1.7} aria-hidden={props['aria-hidden'] ?? true}>
      <rect x="4.5" y="4.5" width="12.5" height="13" rx="3.1" />
      <path d="m14.1 14.1 4.6 4.4" />
      <path d="M8.6 12.4a3.1 3.1 0 1 0 6.2 0 3.1 3.1 0 0 0-6.2 0Z" />
    </svg>
  );
}
