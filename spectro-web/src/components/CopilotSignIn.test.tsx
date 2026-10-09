// Card 495: the sign-in sheet. Rendered on React's server renderer, one
// state at a time: the code and the address while it waits, "signed in as"
// after, and a refusal in the words it came in.

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { dict } from "../i18n/i18n";
import { CopilotSignInSheet } from "./CopilotSignIn";
import type { CopilotAccountStatus } from "./copilotAccount";

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

const noop = (): void => undefined;

function sheet(status: CopilotAccountStatus | null, lang: "en" | "de" = "en"): string {
  return renderToStaticMarkup(
    <CopilotSignInSheet
      status={status}
      lang={lang}
      busy={false}
      onSignIn={noop}
      onCancel={noop}
      onSignOut={noop}
      onClose={noop}
    />,
  );
}

describe("the sign-in sheet", () => {
  it("shows the code and opens the address in a new tab while it waits", () => {
    const html = sheet({
      ...base,
      state: "WAITING",
      method: "github",
      userCode: "WXYZ-9876",
      verificationUri: "https://github.com/login/device",
      expiresAt: 1_800_000_900,
    });
    expect(html).toContain("WXYZ-9876");
    expect(html).toContain('href="https://github.com/login/device"');
    expect(html).toContain('target="_blank"');
    expect(html).toContain('rel="noopener noreferrer"');
    expect(html).not.toMatch(/href="[^"]*WXYZ/);
    expect(html).toContain(dict["cp.cancel"].en);
  });

  it("does not make a link of an address that is not https", () => {
    const html = sheet({
      ...base,
      state: "WAITING",
      method: "cli",
      userCode: "WXYZ-9876",
      verificationUri: "javascript:alert(1)",
    });
    expect(html).not.toContain("href=");
    expect(html).toContain("WXYZ-9876");
  });

  it("says signed in as the login, with the way in and a sign-out", () => {
    const html = sheet({ ...base, state: "SIGNED_IN", method: "cli", login: "octo-fixture" });
    expect(html).toContain("Signed in as octo-fixture");
    expect(html).toContain(dict["cp.viaCli"].en);
    expect(html).toContain(dict["cp.signOut"].en);
    expect(html).not.toContain(dict["cp.signInGithub"].en);
  });

  it("speaks German too", () => {
    const html = sheet({ ...base, state: "SIGNED_IN", method: "github", login: "octo-fixture" }, "de");
    expect(html).toContain("Angemeldet als octo-fixture");
    expect(html).toContain(dict["cp.viaGithub"].de);
  });

  it("reports a refusal in the words it came in, as an alert", () => {
    const html = sheet({ ...base, state: "REFUSED", message: "The authorization request was denied." });
    expect(html).toContain('role="alert"');
    expect(html).toContain("The authorization request was denied.");
    expect(html).toContain(dict["cp.signInGithub"].en);
  });

  it("offers each way in only when it exists, and says why not", () => {
    const html = sheet({ ...base, github: false, cli: true });
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Sign in with GitHub<\/button>/);
    expect(html).toContain(dict["cp.noGithub"].en);
    expect(html).toMatch(/<button(?![^>]*disabled)[^>]*>Use the Copilot CLI sign-in<\/button>/);
  });

  it("says so when the status could not be read", () => {
    expect(sheet(null)).toContain(dict["cp.unreachable"].en);
  });
});
