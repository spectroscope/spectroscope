// What the Web search settings block offers, and whether the thing it offers
// exists (card 203).
//
// The assertion that earns this file is the last one. Criterion 7 of the card
// says the snippet passes a PASTE test, not a review: a command that yields a
// browsable SearXNG the product cannot query is a failure, not a near miss.
// The paste itself was run against a real Docker daemon; what a test can hold
// afterwards is that the command still names a script this repository ships,
// and that the script still contains the one line the whole exercise is about.

import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { DockerStatus } from "./dockerOffer";
import { SEARXNG_INSTALL_COMMAND, SEARXNG_SAMPLE_PATH, searxngOffer } from "./webSearchSetup";

const status = (over: Partial<DockerStatus>): DockerStatus => ({
  docker: "ready",
  compose: true,
  remote: false,
  detail: "",
  ...over,
});

const sample = (name: string): string =>
  fileURLToPath(new URL(`../../../${SEARXNG_SAMPLE_PATH}/${name}`, import.meta.url));

describe("searxngOffer", () => {
  it("hands over the command only when the daemon answers", () => {
    expect(searxngOffer(status({ docker: "ready" })).kind).toBe("run");
    expect(searxngOffer(status({ docker: "ready" })).command).toBe(SEARXNG_INSTALL_COMMAND);
    expect(searxngOffer(status({ docker: "unreachable" })).command).toBeUndefined();
    expect(searxngOffer(status({ docker: "absent" })).command).toBeUndefined();
    expect(searxngOffer(null).command).toBeUndefined();
  });

  it("says SearXNG rather than Langfuse in the two states that name a stack", () => {
    // The state machine is shared with the Observability block on purpose —
    // "is Docker usable here" has one answer per machine, and a second copy of
    // that reasoning would be a second thing to get wrong. What must NOT be
    // shared is the sentence: this block is not offering Langfuse.
    const ready = searxngOffer(status({ docker: "ready" }));
    const absent = searxngOffer(status({ docker: "absent" }));
    expect(ready.messageKey).toBe("set.searxngDockerReady");
    expect(absent.messageKey).toBe("set.searxngDockerAbsent");
    expect(absent.href).toBeDefined();
  });

  it("keeps the shared decisions it does not override", () => {
    expect(searxngOffer(status({ docker: "unreachable" })).kind).toBe("start");
    expect(searxngOffer(status({ docker: "ready", compose: false })).kind).toBe("compose");
    expect(searxngOffer(status({ docker: "ready", remote: true })).kind).toBe("remote");
    expect(searxngOffer(null).kind).toBe("unknown");
  });

  it("the offered command starts the instance and nothing else", () => {
    expect(SEARXNG_INSTALL_COMMAND).toContain(SEARXNG_SAMPLE_PATH);
    expect(SEARXNG_INSTALL_COMMAND).toContain("./install.sh");
    expect(SEARXNG_INSTALL_COMMAND).not.toContain("sudo");
    expect(SEARXNG_INSTALL_COMMAND).not.toContain("| sh");
  });

  it("the command names a setup this repository actually ships, and it turns json on", () => {
    // The drift gate. A command is a promise about a file, so the file is read
    // off the tree this bundle is built from — and read for the ONE line that
    // separates a working paste from a browsable instance the product cannot
    // query. Stock SearXNG answers 403 to format=json until "json" is listed
    // under search.formats; measured against the real image on 2026-08-13.
    expect(existsSync(sample("install.sh"))).toBe(true);
    expect(existsSync(sample("docker-compose.yml"))).toBe(true);

    const installer = readFileSync(sample("install.sh"), "utf8");
    expect(installer.startsWith("#!")).toBe(true);
    expect(installer).toContain("docker compose");
    expect(installer).toContain("formats:");
    expect(installer).toMatch(/^\s*-\s*json\s*$/m);
    // It also has to WAIT for the format to answer, not for the port to open:
    // an instance with json off answers instantly, with 403.
    expect(installer).toContain("format=json");
    // And it hands the address over the way the Langfuse installer does.
    expect(installer).toContain("SPECTRO_SEARXNG_URL");
  });
});
