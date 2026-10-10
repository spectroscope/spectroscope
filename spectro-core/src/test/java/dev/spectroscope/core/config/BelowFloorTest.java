package dev.spectroscope.core.config;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.LinkedHashMap;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.assertArrayEquals;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * A number below its key's floor, on the write and on the read (card 386).
 *
 * <p>Before this card {@link SettingsWriter} checked the shape of a number and
 * never its range, and the loader took whatever a file held. A cleared field on
 * the settings page saved {@code Number("")}, which is 0, and a 0 in
 * {@code commandTimeoutSeconds} made every shell command of the next session
 * time out at once (measured in the card's evidence, 20 of 20 runs for each of
 * three commands).</p>
 *
 * <p>The write refuses the whole patch and the read skips the one key. That is
 * the asymmetry card 369 decided for process-global keys, taken over as it
 * stands: a patch has not landed and can be corrected, a file on disk has
 * landed and holds keys that were typed correctly.</p>
 *
 * <p>The floors themselves are listed once, in {@code SettingFloors}; this file
 * writes the card's table out by hand on purpose, so that a change to the
 * table is a change the card's reader has to agree with.</p>
 */
class BelowFloorTest {

    private static final ObjectMapper JSON = new ObjectMapper();

    /** The card's table: every key, and the lowest value it may hold. */
    static final Map<String, Integer> CARD_TABLE = cardTable();

    private static Map<String, Integer> cardTable() {
        Map<String, Integer> table = new LinkedHashMap<>();
        table.put("commandTimeoutSeconds", 1);
        table.put("subagentBudgetSeconds", 1);
        // Card 394: a child's token budget, with the floor 386 set for its sibling.
        table.put("subagentBudgetTokens", 1);
        table.put("maxTurns", 1);
        table.put("maxTokens", 1);
        table.put("maxQuestionOptions", 1);
        table.put("maxQuestionChars", 1);
        table.put("dockMaxWidth", 260);
        table.put("progressGuardWrites", 0);
        table.put("progressGuardFailures", 0);
        table.put("progressGuardPlanTurns", 0);
        table.put("continuationBudget", 0);
        table.put("questionsPerRun", 0);
        table.put("chatReserveWidth", 0);
        // Card 490: the main agent and one helper; no helpers is the agents group.
        table.put("sessionsPerChat", 2);
        return table;
    }

    @AfterEach
    void removeUserConfig() throws IOException {
        Files.deleteIfExists(SpectroConfig.CONFIG_PATH);
        Files.deleteIfExists(SpectroConfig.USER_SETTINGS_PATH);
    }

    private static void writeSettings(Path dir, String json) throws IOException {
        Files.createDirectories(dir.resolve(".spectro"));
        Files.writeString(dir.resolve(SpectroConfig.PROJECT_SETTINGS), json);
    }

    /** The resolved value of one key, read off the effective config the same
     *  way the settings API serialises it. */
    private static JsonNode effective(SpectroConfig config, String key) {
        return JSON.valueToTree(config).get(key);
    }

    // ---- the write ------------------------------------------------------------

    @Test
    void aPatchOneBelowTheFloorIsRefusedByKeyValueAndFloor(@TempDir Path dir) throws IOException {
        Path file = dir.resolve("settings.json");
        Files.writeString(file, "{ \"model\": \"kept\" }");
        byte[] before = Files.readAllBytes(file);
        for (Map.Entry<String, Integer> row : CARD_TABLE.entrySet()) {
            int below = row.getValue() - 1;
            IllegalArgumentException refused = assertThrows(IllegalArgumentException.class,
                    () -> SettingsWriter.patch(file, SettingsWriter.Scope.USER,
                            JSON.createObjectNode().put(row.getKey(), below)),
                    row.getKey() + " " + below + " was written");
            String message = refused.getMessage();
            assertTrue(message.contains("\"" + row.getKey() + "\""), message);
            assertTrue(message.contains(" " + below + ","), "the value is not named: " + message);
            assertTrue(message.contains("floor of " + row.getValue()), "the floor is not named: " + message);
        }
        assertArrayEquals(before, Files.readAllBytes(file), "a refused patch touched the file");
    }

    @Test
    void theFloorItselfIsAccepted(@TempDir Path dir) throws IOException {
        Path file = dir.resolve("settings.json");
        for (Map.Entry<String, Integer> row : CARD_TABLE.entrySet()) {
            SettingsWriter.patch(file, SettingsWriter.Scope.USER,
                    JSON.createObjectNode().put(row.getKey(), row.getValue()));
            assertEquals(row.getValue().intValue(),
                    JSON.readTree(Files.readString(file)).path(row.getKey()).asInt(-99), row.getKey());
        }
    }

    @Test
    void aLegalZeroStaysLegal(@TempDir Path dir) throws IOException {
        // The card's third scenario: questions per run set to 0 is saved as 0.
        Path file = dir.resolve("settings.json");
        SettingsWriter.patch(file, SettingsWriter.Scope.USER,
                JSON.createObjectNode().put("questionsPerRun", 0));
        assertEquals(0, JSON.readTree(Files.readString(file)).path("questionsPerRun").asInt(-99));
    }

    @Test
    void aZeroSentAsTextOrAsAFractionIsRefusedToo(@TempDir Path dir) {
        // Jackson coerces "0" and 0.5 into an Integer field, so a floor that
        // checked only JSON integers would let both through.
        Path file = dir.resolve("settings.json");
        for (String patch : new String[] {
                "{ \"commandTimeoutSeconds\": \"0\" }", "{ \"commandTimeoutSeconds\": 0.5 }"}) {
            IllegalArgumentException refused = assertThrows(IllegalArgumentException.class,
                    () -> SettingsWriter.patch(file, SettingsWriter.Scope.USER, JSON.readTree(patch)),
                    patch + " was written");
            assertTrue(refused.getMessage().contains("floor of 1"), refused.getMessage());
        }
        assertFalse(Files.exists(file));
    }

    @Test
    void aRefusedWriteSaysWhatAReadOfSuchAFileWouldDo(@TempDir Path dir) {
        IllegalArgumentException refused = assertThrows(IllegalArgumentException.class,
                () -> SettingsWriter.patch(dir.resolve("settings.json"), SettingsWriter.Scope.USER,
                        JSON.createObjectNode().put("commandTimeoutSeconds", 0).put("model", "m")));
        assertTrue(refused.getMessage().contains("Nothing in this patch was written"),
                refused.getMessage());
        assertTrue(refused.getMessage().contains("alone is skipped"), refused.getMessage());
    }

    // ---- the read -------------------------------------------------------------

    @Test
    void aZeroOnDiskCostsThatKeyAloneAndTheRestOfTheFileLoads(@TempDir Path dir) throws IOException {
        writeSettings(dir, """
                { "commandTimeoutSeconds": 0, "maxTurns": 40, "model": "kept" }
                """);
        SpectroConfig config = SpectroConfig.load(SpectroConfig.Overrides.none(), dir, Map.of());
        assertEquals(SpectroConfig.DEFAULT_COMMAND_TIMEOUT_SECONDS, config.commandTimeoutSeconds());
        assertEquals(40, config.maxTurns());
        assertEquals("kept", config.model());
    }

    @Test
    void everyKeyBelowItsFloorOnDiskFallsBackToTheShippedValue(@TempDir Path dir, @TempDir Path empty)
            throws IOException {
        JsonNode shipped = JSON.valueToTree(
                SpectroConfig.load(SpectroConfig.Overrides.none(), empty, Map.of()));
        for (Map.Entry<String, Integer> row : CARD_TABLE.entrySet()) {
            int below = row.getValue() - 1;
            writeSettings(dir, "{ \"" + row.getKey() + "\": " + below + " }");
            SpectroConfig config = SpectroConfig.load(SpectroConfig.Overrides.none(), dir, Map.of());
            assertEquals(shipped.get(row.getKey()), effective(config, row.getKey()),
                    row.getKey() + " " + below + " on disk reached the session");
        }
    }

    @Test
    void aLegalZeroOnDiskStays(@TempDir Path dir) throws IOException {
        writeSettings(dir, "{ \"questionsPerRun\": 0, \"chatReserveWidth\": 0 }");
        SpectroConfig config = SpectroConfig.load(SpectroConfig.Overrides.none(), dir, Map.of());
        assertEquals(0, config.questionsPerRun());
        assertEquals(0, config.chatReserveWidth());
    }

    @Test
    void theLayerBelowAppliesWhenItHasAValue(@TempDir Path launchDir, @TempDir Path ws)
            throws IOException {
        // Skipping the key hands the decision to the next layer down, which is
        // the shipped default only when no other layer set the key.
        writeSettings(launchDir, "{ \"commandTimeoutSeconds\": 120 }");
        writeSettings(ws, "{ \"commandTimeoutSeconds\": 0, \"subagentBudgetSeconds\": 0 }");
        SpectroConfig config = SpectroConfig.load(SpectroConfig.Overrides.none(), launchDir, ws, Map.of());
        assertEquals(120, config.commandTimeoutSeconds());
        assertEquals(SpectroConfig.DEFAULT_SUBAGENT_BUDGET_SECONDS, config.subagentBudgetSeconds());
    }

    @Test
    void theOriginOfASkippedKeyIsTheLayerThatNowSuppliesIt(@TempDir Path dir) throws IOException {
        writeSettings(dir, "{ \"commandTimeoutSeconds\": 0 }");
        SpectroConfig.Resolved resolved =
                SpectroConfig.loadResolved(SpectroConfig.Overrides.none(), dir, null, Map.of());
        assertEquals("defaults", resolved.origins().get("commandTimeoutSeconds").winner());
    }
}
