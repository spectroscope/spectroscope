// Card 495, final round: the Copilot CLI's device flow is the sign-in 0.15.0
// ships. The sheet shows the code and the address while the CLI waits, polls
// until the runtime reports the sign-in, then says "Signed in as <login>".
// Closing the sheet while it waits cancels the flow. After a refused run the
// sheet offers Sign out. The app's own GitHub sign-in stays in the code for
// card 500 and is not offered.
//
// renderToStaticMarkup and plain functions: the suite runs in plain Node.

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { dict } from "../i18n/i18n";
import { CopilotSignInSheet } from "./CopilotSignIn";
import {
  accountLine,
  afterRead,
  APP_SIGN_IN_OFFERED,
  closeSheet,
  pollDelayMs,
  signInChanged,
  type AccountNoteState,
  type CopilotAccountAction,
  type CopilotAccountStatus,
} from "./copilotAccount";
import { read, stripComments } from "../testkit/source";

const base: CopilotAccountStatus = {
  state: "NOT_SIGNED_IN",
  method: null,
  login: null,
  userCode: null,
  verificationUri: null,
  expiresAt: 0,
  message: null,
  github: true,
  cli: true,
};

const waiting: CopilotAccountStatus = {
  ...base,
  state: "WAITING",
  method: "cli",
  userCode: "2B8A-BAC6",
  verificationUri: "https://github.com/login/device",
  expiresAt: 1_800_000_900,
};

const signedIn: CopilotAccountStatus = { ...base, state: "SIGNED_IN", method: "cli", login: "octo-fixture" };

const noop = (): void => undefined;

function sheet(status: CopilotAccountStatus): string {
  return renderToStaticMarkup(
    <CopilotSignInSheet
      status={status}
      lang="en"
      busy={null}
      readFailed={false}
      onSignIn={noop}
      onCancel={noop}
      onSignOut={noop}
      onClose={noop}
    />,
  );
}

describe("the confirmed code turns into Signed in as", () => {
  it("shows the code and the address while the CLI waits, and keeps polling", () => {
    const state = afterRead({ status: undefined, failures: 0 }, waiting);
    expect(accountLine(state.status, "en")).toBe(dict["cp.waiting"].en);
    expect(pollDelayMs(state.status, state.failures)).toBe(2000);
    const html = sheet(waiting);
    expect(html).toContain("2B8A-BAC6");
    expect(html).toContain('href="https://github.com/login/device"');
    expect(html).not.toContain("Signed in as");
  });

  it("says Signed in as the login on the first read after the browser confirmed it, and stops polling", () => {
    const before: AccountNoteState = { status: waiting, failures: 0 };
    const after = afterRead(before, signedIn);
    expect(accountLine(after.status, "en")).toBe("Signed in as octo-fixture");
    expect(pollDelayMs(after.status, after.failures)).toBeNull();
    expect(signInChanged(before.status, after.status)).toBe(true);
    const html = sheet(signedIn);
    expect(html).toContain("Signed in as octo-fixture");
    expect(html).not.toContain("2B8A-BAC6");
    expect(html).toContain(dict["cp.signOut"].en);
  });
});

describe("closing the sheet", () => {
  const closing = (status: CopilotAccountStatus | null | undefined): CopilotAccountAction[] => {
    const acts: CopilotAccountAction[] = [];
    closeSheet(status, (action) => acts.push(action));
    return acts;
  };

  it("cancels a flow that waits", () => {
    expect(closing(waiting)).toEqual(["cancel"]);
  });

  it("cancels nothing when nothing waits", () => {
    expect(closing(signedIn)).toEqual([]);
    expect(closing(base)).toEqual([]);
    expect(closing(null)).toEqual([]);
    expect(closing(undefined)).toEqual([]);
  });

  it("is what the status line's sheet runs on close", () => {
    const note = stripComments(read("./CopilotSignIn.tsx", import.meta.url));
    expect(note).toMatch(
      /onClose=\{\(\) => \{\s*closeSheet\(note\.status, act\);\s*setOpen\(false\);\s*\}\}/,
    );
  });
});

describe("after a refused run", () => {
  it("the sheet offers Sign out while the choice is stored", () => {
    const html = sheet({ ...base, state: "REFUSED", method: "cli", message: "You have no Copilot seat." });
    expect(html).toContain("You have no Copilot seat.");
    expect(html).toContain(dict["cp.signOut"].en);
  });

  it("and offers none when nothing is stored", () => {
    expect(sheet({ ...base, state: "REFUSED", method: null, message: "Login failed." })).not.toContain(
      dict["cp.signOut"].en,
    );
  });
});

describe("the app's own GitHub sign-in", () => {
  it("is not offered in 0.15.0, even when an OAuth app is configured", () => {
    expect(APP_SIGN_IN_OFFERED).toBe(false);
    for (const status of [base, signedIn, { ...base, state: "REFUSED" as const, message: "x" }]) {
      const html = sheet({ ...status, github: true });
      expect(html).not.toContain(dict["cp.signInGithub"].en);
      expect(html).not.toContain(dict["cp.signInOther"].en);
      expect(html).not.toContain(dict["cp.noGithub"].en);
    }
  });

  it("the CLI sign-in is offered in its place", () => {
    expect(sheet(base)).toMatch(/<button(?![^>]*disabled)[^>]*>Use the Copilot CLI sign-in<\/button>/);
  });
});
