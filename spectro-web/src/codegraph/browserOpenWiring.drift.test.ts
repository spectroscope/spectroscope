// Card 472: the "Graph ready" chip leaves its ask in the browserOpen store,
// and the browser segment is the one that takes it and sends the
// open_code_graph frame, both when its view socket opens and when a request
// arrives while it is already open. The server mints the one-shot ticket and
// builds the address on its own port, so no page source builds it. There is
// no DOM in this suite, so the wiring is read at the source.

import { describe, expect, it } from "vitest";
import { read, stripComments } from "../testkit/source";

const segment = stripComments(read("../browser/BrowserSegment.tsx", import.meta.url));

describe("the browser segment takes the open request", () => {
  it("when its view socket opens", () => {
    const onopen = segment.slice(segment.indexOf("socket.onopen"), segment.indexOf("socket.onmessage"));
    expect(onopen).toMatch(/takeCodeGraphOpen\(sessionId\)/);
    expect(onopen).toMatch(/openCodeGraphFrame\(sessionId\)/);
  });

  it("when a request arrives while the socket is open", () => {
    expect(segment).toMatch(/useBrowserOpenRequest\(\)/);
    const effect =
      /useEffect\(\(\) => \{[^}]*?takeCodeGraphOpen\(sessionId\)[\s\S]*?\}, \[openRequest, sessionId\]\);/.exec(
        segment,
      );
    expect(effect, "no effect keyed on the request takes it").not.toBeNull();
  });
});

describe("the page never builds the code graph address", () => {
  it("leaves the view path and the ticket to the server", () => {
    for (const file of [
      "./codeGraphModel.ts",
      "./CodeGraphHeaderStatus.tsx",
      "./CodeGraphHost.tsx",
      "../state/browserOpen.ts",
      "../browser/BrowserSegment.tsx",
    ]) {
      const source = stripComments(read(file, import.meta.url));
      expect(source, file).not.toContain("/api/codegraph/view");
      expect(source, file).not.toMatch(/ticket=/);
    }
  });
});

describe("the app asks about a stored session too", () => {
  it("hands the host the session codeGraphSessionOf picks", () => {
    const app = stripComments(read("../App.tsx", import.meta.url));
    expect(app).toMatch(
      /const codeGraphSession = codeGraphSessionOf\(\s*viewingLive,\s*view\.workspace\?\.sessionId \?\? null,\s*replay\?\.id \?\? null,?\s*\);/,
    );
    expect(app).toMatch(/<CodeGraphHost sessionId=\{codeGraphSession\} \/>/);
  });
});
