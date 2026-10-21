/** SentinelPay shield mark (own artwork; PayPal palette only, no PayPal marks). */
export function Logo({ size = 36 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" aria-hidden="true">
      <rect width="64" height="64" rx="14" fill="#0070e0" />
      <path d="M32 11l16 6v13c0 10-6.5 18.5-16 22-9.5-3.5-16-12-16-22V17z" fill="#fff" />
      <path d="M24 31.5l6 6 11-12" fill="none" stroke="#003087" strokeWidth="4.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
