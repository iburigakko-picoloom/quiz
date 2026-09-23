import { forwardRef, useEffect, useImperativeHandle, useRef, type ReactNode } from 'react';
import './ActionMenu.css';

/** An action menu, not an accordion: outside taps, Tab out and Escape dismiss it. */
export const ActionMenu = forwardRef<HTMLDetailsElement, { className: string; children: ReactNode }>(function ActionMenu({ className, children }, ref) {
  const menu = useRef<HTMLDetailsElement>(null);
  useImperativeHandle(ref, () => menu.current!, []);

  useEffect(() => {
    const element = menu.current;
    if (!element) return;
    const outside = (event: Event) => {
      if (element.open && event.target instanceof Node && !element.contains(event.target)) element.open = false;
    };
    document.addEventListener('pointerdown', outside);
    return () => {
      document.removeEventListener('pointerdown', outside);
    };
  }, []);

  return <details ref={menu} className={`action-menu ${className}`}
    onBlur={(event) => {
      if (!(event.relatedTarget instanceof Node) || !event.currentTarget.contains(event.relatedTarget)) event.currentTarget.open = false;
    }}
    onKeyDown={(event) => {
      if (event.key !== 'Escape' || !event.currentTarget.open) return;
      event.preventDefault();
      event.stopPropagation();
      event.currentTarget.open = false;
      event.currentTarget.querySelector('summary')?.focus();
    }}
    onClick={(event) => {
      if (event.target instanceof Element && event.target.closest('button:not(:disabled)')) event.currentTarget.open = false;
    }}>{children}</details>;
});
