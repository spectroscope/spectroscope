// Card 459, owner call 2: deleting a session that still runs asks "stop it
// and delete?" instead of deleting a live run silently.
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { SessionDeleteDialogBody } from "./SessionDeleteDialog";

const body = (running: boolean, lang: "en" | "de" = "en") =>
  renderToStaticMarkup(
    <SessionDeleteDialogBody
      lang={lang}
      title="Hallo Welt"
      busy={false}
      failed={false}
      running={running}
      onCancel={() => {}}
      onConfirm={() => {}}
    />,
  );

describe("the delete question of a running session", () => {
  it("asks to stop it and delete, and names the button so", () => {
    const html = body(true);
    expect(html).toContain("This session is still running. Stop it and delete?");
    expect(html).toContain("Stop and delete");
    expect(html).not.toContain(">Delete this session?<");
  });

  it("asks it in German too", () => {
    const html = body(true, "de");
    expect(html).toContain("Diese Session läuft noch. Stoppen und löschen?");
    expect(html).toContain("Stoppen und löschen");
  });

  it("keeps the plain question for a session that does not run", () => {
    const html = body(false);
    expect(html).toContain("Delete this session?");
    expect(html).not.toContain("Stop and delete");
  });
});
