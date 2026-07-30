// Plain stroked glyph (not the color emoji ­— clashes with the flat,
// monochrome Bloomberg-terminal look every other icon in the app uses, e.g.
// WatchButton's ★/☆) so it recolors via currentColor exactly like the rest
// of the UI's state-driven icon colors.
export default function BellIcon({ className = "h-4 w-4" }) {
  return (
    <svg viewBox="0 0 20 20" fill="none" xmlns="http://www.w3.org/2000/svg" className={className}>
      <path d="M5 11.5V8a5 5 0 0110 0v3.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
      <path d="M3.3 11.5h13.4" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
      <path d="M8.3 14.2a1.7 1.7 0 003.4 0" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  );
}
