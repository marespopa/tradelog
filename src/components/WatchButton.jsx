// Star toggle used in both the scan table and the analysis header. Stops
// propagation so clicking it inside a clickable table row doesn't also
// trigger the row's own onClick (navigating to analysis).
export default function WatchButton({ active, onToggle, className = "" }) {
  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        onToggle();
      }}
      aria-label={active ? "Remove from watchlist" : "Add to watchlist"}
      title={active ? "Remove from watchlist" : "Add to watchlist"}
      className={`text-[16px] leading-none transition-transform duration-150 hover:scale-110 ${active ? "text-amber-400" : "text-dim/40 hover:text-dim"} ${className}`}
    >
      {active ? "★" : "☆"}
    </button>
  );
}
