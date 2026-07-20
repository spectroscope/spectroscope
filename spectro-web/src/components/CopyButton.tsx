// The copy affordance shared by the trace detail and the graph event panel —
// the same pattern as the ToolCard output copy: a quiet chip that reads
// "Copied" for 1.4 s. The text is produced lazily so large payloads are only
// stringified on click.

import { useState } from "react";
import { t } from "../i18n/i18n";
import { useLang } from "../state/lang";

export function CopyButton(props: { text: () => string; label?: string }) {
  const [copied, setCopied] = useState(false);
  const lang = useLang();

  const copy = (): void => {
    void navigator.clipboard.writeText(props.text()).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1400);
    });
  };

  return (
    <button type="button" className="copy" onClick={copy}>
      {copied ? t(lang, "common.copied") : (props.label ?? t(lang, "common.copy"))}
    </button>
  );
}
