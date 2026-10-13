// The fleet switches, settable here instead of only as env vars. Card 585 split
// the hub into a switch (SPECTRO_HUB_ENABLED) and a port (SPECTRO_HUB_PORT,
// default 7700), and the port is checked with the server before it is saved.
//
// Owner, 2026-08-05: "können wir diese sachen bitte auch in den settings setzen
// lassen? … sonst verlieren wir viele leute die env zu finden". He is right:
// the fleet lobby's honest "turn the hub on and restart the server" is a
// correct sentence that loses everyone who has never edited a dotfile.
//
// Two things this screen refuses to fake:
//
//  1. It says the value is NOT in force yet. The switches are read at bean
//     creation (FleetAggregator, NodeSpawner), and a running JVM cannot change
//     its own environment, so saving puts a value on disk and nothing more. A
//     "saved ✓" with no restart line would be the same half-truth as a spawn
//     button that only admits it cannot work after it is pressed.
//  2. It asks before arming spawning. SPECTRO_ALLOW_SPAWN lets this server
//     start processes; a reader who does not know that should not be able to
//     turn it on by clicking a toggle whose label is three words. The
//     confirmation is a courtesy to the reader; the CONTROL is the endpoint's
//     origin fence, which a cross-site page cannot pass.

import { useEffect, useState } from "react";
import { useLang } from "../state/lang";
import { t } from "../i18n/i18n";
import {
  checkHubPort,
  hubStatusText,
  HUB_DEFAULT_PORT,
  saveHubPort,
  saveSetting,
  type HubState,
  type SaveResult,
  type SettingsState,
} from "./hubSettings";

type Saved = "idle" | "saving" | "restart" | "failed";

export function FleetSettings({ anchorId }: { anchorId: string }) {
  const lang = useLang();
  const de = lang === "de";
  // Each entry: the value, whether a real environment variable holds it (it
  // wins for the life of this process), and for the hub switch whether the
  // saved values turn the hub on. Read again after every save (review D4).
  const [state, setState] = useState<SettingsState | null>(null);
  // Card 585: the field shows the port the hub uses when nothing is written.
  const [port, setPort] = useState(HUB_DEFAULT_PORT);
  const [shownPort, setShownPort] = useState(HUB_DEFAULT_PORT);
  const [portWords, setPortWords] = useState<string | null>(null);
  const [inUse, setInUse] = useState<number | null>(null);
  const [hub, setHub] = useState<HubState | null>(null);
  const [saved, setSaved] = useState<Saved>("idle");
  const [confirming, setConfirming] = useState(false);

  // Read-only, on open. This panel has a history of writing when it was merely
  // looked at (card 121), so nothing here posts without a press.
  useEffect(() => {
    let alive = true;
    void fetch("/api/settings/env")
      .then((r) => (r.ok ? r.json() : null))
      .then((body: SettingsState | null) => {
        if (!alive || body === null) return;
        setState(body);
        const hubPort = body["SPECTRO_HUB_PORT"];
        const shown = hubPort?.value || hubPort?.default || HUB_DEFAULT_PORT;
        setPort(shown);
        setShownPort(shown);
      })
      .catch(() => {});
    // What the running hub became, and why (the roster's hub block).
    void fetch("/api/fleet")
      .then((r) => (r.ok ? r.json() : null))
      .then((body: { hub?: HubState } | null) => {
        if (alive && body?.hub) setHub(body.hub);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);

  // Every save reads the settings back, so the switch shows what the file says.
  const done = (result: SaveResult): void => {
    if (result.settings !== null) setState(result.settings);
    if (result.refusedKey !== null) setPortWords(t(lang, result.refusedKey));
    setSaved(result.ok ? "restart" : "failed");
  };

  const save = (name: string, value: string): void => {
    setSaved("saving");
    void saveSetting(name, value).then(done);
  };

  const savePort = (value: string): void => {
    setInUse(null);
    setShownPort(value);
    setSaved("saving");
    // The switch goes into the file with the port, as the screen shows it.
    void saveHubPort(value, state ?? {}).then(done);
  };

  const onPortBlur = (): void => {
    if (portPinned || port === shownPort) return;
    const typed = port;
    setPortWords(null);
    setInUse(null);
    void checkHubPort(typed).then((step) => {
      if (step.kind === "refused") setPortWords(t(lang, step.key));
      else if (step.kind === "inUse") setInUse(step.port);
      else savePort(typed);
    });
  };

  const hubState = state?.["SPECTRO_HUB_ENABLED"];
  const hubOn = hubState?.effective ?? (hubState?.value ?? "").toLowerCase() === "true";
  const spawnOn = (state?.["SPECTRO_ALLOW_SPAWN"]?.value ?? "").toLowerCase() === "true";
  const hubPinned = hubState?.fromEnvironment === true;
  const portPinned = state?.["SPECTRO_HUB_PORT"]?.fromEnvironment === true;
  const spawnPinned = state?.["SPECTRO_ALLOW_SPAWN"]?.fromEnvironment === true;

  return (
    <>
      <div className="settings-label" id={anchorId}>
        {t(lang, "set.secFleet")}
      </div>
      <p className="settings-note">{t(lang, "set.fleetHint")}</p>

      <div className="settings-row settings-row--hub">
        <button
          type="button"
          className={`settings-toggle${hubOn ? " settings-toggle--on" : ""}`}
          aria-pressed={hubOn}
          disabled={hubPinned}
          onClick={() => save("SPECTRO_HUB_ENABLED", hubOn ? "false" : "true")}
        >
          {t(lang, "set.hubEnabled")}
        </button>
        {hub !== null && (
          <span
            className={`settings-note settings-note--inline${hub.note !== null ? " settings-note--warn" : ""}`}
          >
            {hubStatusText(hub, lang)}
          </span>
        )}
      </div>

      <div className="settings-grid">
        <label className="settings-field">
          <span>{t(lang, "set.hubPort")}</span>
          <input
            type="text"
            inputMode="numeric"
            placeholder={HUB_DEFAULT_PORT}
            value={port}
            disabled={portPinned}
            onChange={(e) => setPort(e.target.value)}
            onBlur={onPortBlur}
          />
        </label>
      </div>
      {portWords !== null && <p className="settings-note settings-note--warn">{portWords}</p>}
      {inUse !== null && (
        <div className="settings-confirm" role="alertdialog" aria-label={t(lang, "set.hubPort")}>
          <p>{t(lang, "hub.inUse", { port: inUse })}</p>
          <div className="settings-confirm-row">
            <button type="button" className="settings-confirm-no" onClick={() => setInUse(null)}>
              {de ? "abbrechen" : "cancel"}
            </button>
            <button type="button" className="settings-confirm-yes" onClick={() => savePort(String(inUse))}>
              {t(lang, "hub.saveAnyway")}
            </button>
          </div>
        </div>
      )}

      <div className="settings-row settings-row--spawn">
        <button
          type="button"
          className={`settings-toggle${spawnOn ? " settings-toggle--on" : ""}`}
          aria-pressed={spawnOn}
          disabled={spawnPinned}
          onClick={() => (spawnOn ? save("SPECTRO_ALLOW_SPAWN", "false") : setConfirming(true))}
        >
          {t(lang, "set.allowSpawn")}
        </button>
        <span className="settings-note settings-note--inline">{t(lang, "set.allowSpawnWhat")}</span>
      </div>

      {/* The words before the switch, not after it. */}
      {confirming && (
        <div className="settings-confirm" role="alertdialog" aria-label={t(lang, "set.allowSpawn")}>
          <p>{t(lang, "set.allowSpawnWarn")}</p>
          <div className="settings-confirm-row">
            <button type="button" className="settings-confirm-no" onClick={() => setConfirming(false)}>
              {de ? "abbrechen" : "cancel"}
            </button>
            <button
              type="button"
              className="settings-confirm-yes"
              onClick={() => {
                setConfirming(false);
                save("SPECTRO_ALLOW_SPAWN", "true");
              }}
            >
              {de ? "verstanden, einschalten" : "understood, turn it on"}
            </button>
          </div>
        </div>
      )}

      {(hubPinned || portPinned || spawnPinned) && <p className="settings-note">{t(lang, "set.envWins")}</p>}
      {saved === "restart" && (
        <p className="settings-note settings-note--warn">{t(lang, "set.restartNeeded")}</p>
      )}
      {saved === "failed" && <p className="settings-note settings-note--warn">{t(lang, "set.saveFailed")}</p>}
    </>
  );
}
