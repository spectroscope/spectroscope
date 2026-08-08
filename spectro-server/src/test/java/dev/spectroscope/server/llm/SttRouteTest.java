package dev.spectroscope.server.llm;

import org.junit.jupiter.api.Test;

import static org.junit.jupiter.api.Assertions.assertEquals;

/**
 * Which way a recording goes, and why the default is a rule rather than a name.
 *
 * <p>Card 187's correction chose a hosted provider beside the local one, with
 * "openai as the default because it works everywhere". It works everywhere
 * there is a key — and a machine that has whisper installed and no key would
 * have gone from working to "needs a key" on upgrade, which is a regression
 * dressed as a default. So the default is `auto`: the hosted path when a key is
 * there, the local one otherwise. An explicit choice always wins, including a
 * choice that cannot currently run — being told what is missing beats being
 * silently rerouted.</p>
 */
class SttRouteTest {

    @Test
    void anExplicitChoiceIsObeyedEvenWhenItCannotRunYet() {
        assertEquals(SttRoute.LOCAL, SttRoute.of("local", true),
                "asked for local: say the model is missing, do not quietly send audio out");
        assertEquals(SttRoute.HOSTED, SttRoute.of("openai", false),
                "asked for hosted: say the key is missing, do not quietly fall back");
    }

    @Test
    void theDefaultTakesTheHostedPathWhenAKeyIsThere() {
        assertEquals(SttRoute.HOSTED, SttRoute.of("auto", true),
                "a key means it works everywhere, which is what the card chose it for");
    }

    @Test
    void andTheLocalOneWhenThereIsNoKey() {
        // Also when nothing is installed either: the keyless path is still the
        // right answer, because its sentence is the one that names the setup.
        assertEquals(SttRoute.LOCAL, SttRoute.of("auto", false));
    }

    @Test
    void anAbsentOrUnknownSettingBehavesLikeTheDefault() {
        for (String value : new String[] {null, "", "  ", "nonsense"}) {
            assertEquals(SttRoute.HOSTED, SttRoute.of(value, true), "value=" + value);
            assertEquals(SttRoute.LOCAL, SttRoute.of(value, false), "value=" + value);
        }
    }
}
