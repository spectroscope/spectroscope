// Back and forward (card 179), in the header left of the mode switch since
// card 514: the same place in every mode and on every screen. The desktop shell
// draws no URL bar, so these are the only way back there. A button is dark when
// there is nothing there: the app stamps and counts every entry it writes,
// because the DOM reports no forward availability.

import { t, type Lang } from "../i18n/i18n";

export function NavSteps(props: { lang: Lang; canBack: boolean; canForward: boolean }) {
  return (
    <span className="nav-steps">
      <button
        type="button"
        className="nav-steps__step"
        disabled={!props.canBack}
        onClick={() => window.history.back()}
        title={t(props.lang, "nav.back")}
        aria-label={t(props.lang, "nav.back")}
      >
        <svg
          viewBox="0 0 16 16"
          width="13"
          height="13"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.6"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <path d="M10 3.5 5.5 8l4.5 4.5" />
        </svg>
      </button>
      <button
        type="button"
        className="nav-steps__step"
        disabled={!props.canForward}
        onClick={() => window.history.forward()}
        title={t(props.lang, "nav.forward")}
        aria-label={t(props.lang, "nav.forward")}
      >
        <svg
          viewBox="0 0 16 16"
          width="13"
          height="13"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.6"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <path d="M6 3.5 10.5 8 6 12.5" />
        </svg>
      </button>
    </span>
  );
}
