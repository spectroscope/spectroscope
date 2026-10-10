// Card 495: the sign-in sheet. Rendered on React's server renderer, one
// state at a time: the code and the address while it waits, "signed in as"
// after, and a refusal in the words it came in.

import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
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

function sheet(
  status: CopilotAccountStatus | null | undefined,
  lang: "en" | "de" = "en",
  extra: { busy?: "cli" | "other" | null; readFailed?: boolean } = {},
): string {
  return renderToStaticMarkup(
    <CopilotSignInSheet
      status={status}
      lang={lang}
      busy={extra.busy ?? null}
      readFailed={extra.readFailed ?? false}
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
    expect(html).not.toContain(dict["cp.signInCli"].en);
  });

  it("offers the CLI sign-in while signed in the app's own way, which 0.15.0 no longer offers", () => {
    // Final round, decision 2: the app's own GitHub sign-in waits for card 500 and is hidden.
    const github = sheet({ ...base, state: "SIGNED_IN", method: "github", login: "octo-fixture" });
    expect(github).toContain(dict["cp.signInCli"].en);
    expect(github).toContain(dict["cp.checkedOnRun"].en);
    expect(github).not.toContain(dict["cp.signInOther"].en);
    const cli = sheet({ ...base, state: "SIGNED_IN", method: "cli", login: "octo-fixture" });
    expect(cli).not.toContain(dict["cp.signInGithub"].en);
  });

  it("names the code for a screen reader by its content, not by a label over it", () => {
    const html = sheet({
      ...base,
      state: "WAITING",
      method: "github",
      userCode: "WXYZ-9876",
      verificationUri: "https://github.com/login/device",
    });
    expect(html).toMatch(/<code[^>]*class="cp-code[^"]*"[^>]*>WXYZ-9876<\/code>/);
    expect(html).not.toMatch(/aria-label="[^"]*"[^>]*>WXYZ-9876/);
    expect(html).toContain(dict["cp.codeLabel"].en);
  });

  it("says what it is doing while a sign-in call runs", () => {
    const html = sheet(base, "en", { busy: "cli" });
    expect(html).toMatch(/role="status"[^>]*>[^<]*Copilot CLI/);
    expect(html).toContain(dict["cp.workingCli"].en);
    expect(sheet(base, "en", { busy: "other" })).toContain(dict["cp.working"].en);
  });

  it("keeps the code on screen when one status read failed while it waits", () => {
    const html = sheet(
      {
        ...base,
        state: "WAITING",
        method: "github",
        userCode: "WXYZ-9876",
        verificationUri: "https://github.com/login/device",
      },
      "en",
      { readFailed: true },
    );
    expect(html).toContain("WXYZ-9876");
    expect(html).toContain(dict["cp.readFailed"].en);
  });

  it("says it is reading before the first answer and offers nothing yet", () => {
    const html = sheet(undefined);
    expect(html).toContain(dict["cp.loading"].en);
    expect(html).not.toContain(dict["cp.signInGithub"].en);
    expect(html).not.toContain(dict["cp.unreachable"].en);
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
    expect(html).toContain(dict["cp.signInCli"].en);
  });

  it("offers the CLI sign-in only when a CLI exists, and says why not", () => {
    const html = sheet({ ...base, github: false, cli: true });
    expect(html).not.toContain("Sign in with GitHub");
    expect(html).not.toContain(dict["cp.noGithub"].en);
    expect(html).toMatch(/<button(?![^>]*disabled)[^>]*>Use the Copilot CLI sign-in<\/button>/);
    const none = sheet({ ...base, github: true, cli: false });
    expect(none).toMatch(/<button[^>]*disabled=""[^>]*>Use the Copilot CLI sign-in<\/button>/);
    expect(none).toContain(dict["cp.noCli"].en);
  });

  it("says so when the status could not be read", () => {
    expect(sheet(null)).toContain(dict["cp.unreachable"].en);
  });
});

describe("where the sheet is mounted", () => {
  // Measured on 2026-10-10 in the branch jar: rendered inside the provider
  // popover, the backdrop covered only the chat column (the corners of the
  // window hit the sidebar, the header and the footer). The sheet now goes to
  // document.body, and its mouse and key events stop there, so the popover's
  // outside click and Escape handlers on window do not unmount it.
  const source = readFileSync(fileURLToPath(new URL("./CopilotSignIn.tsx", import.meta.url)), "utf8");

  it("is portalled to the document body", () => {
    expect(source).toMatch(/createPortal\(\s*<CopilotSignInSheet[\s\S]*?document\.body\s*,?\s*\)/);
  });

  it("keeps its mouse downs and key presses from reaching the popover's window listeners", () => {
    expect(source).toMatch(/onMouseDown=\{\(e\) => e\.stopPropagation\(\)\}/);
    expect(source).toMatch(/onKeyDown=\{/);
    expect(source).toMatch(/e\.key === "Escape"/);
  });
});

describe("the sheet's styles", () => {
  it("has a rule for every cp- class the sheet uses", () => {
    const source = readFileSync(fileURLToPath(new URL("./CopilotSignIn.tsx", import.meta.url)), "utf8");
    const used = [...new Set([...source.matchAll(/\bcp-[a-z-]+/g)].map((m) => m[0]))].filter(
      (name) => name !== "cp-title",
    );
    expect(used.length).toBeGreaterThanOrEqual(3);
    const dir = fileURLToPath(new URL("../styles/", import.meta.url));
    const css = readdirSync(dir)
      .filter((f) => f.endsWith(".css"))
      .map((f) => readFileSync(dir + f, "utf8"))
      .join("\n")
      .replace(/\/\*[\s\S]*?\*\//g, "");
    for (const name of used) {
      expect(css, name).toMatch(new RegExp(`\\.${name}(?![a-z-])[^{]*\\{`));
    }
  });
});
