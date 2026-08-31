package dev.spectroscope.cli;

import dev.spectroscope.core.events.RunEvent;
import dev.spectroscope.core.permission.Allowlist;
import org.junit.jupiter.api.Test;

import java.io.ByteArrayOutputStream;
import java.io.PrintStream;
import java.nio.charset.StandardCharsets;
import java.util.List;

import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * Card 354: the terminal says whether a refused settings key costs anything.
 *
 * <p>The web pane can decide a free refusal is not worth a chat turn; a
 * transcript scrolling past cannot hide a line the same way, and it should not —
 * the CLI's reader is watching a stream, not looking at an empty screen. What it
 * needs is the second half of the sentence, so "ignored" stops reading like
 * "lost" when nothing was lost.</p>
 *
 * <p>Pinned on the KEY, the carrying layer and the FILE, never on the whole
 * sentence: the prose is written for a person, the facts are not. The file is
 * pinned because a refusal abandons the whole workspace scope, so a clause that
 * accounts only for the key it named leaves the reader's other settings out of
 * a sentence that is supposed to price the loss.</p>
 */
class EventRendererSettingsIgnoredTest {

    private static final String MAIN = "main";

    /** Renders the given events through the real renderer and returns stdout. */
    private static String rendered(RunEvent... events) {
        PrintStream original = System.out;
        ByteArrayOutputStream captured = new ByteArrayOutputStream();
        System.setOut(new PrintStream(captured, true, StandardCharsets.UTF_8));
        try {
            Ansi ansi = Ansi.forced(false);
            EventRenderer renderer = new EventRenderer(ansi, new Spinner(ansi), MAIN,
                    () -> Allowlist.fromEntries(List.of()));
            for (RunEvent event : events) {
                renderer.render(event);
            }
        } finally {
            System.setOut(original);
        }
        return captured.toString(StandardCharsets.UTF_8);
    }

    @Test
    void aFreeRefusalSaysWhoCarriesTheKeyAnyway() {
        String out = rendered(new RunEvent.SettingsIgnored("allowLocalhost",
                "/Users/x/ForgeDemo/.spectro/settings.json",
                "the net fence's opt-in belongs in ~/.spectro/settings.json or"
                        + " SPECTRO_ALLOW_LOCALHOST, not in a folder the agent writes into.",
                true, "user", 1000L));

        assertTrue(out.contains("allowLocalhost"), out);
        assertTrue(out.contains("in force"),
                "the line has to say the setting still applies. Got: " + out);
        assertTrue(out.contains("user"), "and name the layer that carries it. Got: " + out);
        assertTrue(out.contains("rest of that file"),
                "a refusal takes the whole scope, so a free one has to account for the whole"
                        + " scope and not only for the key it named. Got: " + out);
    }

    @Test
    void anExpensiveRefusalSaysTheWholeFileGoesAndNotAllOfItComesBack() {
        String out = rendered(new RunEvent.SettingsIgnored("searxngUrl",
                "/w/.spectro/settings.json", "belongs in ~/.spectro/settings.json.",
                false, null, 1000L));

        assertTrue(out.contains("searxngUrl"), out);
        assertTrue(out.contains("the whole file is dropped"),
                "this is the case worth stopping at, and what is lost is the file. Got: " + out);
        assertFalse(out.contains("nothing else sets it"),
                "an allowed layer may well set this key, in order to set it the OTHER way."
                        + " That is a state SpectroConfig's own tests construct, and the"
                        + " sentence would be false in it. Got: " + out);
    }

    @Test
    void aLineFromBeforeThisCardClaimsNothingEitherWay() {
        // The pre-354 shape took no reading. The terminal prints what card 285
        // printed and invents no verdict.
        String out = rendered(new RunEvent.SettingsIgnored("allowLocalhost",
                "/w/.spectro/settings.json", "belongs in ~/.spectro/settings.json.", 1000L));

        assertTrue(out.contains("allowLocalhost"), out);
        assertFalse(out.contains("in force"),
                "no reading was taken, so no verdict may be printed. Got: " + out);
        assertFalse(out.contains("whole file"),
                "and neither half of the verdict, not just the free one. Got: " + out);
    }
}
