// A render error in a panel must not blank the whole window: React unmounts the entire tree when nothing catches it.
import { Component, type ReactNode } from "react";

interface State {
  failed: string | null;
}

export class Boundary extends Component<{ label: string; children: ReactNode }, State> {
  override state: State = { failed: null };

  static getDerivedStateFromError(error: unknown): State {
    return { failed: error instanceof Error ? error.message : String(error) };
  }

  override componentDidCatch(error: unknown): void {
    console.error(`${this.props.label} failed to draw`, error);
  }

  override render(): ReactNode {
    if (this.state.failed === null) return this.props.children;
    return (
      <div className="empty-note" role="alert">
        {this.props.label} hit an error and was stopped: {this.state.failed}
        <div><button className="button" onClick={() => this.setState({ failed: null })}>Try again</button></div>
      </div>
    );
  }
}
