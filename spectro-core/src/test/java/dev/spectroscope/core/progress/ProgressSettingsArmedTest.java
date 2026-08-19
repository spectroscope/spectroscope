package dev.spectroscope.core.progress;

import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtensionContext;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.Arguments;
import org.junit.jupiter.params.provider.ArgumentsProvider;
import org.junit.jupiter.params.provider.ArgumentsSource;

import java.util.stream.Stream;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;

/**
 * Card 281, criterion 3: the twin of {@code armedState} in
 * {@code spectro-web/src/components/progressSection.ts}.
 *
 * <p>The settings page draws a chip per control saying whether that detector is
 * watching. That is a second copy of a predicate this record already owns, in a
 * language that cannot import it, and a UI reading {@code !== 0} instead of
 * {@code > 0} would draw "armed" over a detector that can never fire.</p>
 *
 * <p>So both sides walk the SAME table, and {@code -1} is in it on purpose: the
 * guards here are all {@code > 0}, which makes a negative off. Nothing stops an
 * operator typing one into a settings file, and nothing would have caught a page
 * that disagreed about what it means.</p>
 *
 * <p>The assertion is on the boolean, never on a rendered word. In German the
 * substring trap runs through "scharf" inside "unscharf" and "aus" inside
 * "ausgeschaltet", which is the same shape as the {@code assertFalse(
 * text.contains("changed ("))} finding that was green for "unchanged (".</p>
 */
class ProgressSettingsArmedTest {

    /** The table both sides walk: the value, and whether it arms a detector. */
    static final class Table implements ArgumentsProvider {
        @Override
        public Stream<? extends Arguments> provideArguments(ExtensionContext context) {
            return Stream.of(
                    Arguments.of(0, false),
                    Arguments.of(-1, false),
                    Arguments.of(1, true),
                    Arguments.of(3, true));
        }
    }

    @ParameterizedTest(name = "{0} in the writes position is armed={1}")
    @ArgumentsSource(Table.class)
    void theWritesPositionFollowsTheTable(int value, boolean armed) {
        assertEquals(armed, new ProgressSettings(value, 0, 0).armed());
    }

    @ParameterizedTest(name = "{0} in the failures position is armed={1}")
    @ArgumentsSource(Table.class)
    void theFailuresPositionFollowsTheTable(int value, boolean armed) {
        assertEquals(armed, new ProgressSettings(0, value, 0).armed());
    }

    @ParameterizedTest(name = "{0} in the plan position is armed={1}")
    @ArgumentsSource(Table.class)
    void thePlanPositionFollowsTheTable(int value, boolean armed) {
        assertEquals(armed, new ProgressSettings(0, 0, value).armed());
    }

    @Test
    void aNegativeIsOffAndNotMerelyNotDefault() {
        // Stated on its own because it is the one row a reasonable
        // implementation gets wrong: -1 is not "unset", it is off, and every
        // detector body agrees by refusing to look at a threshold at or below
        // zero.
        assertFalse(new ProgressSettings(-1, -1, -1).armed());
        assertFalse(ProgressSettings.off().armed());
    }
}
