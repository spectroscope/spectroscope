// The two fleet switches, settable here instead of only as env vars.
//
// Owner, 2026-08-05: "können wir diese sachen bitte auch in den settings setzen
// lassen? … sonst verlieren wir viele leute die env zu finden". He is right —
// the fleet lobby's honest "set SPECTRO_HUB_PORT and restart the server" is a
// correct sentence that loses everyone who has never edited a dotfile.
//
// Two things this screen refuses to fake:
//
//  1. It says the value is NOT in force yet. Both switches are read at bean
//     creation (FleetAggregator, NodeSpawner), and a running JVM cannot change
//     its own environment, so saving puts a value on disk and nothing more. A
//     "saved ✓" with no restart line would be the same half-truth as a spawn
//     button that only admits it cannot work after it is pressed.
//  2. It asks before arming spawning. SPECTRO_ALLOW_SPAWN lets this server
//     start processes; a reader who does not know that should not be able to
//     turn it on by clicking a toggle whose label is three words. The
//     confirmation is a courtesy to the reader — the CONTROL is the endpoint's
//     origin fence, which a cross-site page cannot pass.

import { useEffect, useState } from "react";
import { useLang } from "../state/lang";
import { t } from "../i18n/i18n";

/** What the server reports about one settable name. */
interface SettingState {
  value: string;
  /** True when a real environment variable holds it — which wins over the file
   *  for the whole life of this process, so the box cannot take effect. */
  fromEnvironment: boolean;
}

type Saved = "idle" | "saving" | "restart" | "failed";

export function FleetSettings({ anchorId }: { anchorId: string }) {
  const lang = useLang();
  const de = lang === "de";
  const [state, setState] = useState<Record<string, SettingState> | null>(null);
  const [port, setPort] = useState("");
  const [saved, setSaved] = useState<Saved>("idle");
  const [confirming, setConfirming] = useState(false);

  // Read-only, on open. This panel has a history of writing when it was merely
  // looked at (card 121), so nothing here posts without a press.
  useEffect(() => {
    let alive = true;
    void fetch("/api/settings/env")
      .then((r) => (r.ok ? r.json() : null))
      .then((body: Record<string, SettingState> | null) => {
        if (!alive || body === null) return;
        setState(body);
        setPort(body["SPECTRO_HUB_PORT"]?.value ?? "");
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);

  const save = (name: string, value: string): void => {
    setSaved("saving");
    void fetch("/api/settings/env", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, value }),
    })
      .then((r) => {
        setSaved(r.ok ? "restart" : "failed");
        if (r.ok) setState((s) => ({ ...(s ?? {}), [name]: { value, fromEnvironment: false } }));
      })
      .catch(() => setSaved("failed"));
  };

  const spawnOn = (state?.["SPECTRO_ALLOW_SPAWN"]?.value ?? "").toLowerCase() === "true";
  const portPinned = state?.["SPECTRO_HUB_PORT"]?.fromEnvironment === true;
  const spawnPinned = state?.["SPECTRO_ALLOW_SPAWN"]?.fromEnvironment === true;

  return (
    <>
      <div className="settings-label" id={anchorId}>
        {t(lang, "set.secFleet")}
      </div>
      <p className="settings-note">{t(lang, "set.fleetHint")}</p>
      <div className="settings-grid">
        <label className="settings-field">
          <span>{t(lang, "set.hubPort")}</span>
          <input
            type="text"
            inputMode="numeric"
            placeholder="8744"
            value={port}
            disabled={portPinned}
            onChange={(e) => setPort(e.target.value)}
            onBlur={() => {
              if (!portPinned && port !== (state?.["SPECTRO_HUB_PORT"]?.value ?? ""))
                save("SPECTRO_HUB_PORT", port);
            }}
          />
        </label>
      </div>

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

      {(portPinned || spawnPinned) && <p className="settings-note">{t(lang, "set.envWins")}</p>}
      {saved === "restart" && (
        <p className="settings-note settings-note--warn">{t(lang, "set.restartNeeded")}</p>
      )}
      {saved === "failed" && <p className="settings-note settings-note--warn">{t(lang, "set.saveFailed")}</p>}
    </>
  );
}
