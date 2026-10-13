// Card 554, criterion 4: the header's play button writes /run-with-playbook
// into the composer of the session in view and starts nothing. The button
// and the composer do not know each other; this store carries the text from
// one to the other. Each request has its own number, so the same text asked
// for twice is two requests, and the composer takes a request once.

import { afterEach, describe, expect, it } from "vitest";
import { __resetComposerPrefill, currentPrefill, prefillComposer, takePrefill } from "./composerPrefill";

afterEach(() => {
  __resetComposerPrefill();
});

describe("the composer prefill", () => {
  it("holds nothing until something asks", () => {
    expect(currentPrefill()).toBeNull();
  });

  it("holds the text asked for, with a number of its own", () => {
    prefillComposer("/run-with-playbook ");
    const first = currentPrefill();
    expect(first?.text).toBe("/run-with-playbook ");
    prefillComposer("/run-with-playbook ");
    expect(currentPrefill()?.nonce).toBeGreaterThan(first?.nonce ?? 0);
  });

  it("is taken once: taking the request in hand clears it", () => {
    prefillComposer("/run-with-playbook ");
    const request = currentPrefill();
    takePrefill(request?.nonce ?? -1);
    expect(currentPrefill()).toBeNull();
  });

  it("keeps a newer request when an older one is taken", () => {
    prefillComposer("a");
    const older = currentPrefill()?.nonce ?? -1;
    prefillComposer("b");
    takePrefill(older);
    expect(currentPrefill()?.text).toBe("b");
  });
});
