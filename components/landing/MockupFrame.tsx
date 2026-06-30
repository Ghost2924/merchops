import type { ReactNode } from 'react';

interface MockupFrameProps {
  children: ReactNode;
  title?: string;
  className?: string;
}

export default function MockupFrame({ children, title, className = '' }: MockupFrameProps) {
  return (
    <div className={`relative w-full ${className}`}>
      <div className="relative rounded-xl border border-white/[0.08] bg-surface-card overflow-hidden">
        <div className="flex items-center gap-2 px-4 py-2.5 border-b border-white/[0.06] bg-surface-elevated/80">
          <div className="flex gap-1.5 shrink-0">
            <span className="w-2.5 h-2.5 rounded-full bg-accent-red/60" />
            <span className="w-2.5 h-2.5 rounded-full bg-accent-amber/60" />
            <span className="w-2.5 h-2.5 rounded-full bg-accent-emerald/60" />
          </div>
          {title && (
            <span className="flex-1 text-center text-[11px] text-text-muted font-medium pr-12">
              {title}
            </span>
          )}
        </div>
        <div className="p-4 sm:p-5 bg-surface">{children}</div>
      </div>
    </div>
  );
}
