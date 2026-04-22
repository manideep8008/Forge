import { Component, type ErrorInfo, type ReactNode } from 'react';

interface ErrorBoundaryProps {
  children: ReactNode;
}

interface ErrorBoundaryState {
  hasError: boolean;
  error: Error | null;
}

export default class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = {
    hasError: false,
    error: null,
  };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    console.error('Unhandled React error', error, errorInfo);
  }

  private reset = () => {
    this.setState({ hasError: false, error: null });
  };

  render() {
    if (!this.state.hasError) {
      return this.props.children;
    }

    return (
      <div className="min-h-screen bg-forge-bg text-forge-text flex items-center justify-center p-6">
        <div className="w-full max-w-md bg-forge-surface border border-forge-border rounded-xl p-6">
          <h1 className="text-lg font-semibold">Something went wrong</h1>
          <p className="mt-2 text-sm text-forge-muted">
            Forge hit a render error. You can retry the view or reload the app.
          </p>
          {this.state.error?.message && (
            <p className="mt-4 rounded-lg border border-forge-border bg-forge-bg p-3 text-xs text-red-300">
              {this.state.error.message}
            </p>
          )}
          <div className="mt-5 flex gap-2">
            <button type="button" onClick={this.reset} className="btn-primary text-sm">
              Try again
            </button>
            <button
              type="button"
              onClick={() => window.location.reload()}
              className="px-4 py-2.5 rounded-xl text-sm text-forge-muted hover:bg-white/5 hover:text-forge-text transition-colors"
            >
              Reload
            </button>
          </div>
        </div>
      </div>
    );
  }
}
