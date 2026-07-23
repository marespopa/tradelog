import { Component } from "react";

// Catches render/effect-phase exceptions anywhere below it so a bug in one
// panel (e.g. a bad chart payload) shows a recoverable error page instead of
// silently unmounting the whole app to a blank screen.
export default class ErrorBoundary extends Component {
  state = { error: null };

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error, info) {
    console.error("Uncaught render error:", error, info.componentStack);
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;

    return (
      <div className="flex min-h-full items-center justify-center bg-bg p-7 text-ink">
        <div className="w-full max-w-[560px] rounded-card border border-edge bg-panel p-6 shadow-card">
          <h1 className="mb-1.5 text-[17px] font-semibold">Something went wrong</h1>
          <p className="mb-4 text-[13px] text-dim">
            The page hit an unexpected error and couldn't continue rendering.
          </p>
          <details className="mb-4 rounded-lg bg-panel-alt p-3 text-[12px] text-dim">
            <summary className="cursor-pointer select-none font-medium text-ink">{error.message}</summary>
            <pre className="mt-2 overflow-auto whitespace-pre-wrap break-words">{error.stack}</pre>
          </details>
          <button
            type="button"
            onClick={() => window.location.reload()}
            className="rounded-lg bg-panel-alt px-4 py-1.5 text-[13px] font-medium text-ink transition-all duration-150 hover:bg-panel-raised hover:shadow-sm active:scale-95"
          >
            Reload
          </button>
        </div>
      </div>
    );
  }
}
