// What the Web search settings block offers once /api/docker/status has
// answered (card 203). Pure on purpose, exactly like dockerOffer next door:
// the decision is the part worth pinning, and the command is a promise about a
// file that has to keep existing.
//
// spectroscope never runs any of this. The app prints a command; the operator
// reads it and runs it. Same asymmetry, same reason: a process that can reach
// the Docker socket can bind-mount any host path into a container.

import { dockerOffer, type DockerOffer, type DockerStatus } from "./dockerOffer";
import { t, type Lang } from "../i18n/i18n";

/** The shipped setup, relative to the repository root. The tests read the
 *  installer off disk through this path, so a moved sample fails the suite. */
export const SEARXNG_SAMPLE_PATH = "samples/09-searxng";

/** The name the app serves the installer under, and the name `curl -O` saves. */
export const SEARXNG_SCRIPT_NAME = "install-searxng.sh";

/** The folder the offer makes for the script and the files it writes (the
 *  compose file and searxng/settings.yml with the instance's secret), so they
 *  never land in whatever folder the terminal happens to be in. */
export const SEARXNG_FOLDER = "~/spectro-searxng";

/** The route LocalSetupScriptController maps (card 531). Its Java test reads
 *  this literal out of this file and holds it equal to the controller's. */
export const SEARXNG_SCRIPT_ROUTE = "/local-setup/scripts/install-searxng.sh";

/** A TCP port as `location.port` gives it: digits, 1 to 65535. Anything else
 *  is dropped, so nothing but a port number reaches the printed line. */
function portSegment(port: string): string {
  if (!/^\d{1,5}$/.test(port)) return "";
  const n = Number(port);
  return n >= 1 && n <= 65535 ? `:${n}` : "";
}

/**
 * Where the running app serves the installer.
 *
 * <p>127.0.0.1, because the server binds there (`server.address` in
 * application.properties). The port is the one the page was served from; the
 * caller passes `window.location.port`, never a value read from the query.</p>
 *
 * @param port the page's own port, "" for the protocol default
 * @returns the absolute URL of the script
 */
export function searxngScriptUrl(port: string): string {
  return `http://127.0.0.1${portSegment(port)}${SEARXNG_SCRIPT_ROUTE}`;
}

/** The run line. It names the folder, so it runs the script wherever the
 *  terminal is, also after the download button saved the file elsewhere and
 *  the operator moved it in (fix round 2 of card 531). The script writes its
 *  files into the folder it is in. */
export const SEARXNG_RUN_COMMAND = `bash ${SEARXNG_FOLDER}/${SEARXNG_SCRIPT_NAME}`;

/**
 * The first copy: make the folder, then download the script into it. It stops
 * there, so the operator reads the script before {@link SEARXNG_RUN_COMMAND}
 * runs it; one copy of all three lines ran it unread (fix round 2).
 *
 * @param port the page's own port, as for {@link searxngScriptUrl}
 * @returns the two lines, joined with a newline
 */
export function searxngFetchCommand(port: string): string {
  return [`mkdir -p ${SEARXNG_FOLDER} && cd ${SEARXNG_FOLDER}`, `curl -fsSLO ${searxngScriptUrl(port)}`].join(
    "\n",
  );
}

/**
 * All the lines handed to an operator whose daemon is ready (card 531): the
 * fetch and the run. The block shows them as two copies.
 *
 * <p>A folder, the download, the run. It is not a `docker run` line: stock
 * SearXNG lists only `html` under `search.formats` and answers 403 to a JSON
 * request, so the installer writes the settings file that turns `json` on,
 * generates the instance's secret key, and waits for a real `format=json`
 * answer. It is not a clone either: the app serves the installer, and the
 * installer writes its compose file itself when none is beside it, so a DMG
 * user needs no git. It is never a pipe into a shell: the file lands on disk
 * first.</p>
 *
 * <p>The first line makes {@link SEARXNG_FOLDER} and moves into it, so the
 * three files the script leaves behind land in one place on every run. There
 * is no comment line: zsh, the macOS default shell, has interactive comments
 * off and runs a pasted `#` line as a command. How to read the script before
 * the run line is a sentence between the two blocks (`set.searxngRead`).</p>
 *
 * @param port the page's own port, as for {@link searxngScriptUrl}
 * @returns the three lines, joined with newlines
 */
export function searxngInstallCommand(port: string): string {
  return [searxngFetchCommand(port), SEARXNG_RUN_COMMAND].join("\n");
}

/** The Web search block's offer: the shared Docker offer plus, when the daemon
 *  is ready, the run line and the script's URL for the download button. For
 *  this block `command` is the fetch only. */
export type SearxngOffer = DockerOffer & {
  /** The run line, a copy of its own. Only ever set for "run". */
  run?: string;
  /** The installer's URL. Only ever set for "run", next to `command`. */
  download?: string;
};

/**
 * Decide what the Web search block should offer for a Docker status.
 *
 * The state machine is dockerOffer's — "is Docker usable on this machine" has
 * one answer, and a second copy of that reasoning would be a second thing to
 * get wrong (the install-versus-start distinction in particular, which exists
 * so nobody is told to re-download software they already have). What this
 * function replaces is the two sentences that name a stack: this block is
 * offering SearXNG, not Langfuse.
 *
 * @param status the server's answer, or null before it has arrived
 * @param port   the page's own port, for the command and the download
 * @returns the offer; `href` only for "install", `command`, `run` and `download` only for "run"
 */
export function searxngOffer(status: DockerStatus | null | undefined, port = ""): SearxngOffer {
  const shared = dockerOffer(status);
  if (shared.kind === "run") {
    return {
      ...shared,
      messageKey: "set.searxngDockerReady",
      command: searxngFetchCommand(port),
      run: SEARXNG_RUN_COMMAND,
      download: searxngScriptUrl(port),
    };
  }
  if (shared.kind === "install") {
    return { ...shared, messageKey: "set.searxngDockerAbsent" };
  }
  return shared;
}

/** The tiers the server's resolver can name. The literals ARE
 *  WebSearchTiers' own tier strings — the settings page never invents one. */
export const WEB_SEARCH_TIERS = ["searxng", "tavily", "brave", "duckduckgo"] as const;
export type WebSearchTier = (typeof WEB_SEARCH_TIERS)[number];

/** How the settings page says what the server decided. */
export interface TierReading {
  /** Dict key for the short badge. */
  labelKey: string;
  /** Dict key for the sentence; interpolates {addr} for searxng. */
  detailKey: string;
  /** The address to interpolate, or "" for a tier that has none. */
  addr: string;
  /** Dict key for a sentence the Settings block adds after the tier sentence,
   *  or "". Only the scrape has one: where the setup script is (card 531). It
   *  is a key of its own because the tier sentence is WebSearchTiers.describe()
   *  word for word (WebSearchSentenceDriftTest), which the CLI doctor prints
   *  unchanged. The doctor panel shows the tier sentence alone. */
  hintKey: string;
}

/**
 * Turn the server's answer into two dict keys and a fact.
 *
 * The split matters and is the whole reason this is not just printing
 * `webSearch.detail`. The server DECIDES the tier — one resolver, four
 * surfaces, no drift, which is the point of card 203. But the server's
 * sentence is English, and this page is bilingual, so rendering it verbatim
 * left a German reader with one English line in the middle of their settings.
 * Phrasing is not deciding: this function chooses words for a tier it was
 * handed, and cannot reach a different tier than the one it was given.
 *
 * An unknown tier (a newer server, an older bundle) falls back to the tier
 * name itself rather than to a guess — the badge then shows the bare word,
 * which is true, instead of a sentence about the wrong backend.
 *
 * @param tier       the tier name from /api/config
 * @param searxngUrl the saved instance address, used only by the searxng line
 * @returns the two keys and the address to interpolate
 */
export function tierReading(tier: string, searxngUrl: string): TierReading {
  const known = (WEB_SEARCH_TIERS as readonly string[]).includes(tier);
  if (!known) {
    return { labelKey: "", detailKey: "", addr: "", hintKey: "" };
  }
  return {
    labelKey: tier === "duckduckgo" ? "set.tierLabelScrape" : "",
    detailKey: `set.tier.${tier}`,
    addr: tier === "searxng" ? searxngUrl : "",
    hintKey: tier === "duckduckgo" ? "set.tierScrapeScript" : "",
  };
}

/**
 * The sentence the Settings tier line adds after the tier sentence, or "".
 *
 * <p>The scrape's sentence points to the setup script in the block below the
 * tier line, so it is shown only when that block offers the script, which is
 * when Docker is ready on this machine. With Docker absent, stopped or remote
 * the block offers something else, and a sentence about a script that is not
 * there would send the reader looking for it.</p>
 *
 * @param reading the tier line's reading
 * @param docker  the server's Docker status, or null before it answers
 * @returns the dict key, or ""
 */
export function tierHintKey(reading: TierReading, docker: DockerStatus | null | undefined): string {
  return reading.hintKey && searxngOffer(docker).kind === "run" ? reading.hintKey : "";
}

/** The `webSearch` block of /api/config as a READER needs it — the decision and
 *  the address, nothing more. `WebSearchStatus` in WebSearchSettings.tsx is the
 *  full block; this narrower shape exists so the calibration panel can be
 *  handed the raw config object it already holds without importing a settings
 *  page. Both fields are optional on purpose: a server older than card 203
 *  sends no block at all, and that is a state to report, not to crash on. */
export interface ServedWebSearch {
  tier?: string;
  searxngUrl?: string;
}

/** What the calibration panel needs in order to draw one row. */
export interface WebSearchCheck {
  /** The panel's dot. "warn" for the scrape — the same call the CLI's doctor
   *  makes with Kind.INFO, and for the same reason: it is not a fault, it is a
   *  state the operator should know they are in. */
  verdict: "ok" | "warn" | "error";
  /** Which of the four things the row is saying. */
  state: "pending" | "failed" | "absent" | "tier";
  /** The server's tier word, or "". Printed bare when the sentence is unknown. */
  tier: string;
  /** The sentence to render, as dict keys — empty keys for every non-tier state. */
  reading: TierReading;
}

const NO_READING: TierReading = { labelKey: "", detailKey: "", addr: "", hintKey: "" };

/**
 * Read the served answer for the calibration panel (card 223).
 *
 * <p>The panel drew eight rows and web search was not one of them, while
 * `/api/config` had been carrying tier, label, sentence and instance address
 * since card 203. Nothing was missing from the wire; nobody drew it.</p>
 *
 * <p>This function decides NOTHING about which tier is active. It is the third
 * reader of one server-side resolver, next to the settings block above and
 * `DoctorCommand.webSearchLine` on the CLI, and the only judgement it makes is
 * which dot colour a tier deserves. A `tier === "duckduckgo"` test is the same
 * comparison {@link tierReading} already makes two functions up; a rule about
 * keys or addresses would be the copy card 203 removed.</p>
 *
 * <p>Four states, because the panel has to tell them apart. `pending` is "not
 * asked yet" and must not read as broken; `failed` is the fetch itself; and
 * `absent` is a server too old to carry the block — the settings page stays
 * silent for that one, but silence is precisely the defect this card exists to
 * fix, so the doctor says it out loud.</p>
 *
 * @param config the parsed /api/config body, `null` before it lands, `"failed"`
 *               when the fetch did — the panel's own three-valued state
 * @returns the row
 */
export function webSearchCheck(config: { webSearch?: ServedWebSearch } | null | "failed"): WebSearchCheck {
  if (config === "failed") {
    return { verdict: "error", state: "failed", tier: "", reading: NO_READING };
  }
  if (config === null) {
    return { verdict: "ok", state: "pending", tier: "", reading: NO_READING };
  }
  const tier = config.webSearch?.tier ?? "";
  if (tier === "") {
    return { verdict: "warn", state: "absent", tier: "", reading: NO_READING };
  }
  return {
    verdict: tier === "duckduckgo" ? "warn" : "ok",
    state: "tier",
    tier,
    reading: tierReading(tier, config.webSearch?.searxngUrl ?? ""),
  };
}

/**
 * The calibration row's text, for a check and a language.
 *
 * <p><b>Why this is not four lines of JSX.</b> It was, and the review of card
 * 223 measured what that cost: two mutations of the expression — the whole
 * mapping replaced by the bare {@link WebSearchCheck.tier}, and the `{ addr }`
 * argument dropped from the `t()` call — each left the full web suite green at
 * 260 files and 3794 tests. The panel would have shipped reading `duckduckgo`,
 * or `searxng — a metasearch instance you run, at {addr}`, and criteria 2 and 3
 * are the two the card exists for. Rendering cannot catch <i>those two</i>: the
 * panel fetches in an effect, no server render runs effects, so the row's value
 * cell is `…` whatever this function returns. Moving the mapping here is what
 * makes it testable at all, and webSearchSetup.test.ts kills both mutations.</p>
 *
 * <p>That is as far as the argument goes, and the first version of it went
 * further and was wrong. It read "rendering cannot reach past pending here",
 * which the next review took to mean the panel could not be rendered at all —
 * so nothing asserted the row was ON the screen, and `checks.slice(0, 4)` in
 * DoctorPanel.tsx deleted it with the whole suite green. A static render emits
 * every `.doctor-row`; only the fetched VALUES are out of reach. The row's
 * presence is pinned by rendering in doctorPanel.drift.test.tsx, its wiring by
 * an equality on the source there, and its text by the tests below.</p>
 *
 * <p>Still a reader, not a decision: every branch below is a `state` the
 * function above already decided, and the sentence is a dict key that function
 * already chose. The one thing this adds is the interpolation, which is exactly
 * where the second mutation hid — `t()` passes an unfilled `{addr}` through to
 * the reader rather than throwing, so a missing argument is invisible until
 * somebody opens the panel.</p>
 *
 * @param check the read answer
 * @param lang  the reader's language
 * @return the string for the row's value cell
 */
export function webSearchRowValue(check: WebSearchCheck, lang: Lang): string {
  switch (check.state) {
    case "failed":
      return t(lang, "doc.unreachable");
    case "pending":
      return "…";
    case "absent":
      return t(lang, "doc.searchNone");
    default:
      // An unknown tier has no sentence, and its bare name is the true answer.
      return check.reading.detailKey
        ? t(lang, check.reading.detailKey, { addr: check.reading.addr })
        : check.tier;
  }
}

/**
 * Save the instance address on blur, then re-read the tier — in that order,
 * and only if the address actually changed.
 *
 * Why this is a function and not four lines in the component: the ORDER is the
 * whole content, and an order is testable while a rendered blur is not. The
 * first version fired the re-read from a `setTimeout(…, 0)` right after a save
 * whose promise nobody held, and a zero-millisecond macrotask cannot outrace an
 * HTTP round trip — so the line above the field kept describing the tier that
 * was active BEFORE the save, until something else reloaded the page. Awaiting
 * the save is not a nicety here: the server resolves the tier by reading the
 * settings file the save is still writing.
 *
 * A blur without an edit writes nothing at all. That matters beyond noise: the
 * field is prefilled from `effective`, which resolves the env layer, and since
 * the card-203 review that layer includes `~/.spectro/.env` — the file the
 * sample installer writes. An unconditional write on blur would copy the
 * installer's address into the settings document and quietly outrank it.
 *
 * @param raw    the field's current text
 * @param saved  the server-resolved address the field was prefilled with
 * @param save   writes the patch; may return a promise, which is awaited
 * @param reread re-reads /api/config so the tier line above the field is current
 * @returns whether a write was sent
 */
export async function commitSearxngUrl(
  raw: string,
  saved: string,
  save: (patch: Record<string, unknown>) => void | Promise<unknown>,
  reread: () => void | Promise<unknown>,
): Promise<boolean> {
  const next = raw.trim();
  if (next === saved.trim()) return false; // blur is not an edit
  await save({ searxngUrl: next === "" ? null : next });
  await reread();
  return true;
}
