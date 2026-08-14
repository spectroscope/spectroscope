// Web search, as a settings block a user can act on (card 203). The owner's
// instruction, in his words: "gerne als inline in den optionen wie bei langfuse
// also docker line zum kopieren und eben konfig einer existierenden instanz und
// tavily und brave integration mit einbauen als fallback" — inline in the
// options like Langfuse: a docker line to copy, a field for an instance you
// already run, and Tavily and Brave wired in as the fallback. The German stands
// because a quote that is translated is no longer a quote; the English stands
// because this file ships in a public repository.
//
// Before this block, choosing how the product searched the web meant learning
// about an environment variable by reading the source — and the default, with
// nothing set, was an HTML scrape of DuckDuckGo that DuckDuckGo's own terms
// prohibit. The block therefore does two jobs that pull in opposite directions:
// it offers the three real options, and it never pretends the fourth one is a
// choice somebody made.
//
// The one rule this file obeys above all others: it does NOT decide which tier
// is active. WebSearchTiers on the server decides, /api/config reports, and
// this renders. A rule written a second time in TypeScript would be exactly the
// drift the card removed from `spectro doctor`.

import { useCallback, useEffect, useState } from "react";
import { t, type Lang } from "../i18n/i18n";
import { useLang } from "../state/lang";
import { CopyButton } from "./CopyButton";
import { commitSearxngUrl, searxngOffer, tierReading } from "./webSearchSetup";
import type { DockerStatus } from "./dockerOffer";

/** The `webSearch` block of /api/config — mirrors SessionsController#config. */
export interface WebSearchStatus {
  /** The resolver's tier name: searxng | tavily | brave | duckduckgo. This is
   *  the field this page reads — the DECISION, which it never second-guesses. */
  tier: string;
  /** The resolver's own label and sentence, in English. Carried here because
   *  the server's other two faces (the tool description a model reads, the
   *  `spectro doctor` line) print exactly these, and having them on the wire
   *  makes that comparable. This page deliberately does NOT render them: it is
   *  bilingual and they are not, so it phrases the tier it was handed instead.
   *  Phrasing is not deciding. */
  label: string;
  detail: string;
  /** The saved instance address, or "" — an address, never a credential. */
  searxngUrl: string;
  /** Presence only, as the string "true"/"false". */
  tavilyKey: string;
  braveKey: string;
}

/** Paste a search-provider API key and save it to ~/.spectro/.env (0600)
 *  through the same local-origin endpoint the LLM providers use. Masked; the
 *  value only ever leaves as the POST body, and nothing ever reads it back. */
function SearchKeyField({
  provider,
  label,
  present,
  onSaved,
}: {
  provider: string;
  label: string;
  present: boolean;
  onSaved: () => void;
}) {
  const lang = useLang();
  const [key, setKey] = useState("");
  const [state, setState] = useState<"idle" | "saving" | "ok" | "err">("idle");

  const save = async (): Promise<void> => {
    if (key.trim() === "") return;
    setState("saving");
    try {
      const res = await fetch("/api/onboarding/key", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider, key: key.trim() }),
      });
      if (res.ok) {
        setState("ok");
        setKey("");
        onSaved();
      } else {
        setState("err");
      }
    } catch {
      setState("err");
    }
  };

  return (
    <div className="settings-field">
      <span>{label}</span>
      <div className="pp-keyrow">
        <input
          className="provider-input"
          type="password"
          autoComplete="off"
          value={key}
          placeholder={t(lang, present ? "set.searchKeyReplace" : "set.searchKeyPlaceholder")}
          onChange={(e) => setKey(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") void save();
          }}
        />
        <button
          type="button"
          className="soft-primary pp-keysave"
          disabled={state === "saving" || key.trim() === ""}
          onClick={() => void save()}
        >
          {t(lang, state === "saving" ? "pp.keySaving" : "pp.keySave")}
        </button>
      </div>
      {/* Presence, never the value. The server reports a boolean and this says
          which of the two it is — a masked echo of a stored key would be a
          secret on screen for no gain. */}
      <span className="settings-note">
        {t(lang, present ? "set.searchKeyPresent" : "set.searchKeyAbsent")}
      </span>
      {state === "err" && <span className="settings-note settings-note--warn">{t(lang, "pp.keyErr")}</span>}
    </div>
  );
}

/** The Docker offer under the instance field — one sentence for one state, and
 *  nothing at all until the probe answers. Same shape as the Observability
 *  block's, and deliberately the same decision underneath it. */
function SearxngOfferBlock({ status, lang }: { status: DockerStatus | null; lang: Lang }) {
  const offer = searxngOffer(status);
  if (offer.kind === "unknown") return null;
  return (
    <div className="settings-docker">
      <p className="settings-note">{t(lang, offer.messageKey)}</p>
      {offer.href ? (
        <p className="settings-note">
          <a href={offer.href} target="_blank" rel="noreferrer noopener">
            {t(lang, "set.dockerInstall")}
          </a>
        </p>
      ) : null}
      {offer.command ? (
        <>
          <pre className="settings-docker-cmd">
            <code>{offer.command}</code>
          </pre>
          <CopyButton text={() => offer.command ?? ""} label={t(lang, "set.langfuseCommand")} />
          <p className="settings-note">{t(lang, "set.searxngCost")}</p>
        </>
      ) : null}
    </div>
  );
}

export function WebSearchSettings({
  anchorId,
  searxngUrl,
  originRow,
  onSave,
}: {
  anchorId: string;
  /** The resolved `searxngUrl` from /api/settings — the field prefills from it. */
  searxngUrl: string;
  /** The page's provenance badge + reset for `searxngUrl`, passed in so this
   *  block does not grow its own copy of the settings-layer vocabulary. */
  originRow?: React.ReactNode;
  /** Writes one settings key, exactly like every other field in this panel.
   *  Returns the write's promise so the tier line below can wait for it —
   *  the server resolves the tier from the file this patch is still writing. */
  onSave: (patch: Record<string, unknown>) => void | Promise<unknown>;
}) {
  const lang = useLang();
  const [status, setStatus] = useState<WebSearchStatus | null>(null);
  const [docker, setDocker] = useState<DockerStatus | null>(null);
  const [draft, setDraft] = useState(searxngUrl);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/config");
      const body = res.ok ? ((await res.json()) as { webSearch?: WebSearchStatus }) : null;
      setStatus(body?.webSearch ?? null);
    } catch {
      setStatus(null); // an older server has no such block; the line stays silent
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // Docker detection, read-only and once. A server too old to carry the route
  // answers 404, which lands in the catch and leaves the offer silent rather
  // than shouting.
  useEffect(() => {
    let live = true;
    fetch("/api/docker/status")
      .then((res) => (res.ok ? (res.json() as Promise<DockerStatus>) : null))
      .then((answer) => {
        if (live) setDocker(answer);
      })
      .catch(() => {
        if (live) setDocker(null);
      });
    return () => {
      live = false;
    };
  }, []);

  // Resync when the server-resolved value changes under the field (a reset
  // elsewhere in the page refreshed the view).
  useEffect(() => setDraft(searxngUrl), [searxngUrl]);

  const reading = tierReading(status?.tier ?? "", status?.searxngUrl ?? "");

  // The tier moves the moment the address is saved, so the line above the field
  // is re-read — AFTER the write has landed, because the server resolves the
  // tier by reading the settings file that write is producing. The order lives
  // in commitSearxngUrl, where a test can hold it.
  const commit = (raw: string): void => void commitSearxngUrl(raw, searxngUrl, onSave, load);

  return (
    <>
      <div className="settings-label" id={anchorId}>
        {t(lang, "set.secWebSearch")}
      </div>
      <p className="settings-note">{t(lang, "set.webSearchHint")}</p>

      {/* ---- What answers RIGHT NOW. The TIER comes from the server's one
          resolver; only the wording is chosen here, so a German reader does
          not meet an English sentence in the middle of their settings. An
          unknown tier (newer server, older bundle) shows its bare name rather
          than a sentence about the wrong backend. ---- */}
      {status && (
        <p className="settings-note" data-testid="web-search-tier">
          <span className="origin-badge">
            {status.tier}
            {reading.labelKey ? ` · ${t(lang, reading.labelKey)}` : ""}
          </span>{" "}
          {reading.detailKey ? t(lang, reading.detailKey, { addr: reading.addr }) : ""}
        </p>
      )}

      {/* ---- WHEN it takes effect (card 222). This line is the whole reason
          that card exists: the tier above was right, the search that followed
          it used a different one, and the page said nothing about which
          instant it was describing. web_search resolves its tier per call, so
          the honest sentence here is "immediately" — and it has to be on the
          screen rather than in a release note, because the reader's next move
          is to go and search. ---- */}
      <p className="settings-note" data-testid="web-search-reach">
        {t(lang, "set.reachLive")}
      </p>

      {/* ---- 1. SearXNG: an instance you run ---- */}
      <div className="settings-grid">
        <label className="settings-field">
          <span>{t(lang, "set.searxngUrl")}</span>
          <input
            type="text"
            placeholder="http://localhost:8888"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={(e) => commit(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") (e.currentTarget as HTMLInputElement).blur();
            }}
          />
          {originRow}
        </label>
      </div>
      <p className="settings-note">{t(lang, "set.searxngOwnInstance")}</p>
      <SearxngOfferBlock status={docker} lang={lang} />

      {/* ---- 2. The two keyed providers ---- */}
      <p className="settings-note">{t(lang, "set.searchKeyedHint")}</p>
      <div className="settings-grid">
        <SearchKeyField
          provider="tavily"
          label={t(lang, "set.tavilyKey")}
          present={status?.tavilyKey === "true"}
          onSaved={() => void load()}
        />
        <SearchKeyField
          provider="brave"
          label={t(lang, "set.braveKey")}
          present={status?.braveKey === "true"}
          onSaved={() => void load()}
        />
      </div>

      {/* ---- 3. The one nobody chose ---- */}
      <p className="settings-note">{t(lang, "set.searchScrapeNote")}</p>
      <p className="settings-note">{t(lang, "set.searchNoFallThrough")}</p>
    </>
  );
}
