// Card 458: a stored session opens with its history and a composer ready to
// type; there is no Resume button. What cannot be continued keeps the archive
// bar and says why in one line. Server renderer, no DOM.
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { RunEvent } from "../events";
import { initialState, reduceAll } from "../state/reducer";
import { Chat } from "./Chat";

const history: RunEvent[] = [
  { type: "run_start", runId: "r0", agentId: "main", prompt: "Hallo Welt", ts: 10 },
  { type: "text_delta", agentId: "main", text: "Hallo zurück", ts: 11 },
  { type: "run_end", runId: "r0", stopReason: "end_turn", ts: 12 },
];

function render(props: { continuable?: boolean; readOnlyNote?: string }): string {
  return renderToStaticMarkup(
    <Chat
      state={reduceAll(initialState, history)}
      liveView={false}
      onSend={() => {}}
      onReturnToLive={() => {}}
      sendClient={() => false}
      exportId="s-1"
      {...props}
    />,
  );
}

describe("a stored session on screen (card 458)", () => {
  it("shows its history above a composer with an input box, and no Resume button", () => {
    const html = render({ continuable: true });
    expect(html).toContain("Hallo Welt");
    expect(html).toContain("<textarea");
    expect(html).toContain('class="composer-inner');
    expect(html).not.toContain("archive-bar");
    expect(html).not.toContain("resume-btn");
    expect(html).not.toContain("Resume session");
  });

  it("keeps the archive bar for a session that cannot be continued, with the reason as its one line", () => {
    const html = render({ readOnlyNote: "Imported sessions are read-only." });
    expect(html).toContain("archive-bar");
    expect(html).toContain("Imported sessions are read-only.");
    expect(html).not.toContain("<textarea");
    expect(html).not.toContain("resume-btn");
  });
});
