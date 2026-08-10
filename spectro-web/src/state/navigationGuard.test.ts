// The desktop shell's navigation seatbelt, tested from here for the reason
// portMemory and cacheRecovery are: the decision is arithmetic on a URL, it must
// not need Electron to run, and spectro-desktop has no test runner of its own.

import { describe, expect, it } from "vitest";
import { allowsNavigation } from "../../../spectro-desktop/src/navigationGuard";

/** The window is loaded from the loopback server on a port picked at runtime. */
const HOME = "http://127.0.0.1:63171";

describe("what the desktop window is allowed to navigate to", () => {
  it("allows the page it was loaded from", () => {
    expect(allowsNavigation(HOME, `${HOME}/`)).toBe(true);
    expect(allowsNavigation(HOME, `${HOME}/#/settings/stt`)).toBe(true);
    expect(allowsNavigation(HOME, `${HOME}/assets/index-abc.js`)).toBe(true);
  });

  it("refuses a different port on the same host", () => {
    // The shell remembers its port across launches (card 168). Another server on
    // another port is another application, and it is not this one.
    expect(allowsNavigation(HOME, "http://127.0.0.1:8080/")).toBe(false);
  });

  it("refuses the open web outright", () => {
    // setWindowOpenHandler already sends http(s) targets to the real browser,
    // but it only covers window.open and target=_blank. A same-window
    // navigation — location.href = …, or a plain link with no target — walks
    // straight past it, and lands the whole app on somebody else's page with no
    // address bar to notice it by.
    expect(allowsNavigation(HOME, "https://example.com/")).toBe(false);
    expect(allowsNavigation(HOME, "http://evil.example.com/")).toBe(false);
  });

  it("refuses the schemes that are not navigation at all", () => {
    // javascript: is defused at markdown parse time and React 19 blocks it
    // besides, so this is depth rather than a live hole — which is exactly what
    // a seatbelt is. file: is the one that would read the user's disk.
    for (const url of [
      "javascript:alert(1)",
      "file:///etc/passwd",
      "data:text/html,<script>alert(1)</script>",
      "about:blank",
    ]) {
      expect(allowsNavigation(HOME, url), url).toBe(false);
    }
  });

  it("refuses a URL it cannot even parse rather than waving it through", () => {
    // The safe side of an unreadable input is "no". A guard that fails open is
    // not a guard.
    expect(allowsNavigation(HOME, "http://[not a url")).toBe(false);
    expect(allowsNavigation(HOME, "")).toBe(false);
  });

  it("refuses everything when it does not know where home is", () => {
    // Before the window has loaded, there is no origin to compare against, and
    // "allow anything until we know" is how seatbelts become decoration.
    expect(allowsNavigation(null, `${HOME}/`)).toBe(false);
  });

  it("is not fooled by a host that merely starts the same way", () => {
    // The classic prefix bug: 127.0.0.1.evil.com starts with the home host.
    expect(allowsNavigation(HOME, "http://127.0.0.1.evil.com/")).toBe(false);
    expect(allowsNavigation("http://localhost:63171", "http://localhost.evil.com/")).toBe(false);
  });
});
