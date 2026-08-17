package dev.spectroscope.server.session;

import org.junit.jupiter.api.Test;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * Card 265: the one predicate that says whether anybody is listening.
 *
 * <p>It lives beside {@code decide} rather than being spelled out at the ask's
 * call site, because the two answers must never disagree: a mode that
 * short-circuits the gate has taken the human out of the loop, and a question
 * put to a loop with no human in it can only ever go unanswered.</p>
 */
class PermissionModesUnattendedTest {

    @Test
    void autoAndReadonlyAreUnattended() {
        assertThat(PermissionModes.unattended("auto")).isTrue();
        assertThat(PermissionModes.unattended("readonly")).isTrue();
    }

    @Test
    void askAndAnythingUnknownIsAttended() {
        assertThat(PermissionModes.unattended("ask")).isFalse();
        assertThat(PermissionModes.unattended(null))
                .as("null is the server's own default, which is ask")
                .isFalse();
        assertThat(PermissionModes.unattended("something-a-later-release-invents"))
                .as("an unknown mode falls through to asking, exactly as decide() does")
                .isFalse();
    }

    @Test
    void itAgreesWithDecideOnEveryModeItKnows() {
        // The drift guard: decide() short-circuits exactly where nobody is
        // listening, so the two must answer the same question the same way.
        for (String mode : new String[] {"auto", "readonly", "ask", null, "nonsense"}) {
            boolean shortCircuits = PermissionModes.decide(mode, null) != null;
            assertThat(PermissionModes.unattended(mode))
                    .as("mode %s", mode)
                    .isEqualTo(shortCircuits);
        }
    }
}
