import type { ReactNode } from 'react';

interface LayoutProps {
  children: ReactNode;
}

export function Layout({ children }: LayoutProps) {
  return (
    <div className="h-dvh w-full overflow-hidden bg-[#FFFFFF] text-[#172033]">
      <div className="app-layout__scroll mx-auto flex h-full w-full flex-col overflow-x-hidden overflow-y-auto overscroll-y-contain bg-[#FFFFFF]">
        {children}
      </div>
    </div>
  );
}
