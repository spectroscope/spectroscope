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
] as const;

/** How often the sheet asks again while a sign-in waits. */
export const POLL_MS = 2000;

/**
 * @return the line the provider status shows: "Signed in as <login>", the
 *         waiting line, or "Not signed in"
 */
export function accountLine(status: CopilotAccountStatus | null, lang: Lang): string {
  if (status?.state === "SIGNED_IN" && status.login) return t(lang, "cp.signedInAs", { login: status.login });
  if (status?.state === "WAITING") return t(lang, "cp.waiting");
  return t(lang, "cp.notSignedIn");
}

/** @return the delay before the next status read, or null when nothing waits */
export function pollDelayMs(status: CopilotAccountStatus | null): number | null {
  return status?.state === "WAITING" ? POLL_MS : null;
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
