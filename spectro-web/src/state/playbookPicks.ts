// Card 584: the model picks of the start sheet, decided without a renderer.
//
// The server checks every provider's model list before the sheet opens and
// sends, per node that runs on a model, whether one serves and why not
// (StartPreview.models), and the models of every provider whose list answered
// (StartPreview.offers). A row serves when the server says so, or when the
// owner picked a model from one of those lists; a private row is offered
// local providers only. A pick holds for this run only: Start sends the picks
// that serve and differ from the playbook's model, and the server checks them
// again. Pure: the sheet translates the keys.

import type { ModelCheck, ModelOffer, StartPreview } from "./playbookRuns";

/** One model picked for a row. */
export interface Pick {
  provider: string;
  model: string;
}

/** The picks of one sheet, by node id. */
export type Picks = Record<string, Pick>;

/** One line of a row's reason, as a dictionary key and its slots. */
export interface ReasonLine {
  key: string;
  vars: Record<string, string>;
}

/**
 * The providers a row may pick from: every one whose list answered; for a
 * private row local ones only, without their cloud models.
 *
 * @param check the row
 * @param offers the providers whose list answered
 */
export function offersFor(check: ModelCheck, offers: ModelOffer[]): ModelOffer[] {
  if (check.privacy !== "private") return offers;
  return offers
    .filter((o) => o.kind === "local")
    .map((o) => ({ ...o, models: o.models.filter((m) => !cloudModel(o.provider, m)) }))
    .filter((o) => o.models.length > 0);
}

/**
 * Fix round (review D2): Ollama is a local server, but it forwards a model
 * whose tag is cloud or ends in -cloud (minimax-m3:cloud, gpt-oss:120b-cloud)
 * to its cloud. Such a model counts as cloud for a private row; the server
 * holds the same rule (ModelResolver.cloudModel).
 */
export function cloudModel(provider: string, model: string): boolean {
  if (provider !== "ollama") return false;
  const colon = model.lastIndexOf(":");
  const tag = colon < 0 ? "" : model.slice(colon + 1);
  return tag === "cloud" || tag.endsWith("-cloud");
}

/** The option value of a pick; "" is the playbook's default. A provider name never holds a bar. */
export function pickValue(pick: Pick | undefined): string {
  return pick === undefined ? "" : `${pick.provider}|${pick.model}`;
}

/** The pick an option value names, or null for the default or a value that does not read. */
export function parsePickValue(value: string): Pick | null {
  const bar = value.indexOf("|");
  if (bar <= 0 || bar === value.length - 1) return null;
  return { provider: value.slice(0, bar), model: value.slice(bar + 1) };
}

/** Whether a pick is in a list that answered and is offered to the row. */
function offered(check: ModelCheck, pick: Pick, offers: ModelOffer[]): boolean {
  return offersFor(check, offers).some((o) => o.provider === pick.provider && o.models.includes(pick.model));
}

/**
 * Whether a row has a model that serves: its pick when it has one, else the
 * server's answer.
 *
 * @param check the row
 * @param pick the row's pick, if any
 * @param offers the providers whose list answered
 */
export function rowServes(check: ModelCheck, pick: Pick | undefined, offers: ModelOffer[]): boolean {
  return pick === undefined ? check.serves : offered(check, pick, offers);
}

/**
 * The rows that keep Start disabled, in node order. A server without model
 * rows blocks nothing here; its refusals still do.
 *
 * @param preview the sheet's preview
 * @param picks the picks so far
 */
export function blockingRows(preview: StartPreview, picks: Picks): ModelCheck[] {
  const offers = preview.offers ?? [];
  return (preview.models ?? []).filter((m) => !rowServes(m, picks[m.node], offers));
}

/**
 * The picks after a choice in a row's picker. The default, or the playbook's
 * own model, clears the row's pick; a value that is not offered to the row
 * changes nothing.
 *
 * @param picks the picks so far
 * @param check the row
 * @param value the chosen option value
 * @param offers the providers whose list answered
 */
export function applyPick(picks: Picks, check: ModelCheck, value: string, offers: ModelOffer[]): Picks {
  const pick = parsePickValue(value);
  const rest = Object.fromEntries(Object.entries(picks).filter(([node]) => node !== check.node));
  if (pick === null || (pick.provider === check.provider && pick.model === check.model)) return rest;
  if (!offered(check, pick, offers)) return picks;
  return { ...rest, [check.node]: pick };
}

/**
 * What Start sends: the picks of rows of this preview that serve.
 *
 * @param preview the sheet's preview
 * @param picks the picks so far
 */
export function startPicks(preview: StartPreview, picks: Picks): Picks {
  const offers = preview.offers ?? [];
  const out: Picks = {};
  for (const m of preview.models ?? []) {
    const pick = picks[m.node];
    if (pick !== undefined && offered(m, pick, offers)) out[m.node] = pick;
  }
  return out;
}

/** The dictionary key of each reason word the server sends; an http-<status> word has its own. */
const REASON_KEY: Record<string, string> = {
  "rejected-key": "pb.run.why.rejectedKey",
  refused: "pb.run.why.refused",
  timeout: "pb.run.why.timeout",
  "bad-answer": "pb.run.why.badAnswer",
  "not-listed": "pb.run.why.notListed",
  "private-on-cloud": "pb.run.why.privateOnCloud",
  "needs-key": "pb.run.why.needsKey",
  "no-key": "pb.run.why.needsKey",
  "needs-signin": "pb.run.why.needsSignin",
  "needs-download": "pb.run.why.needsDownload",
  unknown: "pb.run.why.unknown",
  configured: "pb.run.why.notChecked",
  // Fix round (review N6): a check that did not come back, or broke off.
  "check-timeout": "pb.run.why.checkTimeout",
  "check-error": "pb.run.why.checkError",
};

/** Where a rejected key came from, in words. */
const KEY_SOURCE_KEY: Record<string, string> = {
  environment: "pb.run.keyFrom.environment",
  saved: "pb.run.keyFrom.saved",
};

/**
 * What a row says about its model: why the playbook's model does not serve,
 * with the HTTP status and the key's source for a rejected key, or the
 * fallback that serves in its place. Nothing for a row whose model serves.
 *
 * @param check the row
 */
export function reasonLines(check: ModelCheck): ReasonLine[] {
  const { provider, model } = check;
  if (check.serves || check.reason === null) {
    return check.viaProvider !== null && check.viaModel !== null
      ? [{ key: "pb.run.via", vars: { provider: check.viaProvider, model: check.viaModel } }]
      : [];
  }
  const reason = check.reason;
  const http = /^http-(\d{3})$/.exec(reason);
  if (http !== null) {
    return [{ key: "pb.run.why.http", vars: { provider, status: String(check.httpStatus ?? http[1]) } }];
  }
  if (reason === "rejected-key") {
    const lines: ReasonLine[] = [
      check.httpStatus === null
        ? { key: "pb.run.why.rejectedKeyBare", vars: { provider } }
        : { key: REASON_KEY[reason], vars: { provider, status: String(check.httpStatus) } },
    ];
    const source = check.keySource === null ? undefined : KEY_SOURCE_KEY[check.keySource];
    if (source !== undefined) lines.push({ key: source, vars: {} });
    return lines;
  }
  const key = REASON_KEY[reason];
  return [
    key === undefined
      ? { key: "pb.run.why.other", vars: { provider, reason } }
      : { key, vars: { provider, model } },
  ];
}
