/** The console's mark (dashboard/src/components/shell/Brand.tsx): a breaker plate with its handle up. */
export function BrandMark({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <rect x="3.75" y="2.75" width="16.5" height="18.5" rx="2.25" stroke="currentColor" strokeWidth="1.5" />
      <rect x="9" y="5.5" width="6" height="8" rx="1" fill="currentColor" />
      <path d="M8 17.5h8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}
