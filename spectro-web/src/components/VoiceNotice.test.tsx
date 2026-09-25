// Card 440, review of wave H3e: the voice sheet fills "{v}" with strings the
// server sends (the key's variable name, the hosted model, the install line).
// A string replacement reads $&, $`, $' and $$ in such a value as patterns, so
// the sheet showed something the server never said.
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { VoiceNotice } from "./VoiceNotice";
import type { SttStatus } from "./voiceNoticeReading";

/** The sheet's text, tags removed and entities read back. */
const text = (status: SttStatus): string =>
  renderToStaticMarkup(<VoiceNotice status={status} onDismiss={() => {}} onOpenSettings={() => {}} />)
    .replace(/<[^>]*>/g, " ")
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");

describe("the voice sheet shows the server's words as written", () => {
  it("keeps dollar signs in the key's name and the hosted model", () => {
    const shown = text({
      route: "hosted",
      provider: "openai",
      speechWorks: true,
      hosted: { keyPresent: true, keyEnv: "KEY$&ENV", model: "m$$odel$`x" },
    });
    expect(shown).toContain("KEY$&ENV");
    expect(shown).toContain("m$$odel$`x");
  });

  it("keeps dollar signs in the install line", () => {
    const shown = text({
      route: "local",
      provider: "local",
      speechWorks: false,
      binaryHint: "brew install a$'b",
      model: { present: true },
    });
    expect(shown).toContain("brew install a$'b");
  });
});
