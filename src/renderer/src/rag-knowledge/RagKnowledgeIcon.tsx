export function RagKnowledgeIcon({ className }: { className?: string }): JSX.Element {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <rect x="3.5" y="3.5" width="6.5" height="6.5" rx="1.3" />
      <rect x="14" y="3.5" width="6.5" height="6.5" rx="1.3" />
      <rect x="3.5" y="14" width="6.5" height="6.5" rx="1.3" />
      <path d="M17.25 13.8v6.9M13.8 17.25h6.9" />
    </svg>
  );
}
