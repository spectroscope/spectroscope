// The Copilot sign-in's client half (card 495): the status from
// GET /api/copilot/account and the three writes beside it. The writes post JSON,
// the only body the server's fence takes. A user code travels in a response
// body only, never in a URL.

import { t, type Lang } from "../i18n/i18n";

/** What GET /api/copilot/account answers. */
export type CopilotAccountStatus = {
  state: "NOT_SIGNED_IN" | "WAITING" | "SIGNED_IN" | "REFUSED";
  /** "github" or "cli", or null */
  method: string | null;
  login: string | null;
  /** The code to type, only while a sign-in waits. */
  userCode: string | null;
  /** The address to open, only while a sign-in waits. */
  verificationUri: string | null;
  /** Epoch second the code expires, 0 otherwise. */
  expiresAt: number;
  /** The last refusal or note, in the words it came in. */
  message: string | null;
  /** Whether spectroscope's own GitHub sign-in is configured. */
  github: boolean;
  /** Whether a Copilot CLI was found for its sign-in. */
  cli: boolean;
};

/** The three writes. */
export type CopilotAccountAction = "sign-in" | "cancel" | "sign-out";

/** Every dictionary key the sheet and the status line use. */
export const COPILOT_KEYS = [
  "cp.title",
  "cp.signedInAs",
  "cp.notSignedIn",
  "cp.waiting",
  "cp.viaGithub",
  "cp.viaCli",
  "cp.openAndEnter",
  "cp.afterConfirm",
  "cp.signInGithub",
  "cp.signInCli",
  "cp.noGithub",
  "cp.noCli",
  "cp.cancel",
  "cp.signOut",
  "cp.close",
  "cp.manage",
  "cp.unreachable",
  "cp.loading",
  "cp.readFailed",
  "cp.working",
  "cp.workingCli",
  "cp.signInOther",
  "cp.checkedOnRun",
  "cp.codeLabel",
] as const;

/** How often the sheet asks again while a sign-in waits. */
export const POLL_MS = 2000;

/** The longest wait between two reads after reads failed. */
export const POLL_MAX_MS = 10000;

/**
 * What the status line knows: undefined before the first answer, null when
 * the last read failed and nothing was known before, and how many reads in a
 * row failed.
 */
export type AccountNoteState = { status: CopilotAccountStatus | null | undefined; failures: number };

/**
 * @return the line the provider status shows: "Signed in as <login>", the
 *         waiting line, "Not signed in", or that it is reading or could not read
 */
export function accountLine(status: CopilotAccountStatus | null | undefined, lang: Lang): string {
  if (status === undefined) return t(lang, "cp.loading");
  if (status === null) return t(lang, "cp.unreachable");
  if (status.state === "SIGNED_IN" && status.login) return t(lang, "cp.signedInAs", { login: status.login });
  if (status.state === "WAITING") return t(lang, "cp.waiting");
  return t(lang, "cp.notSignedIn");
}

/**
 * @return the state after one read: a failed read keeps the last status, so a
 *         waiting sign-in goes on polling
 */
export function afterRead(prev: AccountNoteState, read: CopilotAccountStatus | null): AccountNoteState {
  if (read) return { status: read, failures: 0 };
  return { status: prev.status === undefined ? null : prev.status, failures: prev.failures + 1 };
}

/** @return the delay before the next status read, or null when nothing waits */
export function pollDelayMs(status: CopilotAccountStatus | null | undefined, failures = 0): number | null {
  if (status?.state !== "WAITING") return null;
  return Math.min(POLL_MS * (1 + failures), POLL_MAX_MS);
}

/** @return an address the sheet may link to: https only */
export function linkable(uri: string | null): string | null {
  return uri && /^https:\/\//i.test(uri) ? uri : null;
}

async function read(response: Response): Promise<CopilotAccountStatus | null> {
  if (!response.ok) return null;
  return (await response.json()) as CopilotAccountStatus;
}

/** @return the status, or null when the server refused or could not be reached */
export async function fetchCopilotAccount(
  fetchImpl: typeof fetch = fetch,
): Promise<CopilotAccountStatus | null> {
  try {
    return await read(await fetchImpl("/api/copilot/account"));
  } catch {
    return null;
  }
}

/** @return the status after the write, or null when it was refused or failed */
export async function postCopilotAccount(
  action: CopilotAccountAction,
  body: Record<string, string>,
  fetchImpl: typeof fetch = fetch,
): Promise<CopilotAccountStatus | null> {
  try {
    return await read(
      await fetchImpl(`/api/copilot/account/${action}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }),
    );
  } catch {
    return null;
  }
}

/**
 * How the Copilot CLI is installed, as the runtime lookup names it
 * (CopilotRuntime.INSTALL_LINE, card 497). The one spelling under src/; a
 * drift test holds it to the Java constant.
 */
export const COPILOT_INSTALL_LINE = "brew install --cask copilot-cli";

/**
 * Whether the signed-in state flipped between two statuses that were both
 * read: a sign-in or a sign-out happened. The first read and a failed read are
 * not changes, and neither is a wait starting.
 */
export function signInChanged(
  prev: CopilotAccountStatus | null | undefined,
  next: CopilotAccountStatus | null | undefined,
): boolean {
  if (!prev || !next) return false;
  return (prev.state === "SIGNED_IN") !== (next.state === "SIGNED_IN");
}

const signInListeners = new Set<() => void>();

/**
 * Hears every sign-in or sign-out made in a Copilot sheet, wherever the sheet
 * was opened (the model menu or the first-run sheet), so the app can read the
 * provider status again without a reload.
 *
 * @returns the unsubscribe
 */
export function onCopilotSignInChange(listener: () => void): () => void {
  signInListeners.add(listener);
  return () => {
    signInListeners.delete(listener);
  };
}

/** Tells every listener that a Copilot sign-in changed. */
export function notifyCopilotSignInChange(): void {
  for (const listener of [...signInListeners]) listener();
}
