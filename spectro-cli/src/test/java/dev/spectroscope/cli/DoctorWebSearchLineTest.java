package dev.spectroscope.cli;

import dev.spectroscope.core.web.WebSearchTiers;
import dev.spectroscope.core.web.WebSearchTiers.Choice;
import dev.spectroscope.core.web.WebSearchTiers.Configured;
import dev.spectroscope.core.web.WebSearchTool;
import org.junit.jupiter.api.Test;

import java.util.List;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * The doctor's web_search line, and the reason card 203 rewrote it.
 *
 * <p>The line used to read {@code TAVILY_API_KEY} and decide for itself which
 * tier was active — a second copy of a rule that also lived in
 * {@code WebSearchTool}. Two copies agree only while their inputs agree, and
 * the moment this card gave the tier a SETTINGS input, the doctor would have
 * kept announcing the scrape at a machine that was searching through a SearXNG
 * instance. The strongest thing this file asserts is therefore not the wording
 * of a line: it is that the doctor's sentence and the running tool's sentence
 * are the SAME string, produced by the same resolver.</p>
 */
class DoctorWebSearchLineTest {

    @Test
    void theDoctorSaysExactlyWhatTheToolSaysAboutTheSameMachine() {
        // Every row of the card's table, checked as an identity rather than as
        // two hand-kept literals. A future edit to either sentence that forgets
        // the other lands here.
        for (Configured configured : List.of(
                new Configured("http://box.local:8888", false, false),
                new Configured(null, true, false),
                new Configured(null, false, true),
                new Configured(null, false, false))) {
            Choice choice = WebSearchTiers.decide(configured);
            String doctorLine = DoctorCommand.webSearchLine(choice).get(0).message();
            String toolSentence = new WebSearchTool(
                    WebSearchTiers.searcher(choice, name -> "stub-key")).description();

            assertTrue(doctorLine.startsWith("web search: "), "got: " + doctorLine);
            String shared = doctorLine.substring("web search: ".length());
            assertTrue(toolSentence.contains(shared),
                    "the doctor and the tool must describe the same machine in the same words.\n"
                            + "  doctor: " + doctorLine + "\n  tool:   " + toolSentence);
        }
    }

    @Test
    void aConfiguredInstanceIsAPassAndNamesItsAddress() {
        List<DoctorCommand.Line> lines = DoctorCommand.webSearchLine(
                WebSearchTiers.decide(new Configured("http://box.local:8888", false, false)));

        assertEquals(1, lines.size(), "one line, not a paragraph");
        assertEquals(DoctorCommand.Kind.PASS, lines.get(0).kind());
        assertTrue(lines.get(0).message().contains("http://box.local:8888"),
                "names the address, got: " + lines.get(0).message());
    }

    @Test
    void theScrapeIsANoteRatherThanAFailureButItStillSaysWhatItIs() {
        // An unconfigured machine is not a broken machine: the scrape answers,
        // so failing the doctor over it would cry wolf. What it must not do is
        // look like a choice somebody made.
        List<DoctorCommand.Line> lines = DoctorCommand.webSearchLine(
                WebSearchTiers.decide(new Configured(null, false, false)));

        assertEquals(DoctorCommand.Kind.INFO, lines.get(0).kind(),
                "a keyless install is not unhealthy");
        // In the searcher's own words since card 223 — this line and the bot-check
        // failure are read minutes apart by the same person.
        assertTrue(lines.get(0).message().contains(WebSearchTiers.SCRAPE),
                "got: " + lines.get(0).message());
        assertTrue(lines.get(0).message().contains("SearXNG"),
                "names the way out, got: " + lines.get(0).message());
    }

    @Test
    void aKeyedTierIsAPassAndNamesItsVariable() {
        assertEquals(DoctorCommand.Kind.PASS, DoctorCommand.webSearchLine(
                WebSearchTiers.decide(new Configured(null, true, false))).get(0).kind());
        assertTrue(DoctorCommand.webSearchLine(
                        WebSearchTiers.decide(new Configured(null, false, true)))
                .get(0).message().contains("BRAVE_API_KEY"));
    }
}
