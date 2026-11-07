import { useDeviceRole } from '../hooks/useDeviceRole';
import { PlusIcon, GroupIcon, HomeIcon, SearchIcon, SettingsIcon } from './UiIcons';
import './PrimaryBottomNav.css';

export type PrimaryNavItem = 'home' | 'discover' | 'groups' | 'create' | 'settings';

interface PrimaryBottomNavProps {
  active: PrimaryNavItem;
  onSelect: (item: PrimaryNavItem) => void;
}

const items: Array<{
  id: PrimaryNavItem;
  label: string;
  shortLabel?: string;
  icon: typeof HomeIcon;
}> = [
  { id: 'home', label: 'ホーム', icon: HomeIcon },
  { id: 'discover', label: '見つける', icon: SearchIcon },
  { id: 'create', label: '作成', icon: PlusIcon },
  { id: 'groups', label: 'グループ', icon: GroupIcon },
  { id: 'settings', label: '設定', icon: SettingsIcon },
];

export function PrimaryBottomNav({ active, onSelect }: PrimaryBottomNavProps) {
  const role = useDeviceRole();
  const visibleItems = items.filter(item => role === 'main' || item.id !== 'create');
  return (
    <nav className="primary-bottom-nav" aria-label="メインメニュー">
      <div className="primary-bottom-nav__inner" style={{ gridTemplateColumns: `repeat(${visibleItems.length}, 1fr)` }}>
        <div
          className="primary-bottom-nav__indicator"
          aria-hidden="true"
          style={{ width: `calc((100% - 2 * var(--nav-inline-padding)) / ${visibleItems.length})`, transform: `translateX(${visibleItems.findIndex((item) => item.id === active) * 100}%)` }}
        ><span /></div>
        {visibleItems.map((item) => {
          const Icon = item.icon;
          const selected = item.id === active;
          return (
            <button
              key={item.id}
              type="button"
              data-destination={item.id}
              className={selected ? 'primary-bottom-nav__item primary-bottom-nav__item--active' : 'primary-bottom-nav__item'}
              aria-current={selected ? 'page' : undefined}
              aria-label={item.label}
              onClick={() => onSelect(item.id)}
            >
              <Icon size={24} />
              <span>{item.shortLabel ?? item.label}</span>
            </button>
          );
        })}
      </div>
    </nav>
  );
}
