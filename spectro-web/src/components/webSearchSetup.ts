// What the Web search settings block offers once /api/docker/status has
// answered (card 203). Pure on purpose, exactly like dockerOffer next door:
// the decision is the part worth pinning, and the command is a promise about a
// file that has to keep existing.
//
// spectroscope never runs any of this. The app prints a command; the operator
// reads it and runs it. Same asymmetry, same reason: a process that can reach
// the Docker socket can bind-mount any host path into a container.

import { dockerOffer, type DockerOffer, type DockerStatus } from "./dockerOffer";

/** The shipped setup, relative to the repository root. Pinned here because the
 *  command below is only true while this path exists; webSearchSetup.test.ts
 *  reads it off disk so a moved sample fails the suite instead of the user. */
export const SEARXNG_SAMPLE_PATH = "samples/09-searxng";

/**
 * The command handed to an operator whose daemon is ready.
 *
 * <p>It is not a `docker run` line, and it cannot be one. Stock SearXNG lists
 * only `html` under `search.formats` and answers HTTP 403 to every request for
 * a format that is not on that list — so the obvious one-liner produces a
 * perfectly good search page and an API that hands this product nothing back
 * (measured against the real image, 2026-08-13). The shipped installer writes
 * the settings file that turns `json` on, generates the instance's secret key,
 * and then waits for a real `format=json` query to come back with results
 * rather than for the port to open.</p>
 *
 * <p>Same shape as the Langfuse offer beside it, deliberately: the operator
 * gets a repository they can read before anything executes, and the script they
 * run is the same file the drift test here asserts against.</p>
 */
export const SEARXNG_INSTALL_COMMAND = [
  "git clone --depth 1 https://github.com/spectroscope/spectroscope.git",
  `cd spectroscope/${SEARXNG_SAMPLE_PATH} && ./install.sh`,
].join("\n");

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
 * @returns the offer; `href` only for "install", `command` only for "run"
 */
export function searxngOffer(status: DockerStatus | null | undefined): DockerOffer {
  const shared = dockerOffer(status);
  if (shared.kind === "run") {
    return { ...shared, messageKey: "set.searxngDockerReady", command: SEARXNG_INSTALL_COMMAND };
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
    return { labelKey: "", detailKey: "", addr: "" };
  }
  return {
    labelKey: tier === "duckduckgo" ? "set.tierLabelScrape" : "",
    detailKey: `set.tier.${tier}`,
    addr: tier === "searxng" ? searxngUrl : "",
  };
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

const NO_READING: TierReading = { labelKey: "", detailKey: "", addr: "" };

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
