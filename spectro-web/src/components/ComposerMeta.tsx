// Card 463 (owner, 2026-09-29): the right end of the row under the composer.
// The model, the thinking level and the context ring, the ring last, each with
// its own menu; before this card the model and the ring sat in the header and
// the thinking level inside the model's menu.
//
// Every menu here opens upward and hangs from the row's right end: the anchors
// in this block are static, so `.composer-actions` (position: relative) is the
// frame, the way the microphone and gear menus already hang from it.

import { useEffect, useRef, useState } from "react";
import type { ConnectionStatus } from "../transport/ws";
import type { UiState } from "../state/reducer";
import type { Lang } from "../i18n/i18n";
import { t } from "../i18n/i18n";
import { useLang } from "../state/lang";
import { cellClick, segCells, setReasoningChoice, useReasoningChoice } from "../state/reasoning";
import type { SegCell } from "../state/reasoning";
import { ContextRing } from "./ContextRing";
import { nextMenuIndex } from "../panels/headerPanelControls";
import { ProviderPicker } from "./ProviderPicker";
import { cellLabel, cellTitle, useReasoningCapability } from "./ReasoningControl";

/** Shown as the provider until a real provider name is known. */
const FALLBACK_PROVIDER_LABEL = "spectroscope";

/**
 * The thinking level a chip names: the pressed cell, translated where it is a
 * word (on, off) and as the wire says it where it is an effort (low, high).
 *
 * @returns the label, or null when the model offers no control at all
 */
export function thinkingLabel(lang: Lang, cells: readonly SegCell[]): string | null {
  const pressed = cells.find((cell) => cell.pressed);
  if (cells.length === 0) return null;
  if (pressed === undefined) return t(lang, "cm.default");
  if (pressed.kind === "on") return t(lang, "rc.on");
  if (pressed.kind === "off") return t(lang, "rc.off");
  return pressed.id;
}

/**
 * What the ring may do with the window of this session (card 390): set and
 * clear it in the live view, nothing in a replay. A replay reads a recorded
 * session, and a set pressed there would go to whatever socket is live.
 *
 * @param liveView whether the composer belongs to the live session
 * @param handler  the live session's set-or-clear
 * @returns the handler in the live view, undefined in a replay
 */
export function ringWindowOverride(
  liveView: boolean,
  handler: ((tokens: number | null) => void) | undefined,
): ((tokens: number | null) => void) | undefined {
  return liveView ? handler : undefined;
}

/**
 * The levels as a list, one row each, the pressed one checked; the cells and
 * their rules come from state/reasoning.ts, the brain the settings control uses.
 */
export function ThinkingMenu(props: {
  lang: Lang;
  cells: readonly SegCell[];
  /** Whether the levels run from faster to smarter (an effort control). */
  showEnds: boolean;
  onPick: (cell: SegCell) => void;
}) {
  return (
    <div
      className="thinking-list"
      role="menu"
      onKeyDown={(e) => {
        const rows = [...e.currentTarget.querySelectorAll<HTMLButtonElement>(".thinking-row:not(:disabled)")];
        const at = rows.indexOf(document.activeElement as HTMLButtonElement);
        const next = nextMenuIndex(at < 0 ? 0 : at, e.key, rows.length);
        if (next !== at && ["ArrowDown", "ArrowUp", "Home", "End"].includes(e.key)) {
          e.preventDefault();
          rows[next]?.focus();
        }
      }}
    >
      {props.cells.map((cell) => (
        <button
          key={cell.id}
          type="button"
          role="menuitemradio"
          aria-checked={cell.pressed}
          disabled={cell.disabled}
          title={cellTitle(props.lang, cell, cell.pressed)}
          className="thinking-row"
          onClick={() => props.onPick(cell)}
        >
          <span className="thinking-row-label mono">{cellLabel(props.lang, cell)}</span>
          <span className="thinking-row-check" aria-hidden="true">
            {cell.pressed ? "✓" : ""}
          </span>
        </button>
      ))}
      {props.showEnds && (
        <span className="thinking-pop-ends" aria-hidden="true">
          <span>{t(props.lang, "cm.faster")}</span>
          <span>{t(props.lang, "cm.smarter")}</span>
        </span>
      )}
    </div>
  );
}

/** The thinking chip and its menu. Draws nothing for a model without a control. */
function ThinkingPicker({ provider, model }: { provider: string; model: string }) {
  const lang = useLang();
  const cap = useReasoningCapability(provider, model);
  const choice = useReasoningChoice(provider, model);
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const chip = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent): void => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") {
        setOpen(false);
        chip.current?.focus();
      }
    };
    // The pressed level takes the focus, else the first one that can act.
    const rows = ref.current?.querySelectorAll<HTMLButtonElement>(".thinking-row:not(:disabled)");
    (
      ref.current?.querySelector<HTMLButtonElement>('.thinking-row[aria-checked="true"]') ?? rows?.[0]
    )?.focus();
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  if (cap === null || cap.control === "none") return null;
  const cells = segCells(cap, choice);
  const label = thinkingLabel(lang, cells);
  if (label === null) return null;

  return (
    <div className="thinking-picker" ref={ref}>
      <button
        ref={chip}
        type="button"
        className="thinking-chip mono"
        aria-haspopup="dialog"
        aria-expanded={open}
        title={t(lang, "rc.aria")}
        onClick={() => setOpen((was) => !was)}
      >
        <span className="thinking-chip-name">{t(lang, "rc.label")}</span>
        <span className="thinking-chip-level">{label}</span>
        <svg viewBox="0 0 12 12" width="10" height="10" aria-hidden="true" className="provider-caret">
          <path
            d="M3 7.5 L6 4.5 L9 7.5"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.4"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </button>
      {open && (
        <div className="thinking-pop" role="dialog" aria-label={t(lang, "rc.aria")}>
          <span className="thinking-pop-title">{t(lang, "cm.thinkingTitle")}</span>
          <ThinkingMenu
            lang={lang}
            cells={cells}
            showEnds={cap.control === "effort"}
            onPick={(cell) => setReasoningChoice(provider, model, cellClick(cap, choice, cell.id))}
          />
        </div>
      )}
    </div>
  );
}

export function ComposerMeta(props: {
  provider?: string;
  model?: string;
  status: ConnectionStatus;
  /** Per-provider onboarding status from /api/config, forwarded to the picker. */
  providerStatus?: Record<string, string>;
  /** Card 193: per-provider addresses from /api/config, forwarded to the picker. */
  providerAddress?: Record<string, string>;
  onApplyProvider: (provider: string, model: string) => void;
  /** Opens the settings page from the picker's key hint. */
  onOpenSettings?: () => void;
  /** Whether the composer belongs to the live session (the ring's set/clear). */
  liveView: boolean;
  /** Context gauge: appears with the first usage event of the view. */
  lastInputTokens: number;
  context: UiState["context"];
  onWindowOverride?: (tokens: number | null) => void;
}) {
  const provider = props.provider ?? FALLBACK_PROVIDER_LABEL;
  const model = props.model ?? "";
  return (
    <div className="composer-meta">
      {props.liveView ? (
        <ProviderPicker
          provider={provider}
          model={model}
          status={props.status}
          providerStatus={props.providerStatus}
          providerAddress={props.providerAddress}
          onApply={props.onApplyProvider}
          onOpenSettings={props.onOpenSettings}
        />
      ) : (
        // A recorded session names what ran it and offers no switch: a switch
        // pressed here would go to whatever socket is live (the header drew
        // the same static chip before card 463).
        <span className="provider-chip">
          <span className="mono">{provider}</span>
          {model !== "" && <span className="provider-chip-model mono">{model}</span>}
        </span>
      )}
      {props.liveView && model !== "" && <ThinkingPicker provider={provider} model={model} />}
      {props.lastInputTokens > 0 && (
        <ContextRing
          lastInputTokens={props.lastInputTokens}
          context={props.context}
          onWindowOverride={ringWindowOverride(props.liveView, props.onWindowOverride)}
        />
      )}
    </div>
  );
}
