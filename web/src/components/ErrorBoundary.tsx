// One part of the page (the plan, the sheet) that hit an error while rendering: it shows "This part of the page hit an
// error: <message>" with "Try again", and the rest of the page stays. "Try again" renders the part again, and so does a
// new `resetKey` (a new plan run, a new sheet).

import { Component, type ReactNode } from 'react';
import { errorMessage } from '../api';

interface Props { children: ReactNode; resetKey?: unknown }
/** `failed` and not `error`, since anything can be thrown, `undefined` too. */
interface State { failed: boolean; error: unknown; resetKey: unknown }

export class ErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { failed: false, error: undefined, resetKey: props.resetKey };
  }

  static getDerivedStateFromError(error: unknown): Partial<State> {
    return { failed: true, error };
  }

  static getDerivedStateFromProps(props: Props, state: State): Partial<State> | null {
    return Object.is(props.resetKey, state.resetKey) ? null : { failed: false, error: undefined, resetKey: props.resetKey };
  }

  private readonly retry = (): void => {
    this.setState({ failed: false, error: undefined });
  };

  render(): ReactNode {
    if (!this.state.failed) return this.props.children;
    return (
      <div className="banner banner-danger" role="alert">
        <p><strong>This part of the page hit an error:</strong> {errorMessage(this.state.error)}</p>
        <button type="button" className="button" onClick={this.retry}>Try again</button>
      </div>
    );
  }
}
