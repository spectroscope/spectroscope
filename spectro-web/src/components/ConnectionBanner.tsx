// Narrow warn bar under the header while the socket is down — with the
// automatic-retry countdown and a manual reconnect link. Extracted from
// App.tsx verbatim (clean-code night job).

import { useEffect, useState } from "react";
import type { ConnectionStatus } from "../transport/ws";
import { t } from "../i18n/i18n";
import { useLang } from "../state/lang";

export function ConnectionBanner(props: {
  status: ConnectionStatus;
  retryAt: number | null;
  onRetry: () => void;
}) {
  const [now, setNow] = useState(() => Date.now());
  const lang = useLang();
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 500);
    return () => window.clearInterval(timer);
  }, []);

  const seconds =
    props.retryAt !== null ? Math.max(0, Math.ceil((props.retryAt - now) / 1000)) : null;

  return (
    <div className="conn-banner" role="status">
      <span className="dot warn" aria-hidden="true" />
      {props.status === "connecting" ? (
        <span>{t(lang, "conn.connecting")}</span>
      ) : (
        <>
          <span>
            {t(lang, "conn.lost")}
            {seconds !== null && <span className="tabular"> &middot; {t(lang, "conn.retryIn", { s: seconds })}</span>}
          </span>
          <button type="button" className="link" onClick={props.onRetry}>
            {t(lang, "conn.retryNow")}
          </button>
        </>
      )}
    </div>
  );
}
