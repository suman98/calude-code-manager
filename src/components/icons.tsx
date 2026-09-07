export function PanelLeftIcon() {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
      <rect x="1.5" y="2.5" width="13" height="11" rx="2" fill="none" stroke="currentColor" strokeWidth="1.3" />
      <path d="M6 2.8v10.4" stroke="currentColor" strokeWidth="1.3" />
      <rect x="2.4" y="3.4" width="3" height="9.2" rx="1" fill="currentColor" opacity="0.55" />
    </svg>
  );
}

export function PanelChatsIcon() {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
      <rect x="1.5" y="2.5" width="13" height="11" rx="2" fill="none" stroke="currentColor" strokeWidth="1.3" />
      <path d="M10 2.8v10.4" stroke="currentColor" strokeWidth="1.3" />
      <rect x="10.6" y="3.4" width="3" height="9.2" rx="1" fill="currentColor" opacity="0.55" />
    </svg>
  );
}

export function SearchIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 16 16" aria-hidden="true">
      <path
        fill="currentColor"
        d="M11.7 10.3a5.5 5.5 0 1 0-1.4 1.4l3 3a1 1 0 0 0 1.4-1.4zM3 6.5a3.5 3.5 0 1 1 7 0 3.5 3.5 0 0 1-7 0"
      />
    </svg>
  );
}

export function PlusIcon() {
  return (
    <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true">
      <path d="M8 3.5v9M3.5 8h9" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  );
}

export function FolderIcon() {
  return (
    <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true">
      <path
        d="M1.8 4.2c0-.7.5-1.2 1.2-1.2h2.6l1.4 1.6h5.2c.7 0 1.2.5 1.2 1.2v6c0 .7-.5 1.2-1.2 1.2H3c-.7 0-1.2-.5-1.2-1.2z"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinejoin="round"
      />
    </svg>
  );
}
