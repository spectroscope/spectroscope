// Card 430, review of criterion 9: the place a lazy view is drawn. While the
// view's chunk loads, the place stays empty (a Suspense with no fallback). When
// the chunk does not arrive, a notice with a reload stands there instead, and
// the rest of the window keeps working; without a boundary React unmounts the
// whole root. Any other error is thrown on up, as it was before.

import { Component, Suspense, type ReactNode } from "react";
import { t } from "../i18n/i18n";
import { useLang } from "../state/lang";
import { ChunkLoadError } from "../state/surfaceChunks";

interface Props {
  children: ReactNode;
  /** Names the view inside; a change clears a failure, so the next view gets its own try. */
  resetKey?: string;
  /** What the notice's button does; the window's reload unless a test hands one in. */
  reload?: () => void;
}

interface State {
  /** What was thrown below, boxed so that even a thrown null counts. */
  failure: { error: unknown } | null;
  resetKey?: string;
}

export class ChunkBoundary extends Component<Props, State> {
  state: State = { failure: null, resetKey: this.props.resetKey };

  static getDerivedStateFromError(error: unknown): Pick<State, "failure"> {
    return { failure: { error } };
  }

  static getDerivedStateFromProps(props: Props, state: State): Partial<State> | null {
    return props.resetKey === state.resetKey ? null : { failure: null, resetKey: props.resetKey };
  }

  render(): ReactNode {
    const { failure } = this.state;
    if (failure === null) return <Suspense fallback={null}>{this.props.children}</Suspense>;
    if (!(failure.error instanceof ChunkLoadError)) throw failure.error;
    return <ChunkFailed reload={this.props.reload} />;
  }
}

/** The notice in place of a view whose chunk did not load. */
export function ChunkFailed({ reload = () => window.location.reload() }: { reload?: () => void }): ReactNode {
  const lang = useLang();
  return (
    <p className="view-notice" role="alert">
      {t(lang, "chunk.failed")}{" "}
      <button type="button" className="ghost" onClick={reload}>
        {t(lang, "chunk.reload")}
      </button>
    </p>
  );
}
