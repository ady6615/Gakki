import { Component, type ErrorInfo, type ReactNode } from 'react';

interface Props {
  children: ReactNode;
  fallbackTitle?: string;
  onReset?: () => void;
}

interface State {
  hasError: boolean;
  error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
  public state: State = {
    hasError: false,
    error: null,
  };

  public static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  public componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    console.error('Unhandled UI exception in ErrorBoundary:', error, errorInfo);
  }

  private handleRetry = () => {
    this.setState({ hasError: false, error: null });
    if (this.props.onReset) {
      this.props.onReset();
    }
  };

  public render() {
    if (this.state.hasError) {
      return (
        <div className="error-boundary-fallback glass-panel" style={{
          padding: '24px',
          margin: '12px 0',
          borderRadius: '12px',
          background: 'rgba(30, 20, 25, 0.85)',
          border: '1px solid rgba(239, 68, 68, 0.3)',
          color: '#f87171',
          textAlign: 'center',
        }}>
          <h3 style={{ margin: '0 0 8px 0', fontSize: '1.1rem', fontWeight: 600 }}>
            ⚠️ {this.props.fallbackTitle || 'Component Error'}
          </h3>
          <p style={{ margin: '0 0 16px 0', fontSize: '0.875rem', color: '#cbd5e1' }}>
            {this.state.error?.message || 'An unexpected rendering error occurred in this section.'}
          </p>
          <button
            onClick={this.handleRetry}
            style={{
              padding: '8px 16px',
              borderRadius: '8px',
              border: 'none',
              background: '#ef4444',
              color: '#ffffff',
              fontWeight: 500,
              cursor: 'pointer',
              fontSize: '0.85rem',
            }}
          >
            🔄 Try Again
          </button>
        </div>
      );
    }

    return this.props.children;
  }
}
