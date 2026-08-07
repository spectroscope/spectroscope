// The Spectrum tab — the fleet on one screen. One horizontal lane per agent
// (the brand image: every agent is a spectral line), every event a discrete
// mark. The rail opens the whole agent in Trace; the band is a scrubber — hover
// an event for its type + a mini preview, click to open THAT event in Trace.
// Pure presentation: the folding lives in spectrumModel.ts, live and replay
// render through the same path.

import { useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { RunEvent } from "../events";
import { formatDuration, formatTokens } from "../format";
import { t } from "../i18n/i18n";
import { useLang } from "../state/lang";
import { ThinkingDisclosure } from "../components/ThinkingDisclosure";
import { buildSpectrum } from "./spectrumModel";
import type { Lane, LaneTick, TickKind } from "./spectrumModel";
import { BAND_W, SpectrumBand, TICK_COLOR } from "./SpectrumBand";
import { SpectrumAxis } from "./SpectrumAxis";
import { SpectrumStrip } from "./SpectrumStrip";
import { sliceLane } from "./laneSlice";
import {
  incomingGeneration,
  reportView,
  subscribeReportedViews,
  takeIncomingView,
} from "../state/viewReport";

import { applyIntent, buttonToIntent, zoomEnabled, type ZoomButton } from "./gestures";
import { fit, isWhole, minWidthFor, rebase, storeWindow, type Window } from "./viewport";
import { FleetRoster } from "./FleetRoster";
import type { FleetNode } from "./fleetModel";
import { useEffect } from "react";
import { beacon } from "../state/levelingBeacon";

/** The legend mirrors the wire vocabulary — protocol terms, not translated. */
const LEGEND: TickKind[] = ["token", "reasoning", "tool", "gate", "subagent", "lifecycle"];

/** The whole domain: what a view with no window of its own is looking at. */
const FULL = fit();

/** The zoom floor, as a duration. One second of wall clock is the finest slice
 *  this view will open, whatever the stream spans. Fixed rather than derived
 *  from the content, so the limit cannot move under the reader's hand as they
 *  pan between a dense minute and an empty hour. */
const FLOOR_MS = 1_000;

/** How a lane names itself. The id is the addressable truth (Trace filters by
 *  it), but an imported Claude Code session hands us a 26-char toolu_* id next
 *  to a readable agent type in the label — so the label leads when there is one
 *  and the id steps back into the chip. No label, no chip: the id keeps the
 *  title and nothing is invented to fill the slot. */
export function laneNames(lane: { id: string; label: string | null }): {
  title: string;
  chip: string | null;
} {
  const label = lane.label === null ? "" : lane.label.trim();
  if (label === "" || label === lane.id) return { title: lane.id, chip: null };
  return { title: label, chip: lane.id };
}

/** A button press has no pointer behind it, so the only honest anchor is the
 *  middle of the current window: it is the one place that does not claim the
 *  reader was looking somewhere they were not. Only the RATIO of these two ever
 *  reaches `zoomAt`, so the units are free and the halves say what they mean. */
const CENTRE = { anchorPx: 0.5, widthPx: 1 };

/** The zoom, made visible.
 *
 *  ctrl + wheel worked before this existed and could not be found: a wheel with
 *  no modifier is the page's, correctly, so a reader who turns it over the band
 *  sees the page scroll and concludes the zoom is broken (owner, 2026-08-03).
 *  These are the same intents the wheel and the keys produce, which is why they
 *  route through `buttonToIntent` rather than carrying their own steps.
 *
 *  It rides in the pinned strip row, not the toolbar. The toolbar scrolls away
 *  after 94px and takes its controls with it; the strip stays, and it is the
 *  better readout anyway, because the window outline moves under your thumb as
 *  you press. */
function ZoomControls({
  win,
  minW,
  onWindow,
}: {
  win: Window;
  minW: number;
  onWindow: (next: Window) => void;
}) {
  const lang = useLang();
  const enabled = zoomEnabled(win, minW);
  const press = (button: ZoomButton) =>
    // No ticks: `buttonToIntent` never returns a "page", which is the only
    // intent that reads them. Handing over a lane's worth would be decoration.
    onWindow(applyIntent(win, buttonToIntent(button), { ...CENTRE, minW, ticks: [] }));

  // A disabled control still has to say WHY, or it is the same dead end as one
  // that stays lit and quietly does nothing.
  // The − and + knobs are gone (owner, 2026-08-05: "keine knubbel … wie im
  // musik programm stufenlos rein und rauszoomen"). They were the only stepped
  // affordance on a surface whose gesture is continuous: the wheel is
  // exponential, so a trackpad and a coarse mouse both feel proportional, and
  // two buttons offering fixed halves and doubles beside it taught a reader the
  // wrong mental model of what the zoom is.
  //
  // `fit` stays, and stays a WORD. A stepless zoom needs a way home more than a
  // stepped one does — you can end up anywhere — and "fit" is a destination
  // rather than an increment, which is exactly the thing a knob is not.
  const buttons: { key: ZoomButton; glyph: string; label: string; blocked: string }[] = [
    {
      key: "fit",
      glyph: t(lang, "sp.zoomFitShort"),
      label: t(lang, "sp.zoomFit"),
      blocked: t(lang, "sp.zoomAtWhole"),
    },
  ];

  return (
    <span className="spectrum-zoom" role="group" aria-label={t(lang, "sp.zoomControlsAria")}>
      {buttons.map((b) => (
        <button
          key={b.key}
          type="button"
          className={`spectrum-zoom-btn${b.key === "fit" ? " spectrum-zoom-btn--word" : ""}`}
          onClick={() => press(b.key)}
          disabled={!enabled[b.key]}
          aria-label={b.label}
          title={enabled[b.key] ? b.label : b.blocked}
        >
          <span aria-hidden="true">{b.glyph}</span>
        </button>
      ))}
    </span>
  );
}

function LaneRow({
  lane,
  marks,
  win,
  minW,
  running,
  events,
  t0,
  onOpen,
  onFocusEvent,
  onWidth,
  onWindow,
  tipBelow,
}: {
  lane: Lane;
  marks: LaneTick[];
  win: Window;
  minW: number;
  running: boolean;
  events: RunEvent[];
  t0: number;
  onOpen: (id: string) => void;
  onFocusEvent?: (agentId: string, event: RunEvent) => void;
  onWidth?: (px: number) => void;
  onWindow?: (next: Window) => void;
  /** The TOP row has no room above it — its tick preview opens downward
   *  instead of being clipped by the toolbar (owner 2026-07-26). */
  tipBelow?: boolean;
}) {
  const lang = useLang();
  const live = running && lane.state === "working";
  const names = laneNames(lane);
  return (
    <div className="spectrum-lane">
      <button
        type="button"
        className="spectrum-rail"
        title={t(lang, "sp.openTrace", { id: lane.id })}
        onClick={() => onOpen(lane.id)}
      >
        <span className="spectrum-rail-head">
          <span
            className={`dot ${lane.state === "failed" ? "error" : lane.state === "working" ? "accent" : lane.state === "completed" ? "ok" : "faint"}${live ? " pulse" : ""}`}
            aria-hidden="true"
          />
          <span className="spectrum-id mono">{names.title}</span>
          {names.chip !== null && (
            <span className="spectrum-label mono" title={names.chip}>
              {names.chip}
            </span>
          )}
          {lane.pendingGate && <span className="spectrum-gate mono pulse">{t(lang, "sp.gateOpen")}</span>}
        </span>
        <span className="spectrum-task" title={lane.task}>
          {lane.task === "" ? t(lang, "sp.noTask") : lane.task}
        </span>
        <span className="spectrum-meta mono tabular">
          {t(lang, `map.life.${lane.state}`)}
          {lane.inTokens + lane.outTokens > 0 &&
            ` · ${formatTokens(lane.inTokens)} in / ${formatTokens(lane.outTokens)} out`}
        </span>
      </button>
      <SpectrumBand
        lane={lane}
        marks={marks}
        win={win}
        minW={minW}
        events={events}
        t0={t0}
        onFocusEvent={onFocusEvent}
        onWidth={onWidth}
        onWindow={onWindow}
        tipBelow={tipBelow}
      />
    </div>
  );
}

export function SpectrumView(props: {
  events: RunEvent[];
  /** Live view only — replays are never "running". */
  running: boolean;
  onOpenTrace: (agentId: string) => void;
  /** Drill into ONE event from the band; absent = no per-event trace hand-off. */
  onFocusEvent?: (agentId: string, event: RunEvent) => void;
  /** The entered fleet's fold, when this view is showing a fleet rather than one
   *  session. Absent for a session: there are no hub nodes to name. The roster
   *  is the only place a node's advertised capabilities and its epoch as a
   *  RESTART are on screen, and both are folded off every roster frame. */
  fleet?: { roster: FleetNode[]; epochBySender: Record<string, number> };
}) {
  const lang = useLang();
  // Pure props.events fold. The event SOURCE (own session, replay, or an entered
  // fleet) is chosen upstream in App.tsx; Spectrum just renders whatever flat
  // stream it is handed — one lane per agent, live and replay through one path.
  const running = props.running;
  const model = useMemo(() => buildSpectrum(props.events), [props.events]);
  // What this view actually put on screen. The fan-out criterion cannot be settled
  // from the server's stream for a scenario, which never reaches it, so the face
  // reports its own lane count as the witness for what it rendered.
  useEffect(() => {
    if (model.lanes.length >= 2) beacon("spectrum", null, model.lanes.length);
  }, [model.lanes.length]);
  // One measured width for the whole tab. Every band sits in the same grid
  // column, so the first to report settles it, and the slice the view counts is
  // the slice the bands draw. Until a band has measured, BAND_W stands in.
  const [bandW, setBandW] = useState(BAND_W);

  // NULL means "the whole", and it is not the same value as {0,1}. A live stream
  // keeps moving t1, so a stored pair of fractions would have to be rewritten on
  // every arriving event just to keep meaning "everything". Null needs no
  // rewriting and cannot drift.
  const [winState, setWinState] = useState<Window | null>(null);
  const span = model.t1 - model.t0;
  const minW = minWidthFor(span, FLOOR_MS);

  // The ONE writer. A gesture hands back a window; what gets stored is a window
  // or the sentinel, and `storeWindow` is the only place that decides which.
  // Pressing "all" used to store the pair {0,1} through the raw setter, which
  // reads as the whole for exactly as long as the stream stops growing: the next
  // arriving event rebased it, the button that had just been pressed lit up
  // again, and everything after the press sat off the right edge. Every surface
  // that can move the window goes through here, so the buttons, the keys and the
  // overview strip cannot come to disagree about what "the whole" means.
  const setWindow = (next: Window) => setWinState(storeWindow(next));

  // A window is a pair of fractions OF THE SPAN. When an arriving event extends
  // the stream, every mark renormalizes underneath it, and a reader zoomed into
  // something twenty minutes ago would be dragged off it without touching
  // anything. So the window is carried across the change by absolute instants.
  const domain = useRef({ t0: model.t0, t1: model.t1 });
  if (domain.current.t0 !== model.t0 || domain.current.t1 !== model.t1) {
    const was = domain.current;
    domain.current = { t0: model.t0, t1: model.t1 };
    if (winState !== null) {
      setWindow(rebase(winState, was.t0, was.t1, model.t0, model.t1));
    }
  }

  const win = winState ?? FULL;

  // Card 181: the window is a READING, and a reading belongs in the address.
  // The whole span reports NOTHING rather than the pair {0,1}: a reader who has
  // not zoomed should get a clean link, and null-means-the-whole is exactly the
  // distinction this view already keeps.
  useEffect(() => {
    reportView("spectrum", isWhole(win) ? {} : { win: { a: win.a, b: win.b } });
  }, [win]);
  // Taken once, through the same one writer every other gesture uses, so an
  // address cannot store a window the buttons and keys would disagree about.
  const setWindowRef = useRef(setWindow);
  setWindowRef.current = setWindow;
  const offered = useSyncExternalStore(subscribeReportedViews, incomingGeneration, incomingGeneration);
  useEffect(() => {
    const arriving = takeIncomingView("spectrum");
    if (arriving?.win !== undefined) setWindowRef.current(arriving.win);
  }, [offered, model.t0, model.t1]);
  const slices = useMemo(
    () => model.lanes.map((l) => sliceLane(l.ticks, win, bandW)),
    [model.lanes, win, bandW],
  );
  const hidden = slices.reduce((n, s) => n + s.hidden, 0);

  // Does this stream need a viewport at all? Asked of the WHOLE, never of the
  // current window: asked of the window it would answer false the moment a
  // reader zoomed into a sparse minute, the strip would vanish, and they would
  // be stranded deep in the axis with no orientation and no way back.
  /**
   * Whether the viewport surface is drawn at all — which is now: whenever there
   * is a lane.
   *
   * It was `needsViewport`: appear once a lane cannot draw half of what it
   * carries. A good answer to "when is a reader LOST", and the wrong answer to
   * "is there an instrument here" — on a 123-event session everything fits, so
   * the strip simply was not there and the owner went looking for it. It was
   * then "more than one mark", and that was the same mistake one notch smaller.
   *
   * Owner, 2026-08-05: "die scrubbing zoom ui bitte immer einblenden. auch wenn
   * es nur eine kurze interaktion ist". A one-event run has a strip showing one
   * mark and a window covering all of it, which is not useless — it is the
   * instrument being where it always is. A control that moves depending on how
   * much happened is a control a reader cannot build a habit around.
   *
   * `needsViewport` still exists and its measurement still stands; it is simply
   * not the question this gate asks.
   */
  const zoomable = model.lanes.length > 0;
  const allTicks = useMemo(
    () => (zoomable ? model.lanes.flatMap((l) => l.ticks) : []),
    [model.lanes, zoomable],
  );
  const onWindow = zoomable ? setWindow : undefined;

  return (
    <div className="spectrum-view" data-reveal>
      <div className="spectrum-toolbar">
        <span className="spectrum-legend" role="list" aria-label={t(lang, "sp.legendAria")}>
          {LEGEND.map((k) => (
            <span key={k} role="listitem" className="spectrum-legend-item mono">
              <span className="spectrum-legend-mark" style={{ background: TICK_COLOR[k] }} />
              {k}
            </span>
          ))}
        </span>
        {/* The totals are orientation you read once, so they scroll away with
            the legend. The zoom went with the strip instead: see below. */}
        <span className="spectrum-toolbar-end">
          <span className="spectrum-count mono tabular">
            {t(lang, "sp.count", { n: model.totalEvents, lanes: model.lanes.length })}
            {span > 0 && ` · ${formatDuration(span)}`}
            {running && ` · ${t(lang, "sp.live")}`}
            {/* Only once a reader has actually left the whole. On a view that is
                showing everything there is nothing to report and nothing to undo,
                and that is a question about the WINDOW: a slot that has been
                written once holds {0,1} just as happily, and then the readout
                prints the total span twice for the rest of the session. */}
            {!isWhole(win) && ` · ${formatDuration(span * (win.b - win.a))} ${t(lang, "sp.ofSpan")}`}
          </span>
        </span>
      </div>

      {/* The fleet, named, above its lanes: which nodes the hub has seen, what
          each one can do, and whether an epoch says a node restarted rather than
          kept running. A lane shows what a node DID; nothing else in the app
          shows what it can do. */}
      {props.fleet !== undefined && props.fleet.roster.length > 0 && (
        <FleetRoster roster={props.fleet.roster} epochBySender={props.fleet.epochBySender} />
      )}

      {/* The strip and the axis sit in the lane grid, not beside it: the rail
          column is flexible, so anything aligned to the bands by a fixed margin
          would drift the moment the window resized.
          They are also the two rows that pin, to the top and the bottom of this
          scroller. The zoom rides in the head's rail cell rather than up in the
          toolbar: it is a control, the strip beside it is what it moves, and
          the toolbar scrolls away after 94px. */}
      {zoomable && model.lanes.length > 0 && (
        <div className="spectrum-viewport-row spectrum-viewport-row--head">
          <span className="spectrum-viewport-rail">
            <span className="spectrum-viewport-label mono">{t(lang, "sp.overview")}</span>
            <ZoomControls win={win} minW={minW} onWindow={setWindow} />
          </span>
          <SpectrumStrip ticks={allTicks} win={win} minW={minW} cols={bandW} onWindow={setWindow} />
        </div>
      )}

      {model.lanes.length === 0 ? (
        <div className="spectrum-empty">
          <p>{t(lang, "sp.empty")}</p>
          <p className="spectrum-empty-sub">{t(lang, "sp.emptyHint")}</p>
        </div>
      ) : (
        <div className="spectrum-lanes" role="list" aria-label={t(lang, "sp.lanesAria")}>
          {model.lanes.map((lane, laneIndex) => (
            <div key={lane.id} className="spectrum-lane-group">
              <LaneRow
                lane={lane}
                marks={slices[laneIndex].marks}
                win={win}
                minW={minW}
                running={running}
                events={props.events}
                t0={model.t0}
                onOpen={props.onOpenTrace}
                onFocusEvent={props.onFocusEvent}
                onWidth={laneIndex === 0 ? setBandW : undefined}
                onWindow={onWindow}
                tipBelow={laneIndex === 0}
              />
              {lane.thinking !== "" && (
                <ThinkingDisclosure text={lane.thinking} active={running && lane.state === "working"} />
              )}
            </div>
          ))}
        </div>
      )}

      {zoomable && model.lanes.length > 0 && (
        <div className="spectrum-viewport-row spectrum-viewport-row--foot">
          <span />
          <SpectrumAxis win={win} t0={model.t0} t1={model.t1} cols={bandW} />
        </div>
      )}

      {hidden > 0 && (
        <p className="spectrum-note mono">
          {t(lang, hidden === 1 ? "sp.hiddenMark" : "sp.hiddenMarks", { n: hidden })}
        </p>
      )}
      {zoomable && model.lanes.length > 0 && <p className="spectrum-note mono">{t(lang, "sp.zoomHint")}</p>}
    </div>
  );
}
