package dev.spectroscope.core.config;

import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * The three keys added in one record edit — card 359's shell clock and card
 * 361's two dock widths — walked down the whole chain each of them has to
 * survive.
 *
 * <p>They are added together on purpose. The most expensive merges this repo
 * has recorded were two cards appending a component to this same record from
 * two branches, and three cards were queued behind these keys; doing the edit
 * once is cheaper than resolving it three times.</p>
 *
 * <p>Each key is asked the same four questions {@code MaxTurnsSettingTest} asks
 * of {@code maxTurns}, because each of the four has its own way of failing
 * silently: a missing default resolves to zero, a missing writer key is card
 * 203 F2's silent refusal on the one working save path, a missing
 * {@code PartialConfig} field cannot be set from ANY layer (Jackson's
 * {@code ignoreUnknown} says nothing), and a missing probe reports an invented
 * origin to the settings page.</p>
 *
 * <p>What is NOT claimed here: that anything reads the two widths. This test
 * pins the key's existence and nothing further, and it stays that way now that
 * card 361 has wired them — the reader is a browser (a CSS custom property, a
 * drag handler and the layout store's clamp), so nothing in this module could
 * observe it. The web half is pinned in {@code spectro-web}:
 * {@code dockWidthSettings.test.tsx} for the controls and the reach,
 * {@code rowWidths.test.ts} for the allocation, {@code layout.test.ts} for the
 * ceiling actually reaching the store. The sentence that stood here until then
 * — "nothing reads them yet" — was true when it was written, which is the
 * whole reason it had to be rewritten in the edit that made it false.</p>
 */
class ShellAndDockKeysTest {

    /** Every key this record edit added, with the value it ships. */
    private static List<Object[]> added() {
        return List.of(
                new Object[] {"commandTimeoutSeconds", 10},
                new Object[] {"chatReserveWidth", 360},
                new Object[] {"dockMaxWidth", 1200});
    }

    private static int resolved(SpectroConfig config, String key) {
        return switch (key) {
            case "commandTimeoutSeconds" -> config.commandTimeoutSeconds();
            case "chatReserveWidth" -> config.chatReserveWidth();
            case "dockMaxWidth" -> config.dockMaxWidth();
            default -> throw new IllegalArgumentException(key);
        };
    }

    @Test
    void eachOneShipsTheValueItsCardNamed(@TempDir Path dir) {
        SpectroConfig config = SpectroConfig.load(SpectroConfig.Overrides.none(), dir);
        for (Object[] key : added()) {
            assertEquals((int) (Integer) key[1], resolved(config, (String) key[0]),
                    "\"" + key[0] + "\" does not ship the value its card named — an int"
                            + " component nobody defaulted resolves to zero, which reads"
                            + " exactly like a deliberate off switch");
        }
    }

    @Test
    void aSettingsFileMovesEachOne(@TempDir Path dir) throws Exception {
        Files.createDirectories(dir.resolve(".spectro"));
        Files.writeString(dir.resolve(SpectroConfig.PROJECT_SETTINGS), """
                { "commandTimeoutSeconds": 120, "chatReserveWidth": 420, "dockMaxWidth": 2400 }
                """);
        SpectroConfig config = SpectroConfig.load(SpectroConfig.Overrides.none(), dir);
        assertEquals(120, config.commandTimeoutSeconds());
        assertEquals(420, config.chatReserveWidth());
        assertEquals(2400, config.dockMaxWidth());
    }

    @Test
    void theSettingsApiAcceptsEachKeyRatherThanRefusingIt() {
        for (Object[] key : added()) {
            assertTrue(SettingsWriter.knownKeys().contains(key[0]),
                    "the settings page cannot save \"" + key[0] + "\": the record knows the"
                            + " key and the writer does not, which is card 203 F2's silent"
                            + " refusal on the one working save path");
        }
    }

    @Test
    void provenanceKnowsEachField(@TempDir Path dir) throws Exception {
        Files.createDirectories(dir.resolve(".spectro"));
        Files.writeString(dir.resolve(SpectroConfig.PROJECT_SETTINGS), """
                { "commandTimeoutSeconds": 120, "chatReserveWidth": 420, "dockMaxWidth": 2400 }
                """);
        var origins = SpectroConfig.loadResolved(SpectroConfig.Overrides.none(), dir, null,
                Map.of()).origins();
        for (Object[] key : added()) {
            assertEquals("launch-dir", origins.get((String) key[0]).winner(),
                    "\"" + key[0] + "\" has no provenance probe, so the settings page would"
                            + " draw a \"from defaults\" chip over the operator's own value");
        }
    }
}
