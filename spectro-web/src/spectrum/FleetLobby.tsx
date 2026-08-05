// The fleets segment before anything is entered — the screen that used to be
// nothing at all.
//
// Pressing `fleets` re-rendered one sidebar list and left the whole right-hand
// side exactly as it was, so the app read as broken ("wenn ich in den Fleet
// Modus gehe, dann bleibt alles so, wie es ist"). The segment now reaches App
// (see the `nav` state there) and lands here.
//
// The bar is the chat's own empty state: a mark, one line saying what this is,
// and then a control that DOES something. What makes this screen harder than
// the chat's is that two of its three offers depend on the machine. A fleet is
// not an object anyone creates — there is no POST /api/fleet. There is only
// spawning a NODE into a hub that must already be running, behind two opt-ins
// that both default to off (SPECTRO_HUB_PORT and SPECTRO_ALLOW_SPAWN), and the
// server answers a uniform 404 for every reason it might refuse, deliberately,
// so the client cannot be told which one is missing.
//
// So the offers are ordered by how certainly they work, and the ones that
// cannot work say so BEFORE they are pressed rather than failing afterwards.
// That is this project's mock-labelling rule applied one step earlier.

import { useState } from "react";
import { useLang } from "../state/lang";
import { SCENARIOS } from "../scenario/registry";
import { loc, type Dsl } from "../scenario/dsl";
import { buildNodeCommand } from "./nodeCommand";

/** The scenarios that become a fleet when played — the one offer on this
 *  screen that needs nothing configured and cannot fail. */
const FLEET_SCENARIOS = SCENARIOS.filter((s) => s.fleet === true);

export function FleetLobby(props: {
  /** Fleets already on the bus, if any — the lobby says so rather than
   *  pretending the machine is empty. */
  fleetCount: number;
  /** The live hub's port, or null when no hub is running. Null is what makes
   *  two of the three offers honest instead of hopeful. */
  hubPort: number | null;
  /** Play a fleet scenario: it loads as a replay fleet and enters it. */
  onSelectScenario: (dsl: Dsl) => void;
  /** Open the spawn dialog (only reachable when a hub is up). */
  onSpawn: () => void;
}) {
  const de = useLang() === "de";
  const [copied, setCopied] = useState(false);
  const hubUp = props.hubPort !== null;
  const cmd = buildNodeCommand(
    { prompt: "review the open PR", context: "review", role: "worker", id: "", linger: false },
    props.hubPort,
    "ask",
  );
  const copy = (): void => {
    void navigator.clipboard
      ?.writeText(cmd)
      .then(() => {
        setCopied(true);
        window.setTimeout(() => setCopied(false), 1500);
      })
      .catch(() => {});
  };

  return (
    <div className="fleet-home fleet-lobby" data-reveal>
      <div className="fleet-home-inner">
        <p className="fleet-home-eyebrow mono">{de ? "flotten" : "fleets"}</p>
        <h2 className="fleet-home-title">
          {de ? "Mehrere Agenten, ein Schirm." : "Several agents, one screen."}
        </h2>
        <p className="fleet-home-lead">
          {props.fleetCount > 0
            ? de
              ? `${props.fleetCount} Flotte(n) liegen links. Öffne eine — oder spiele unten eine, um zu sehen, wie der Bus arbeitet.`
              : `${props.fleetCount} fleet(s) are listed on the left. Open one — or play one below to watch the bus work.`
            : de
              ? "Eine Flotte ist ein Bus: jeder Agent eine Karte, der Verkehr auf der Schiene dazwischen. Noch liegt keine hier. Am schnellsten siehst du das an einem aufgezeichneten Lauf."
              : "A fleet is a bus: every agent a card, the traffic on the rail between them. There is none here yet, and the fastest way to see one work is a recorded run."}
        </p>

        {/* Offer 1: always works, nothing configured, no mock. */}
        <div className="fleet-home-card">
          <p className="fleet-home-card-label mono">{de ? "eine flotte abspielen" : "play a fleet"}</p>
          <nav className="lobby-scenarios" aria-label={de ? "Flotten-Szenarien" : "fleet scenarios"}>
            {FLEET_SCENARIOS.map((s) => (
              <button
                type="button"
                key={s.id}
                className="lobby-scenario"
                title={loc(s.prompt, de ? "de" : "en")}
                onClick={() => props.onSelectScenario(s)}
              >
                <svg className="scenario-glyph" viewBox="0 0 16 16" width="10" height="10" aria-hidden="true">
                  <path d="M4.5 2.8v10.4L13 8z" fill="currentColor" />
                </svg>
                {loc(s.name, de ? "de" : "en")}
              </button>
            ))}
          </nav>
        </div>

        {/* Offer 2: a real command, but only real when a hub is listening. With
            no hub, buildNodeCommand renders the literal placeholder
            127.0.0.1:HUB_PORT — printing that as if it were runnable would be
            the kind of half-true this app does not ship. */}
        <div className="fleet-home-card">
          <p className="fleet-home-card-label mono">
            {de ? "einen node starten (terminal)" : "start a node (terminal)"}
          </p>
          {hubUp ? (
            <div className="fleet-home-code">
              <code className="mono">{cmd}</code>
              <button type="button" className="fleet-home-copy" onClick={copy}>
                {copied ? (de ? "kopiert" : "copied") : de ? "kopieren" : "copy"}
              </button>
            </div>
          ) : (
            <p className="lobby-off">
              {de
                ? "Kein Hub läuft. Setze SPECTRO_HUB_PORT und starte den Server neu, dann steht hier das fertige Kommando."
                : "No hub is running. Set SPECTRO_HUB_PORT and restart the server, and the finished command stands here."}
            </p>
          )}
          <div className="fleet-home-actions">
            <button
              type="button"
              className="fleet-home-spawn"
              onClick={props.onSpawn}
              disabled={!hubUp}
              title={
                hubUp
                  ? undefined
                  : de
                    ? "Braucht einen laufenden Hub (SPECTRO_HUB_PORT) und SPECTRO_ALLOW_SPAWN."
                    : "Needs a running hub (SPECTRO_HUB_PORT) and SPECTRO_ALLOW_SPAWN."
              }
            >
              + {de ? "node starten" : "spawn a node"}
            </button>
            <a className="fleet-home-link" href="https://spectroscope.dev" target="_blank" rel="noreferrer">
              {de ? "wie es funktioniert ↗" : "how it works ↗"}
            </a>
          </div>
          {/* The honest limit, stated rather than discovered by pressing: a live
              hub does not prove spawning is allowed. /api/fleet reports only
              hubPort, and the refusal is a uniform 404 on purpose. */}
          {hubUp && (
            <p className="lobby-note">
              {de
                ? "Spawnen braucht zusätzlich SPECTRO_ALLOW_SPAWN — der Server sagt nicht, ob es gesetzt ist."
                : "Spawning also needs SPECTRO_ALLOW_SPAWN, and the server does not report whether it is set."}
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
