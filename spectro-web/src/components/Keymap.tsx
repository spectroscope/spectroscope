// The keymap overlay (edu port) — a game-style shortcut sheet. Each row pairs a
// keycap with a small SVG "infographic" icon of what the key does, grouped by
// context. Opened with `?` (or the header's keymap button), closed with Esc / the
// × / a backdrop click. Bilingual, tokens only, no shadows (the keycap reads
// physical via a thick bottom border, not a drop shadow). The rows document the
// Lab's REAL shortcuts, wired in LabTransport.

import type { JSX } from "react";
import { useLang } from "../state/lang";

type Loc = { en: string; de: string };
export type IconName = "step" | "back" | "play" | "reset" | "home" | "jsonl" | "trace" | "flip" | "keys" | "close";
interface Row {
  keys: string[];
  icon: IconName;
  label: Loc;
}
interface Group {
  title: Loc;
  rows: Row[];
}

const S = { width: 22, height: 22, viewBox: "0 0 22 22", fill: "none", stroke: "currentColor", strokeWidth: 1.6, strokeLinecap: "round" as const, strokeLinejoin: "round" as const };
export const ICON: Record<IconName, JSX.Element> = {
  step: (<svg {...S}><line x1="4" y1="5" x2="4" y2="17" /><path d="M9 6l6 5-6 5z" /></svg>),
  back: (<svg {...S}><line x1="18" y1="5" x2="18" y2="17" /><path d="M13 6l-6 5 6 5z" /></svg>),
  play: (<svg {...S}><path d="M6 4l12 7-12 7z" /></svg>),
  reset: (<svg {...S}><path d="M4 11a7 7 0 1 0 2-4.9" /><path d="M5 3v4h4" /></svg>),
  home: (<svg {...S}><path d="M3 10l8-6 8 6" /><path d="M5 9v9h12V9" /><line x1="9" y1="18" x2="9" y2="13" /><line x1="13" y1="18" x2="13" y2="13" /></svg>),
  jsonl: (<svg {...S}><rect x="4" y="3" width="14" height="16" rx="2" /><line x1="7" y1="7" x2="15" y2="7" /><line x1="7" y1="11" x2="15" y2="11" /><line x1="7" y1="15" x2="12" y2="15" /></svg>),
  trace: (<svg {...S}><circle cx="6" cy="6" r="2" /><circle cx="6" cy="16" r="2" /><circle cx="16" cy="11" r="2" /><path d="M8 6h3a3 3 0 0 1 3 3M8 16h3a3 3 0 0 0 3-3" /></svg>),
  flip: (<svg {...S}><path d="M4 8h12l-3-3M18 14H6l3 3" /></svg>),
  keys: (<svg {...S}><rect x="3" y="6" width="16" height="10" rx="2" /><line x1="7" y1="9" x2="7" y2="9" /><line x1="11" y1="9" x2="11" y2="9" /><line x1="15" y1="9" x2="15" y2="9" /><line x1="7" y1="13" x2="15" y2="13" /></svg>),
  close: (<svg {...S}><line x1="6" y1="6" x2="16" y2="16" /><line x1="16" y1="6" x2="6" y2="16" /></svg>),
};

// spectro-web's real shortcuts: the Lab transport keys (see LabTransport) plus
// the overlay's own open/close. The edu lesson group is dropped (no lessons here).
const GROUPS: Group[] = [
  {
    title: { en: "navigation", de: "navigation" },
    rows: [
      { keys: ["?"], icon: "keys", label: { en: "this keymap", de: "diese keymap" } },
      { keys: ["esc"], icon: "close", label: { en: "close", de: "schließen" } },
    ],
  },
  {
    title: { en: "the lab", de: "das lab" },
    rows: [
      { keys: ["space", "→"], icon: "step", label: { en: "step forward", de: "schritt vor" } },
      { keys: ["←"], icon: "back", label: { en: "step back", de: "schritt zurück" } },
      { keys: ["f"], icon: "play", label: { en: "flow: auto-play", de: "flow: auto-play" } },
      { keys: ["r"], icon: "reset", label: { en: "reset to the start", de: "zurück zum start" } },
    ],
  },
];

export function Keymap(props: { open: boolean; onClose: () => void }) {
  const lang = useLang();
  if (!props.open) return null;
  return (
    <div className="km-backdrop" onClick={props.onClose} role="presentation">
      <div
        className="km-panel"
        role="dialog"
        aria-modal="true"
        aria-label={lang === "de" ? "Tastaturkürzel" : "keyboard shortcuts"}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="km-head">
          <span className="km-title">
            <span className="km-title-ico">{ICON.keys}</span>
            {lang === "de" ? "tastenbelegung" : "keymap"}
          </span>
          <button type="button" className="km-close" onClick={props.onClose} aria-label={lang === "de" ? "schließen" : "close"}>
            ×
          </button>
        </div>
        <div className="km-groups">
          {GROUPS.map((g) => (
            <div key={g.title.en} className="km-group">
              <p className="km-group-title">{g.title[lang]}</p>
              <ul className="km-rows">
                {g.rows.map((r) => (
                  <li key={r.label.en} className="km-row">
                    <span className="km-ico">{ICON[r.icon]}</span>
                    <span className="km-keys">
                      {r.keys.map((k, i) => (
                        <kbd key={i} className="km-key">{k}</kbd>
                      ))}
                    </span>
                    <span className="km-label">{r.label[lang]}</span>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
        <p className="km-foot">
          {lang === "de"
            ? "kürzel pausieren, während du in ein feld tippst."
            : "shortcuts pause while you type in a field."}
        </p>
      </div>
    </div>
  );
}
