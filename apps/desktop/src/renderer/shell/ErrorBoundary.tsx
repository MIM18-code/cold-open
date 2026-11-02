// Keeps one failing view or panel from blanking the window: it shows what broke and offers a retry, and the
// rest of the app (and the document) keeps working.
import { Component, type ReactNode } from "react";

interface Props {
  name: string;
  children: ReactNode;
}

export class ErrorBoundary extends Component<Props, { error: Error | null }> {
  state = { error: null as Error | null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error) {
    console.error(`${this.props.name} failed`, error);
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="error-boundary" role="alert">
        <strong>{this.props.name} stopped working.</strong>
        <p>{this.state.error.message}</p>
        <button className="button" onClick={() => this.setState({ error: null })}>Try again</button>
      </div>
    );
  }
}
