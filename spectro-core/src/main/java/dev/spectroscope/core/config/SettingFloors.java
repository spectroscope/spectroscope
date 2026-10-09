package dev.spectroscope.core.config;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;

import java.util.ArrayList;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * The lowest value each whole-number setting may hold (card 386).
 *
 * <p>One table, read in three places: {@link SettingsWriter#patch} refuses a
 * patch that sets a key below its floor, {@link SpectroConfig}'s loader skips
 * such a key when a settings file on disk holds one, and the settings API
 * hands the table to the web page, which takes each number field's lowest
 * value from it.</p>
 *
 * <p>Before this card the floors existed only as {@code min} attributes in
 * the page's markup, which the browser does not enforce on a change event.
 * A cleared field saved {@code Number("")}, which is 0, and nothing on the
 * server checked the range.</p>
 */
public final class SettingFloors {

    private static final ObjectMapper JSON = new ObjectMapper();

    /**
     * One key's floor.
     *
     * @param key       the settings key
     * @param floor     the lowest value the key may hold
     * @param zeroMeans what a zero does, for a key whose floor is zero; null
     *                  for a key where zero is below the floor
     */
    public record Floor(String key, int floor, String zeroMeans) {
    }

    /**
     * A value a settings file holds below its key's floor, skipped on read.
     *
     * @param key   the settings key
     * @param value the value as the file holds it, in JSON notation
     * @param floor the key's floor
     * @param layer the scope the file belongs to ({@code user},
     *              {@code launch-dir}, {@code project} or {@code local})
     * @param file  the file the value came from
     */
    public record Skipped(String key, String value, int floor, String layer, String file) {

        /** Sent by the settings API beside the fields above, so a reader of
         *  the view does not have to compose it.
         *  @return key, value, file and floor in one sentence, and what the
         *          loader did instead */
        @com.fasterxml.jackson.annotation.JsonProperty("message")
        public String message() {
            return "\"" + key + "\" is " + value + " in " + file + ", below its floor of " + floor
                    + "; that key was skipped and the layer below applies";
        }
    }

    /**
     * One key found below its floor in a JSON object.
     *
     * @param key   the settings key
     * @param value the value as written, in JSON notation
     * @param floor the key's floor
     */
    record Below(String key, String value, int floor) {

        /** @return {@code "key" is value, below its floor of floor} */
        String sentence() {
            return "\"" + key + "\" is " + value + ", below its floor of " + floor;
        }
    }

    /** The table, in the order card 386 lists it. */
    private static final List<Floor> TABLE = List.of(
            new Floor("commandTimeoutSeconds", 1, null),
            new Floor("subagentBudgetSeconds", 1, null),
            // Card 394: zero would cut every child at its first exchange.
            new Floor("subagentBudgetTokens", 1, null),
            new Floor("maxTurns", 1, null),
            new Floor("maxTokens", 1, null),
            new Floor("maxQuestionOptions", 1, null),
            new Floor("maxQuestionChars", 1, null),
            // The dock's own minimum width: a ceiling under it would make every
            // drag illegal, and the web heals such a value back to the shipped one.
            new Floor("dockMaxWidth", 260, null),
            new Floor("progressGuardWrites", 0, "the identical-writes detector is off"),
            new Floor("progressGuardFailures", 0, "the repeated-failure detector is off"),
            new Floor("progressGuardPlanTurns", 0, "the stalled-plan detector is off"),
            new Floor("continuationBudget", 0, "a run that stops with its plan open is not continued"),
            new Floor("questionsPerRun", 0, "the agent never asks a question"),
            new Floor("chatReserveWidth", 0, "no width is kept back for the chat"),
            // Card 490: the main agent and one helper. "No helpers" already has
            // its key, the agents tool group of card 466, and a count of 1
            // would be a second key for the same state.
            new Floor("sessionsPerChat", 2, null));

    private static final Map<String, Integer> FLOORS = floorsOf(TABLE);

    /** Static table, never instantiated. */
    private SettingFloors() {
    }

    private static Map<String, Integer> floorsOf(List<Floor> table) {
        Map<String, Integer> floors = new LinkedHashMap<>();
        for (Floor floor : table) {
            floors.put(floor.key(), floor.floor());
        }
        return Collections.unmodifiableMap(floors);
    }

    /** The whole table.
     *  @return every floored key with its floor and the meaning of a legal zero */
    public static List<Floor> table() {
        return TABLE;
    }

    /** The floors alone, keyed by setting, as the settings API sends them.
     *  @return each floored key's floor, in table order (unmodifiable) */
    public static Map<String, Integer> floors() {
        return FLOORS;
    }

    /**
     * The floored keys in {@code node} that hold a value below their floor.
     *
     * <p>A value is compared after binding it the way {@link SpectroConfig}'s
     * partial config binds it, so {@code "0"} and {@code 0.5} count as 0. A
     * value that does not bind to a whole number at all is left alone here;
     * the shape check that binds the whole object reports it.</p>
     *
     * @param node a settings object, a patch or a whole file; anything that
     *             is not an object has no keys and yields nothing
     * @return every key below its floor, in table order
     */
    static List<Below> below(JsonNode node) {
        List<Below> found = new ArrayList<>();
        if (node == null || !node.isObject()) {
            return found;
        }
        for (Floor floor : TABLE) {
            JsonNode value = node.get(floor.key());
            if (value == null || value.isNull()) {
                continue;
            }
            Integer bound;
            try {
                bound = JSON.treeToValue(value, Integer.class);
            } catch (com.fasterxml.jackson.core.JsonProcessingException | IllegalArgumentException unbound) {
                continue;
            }
            if (bound != null && bound < floor.floor()) {
                found.add(new Below(floor.key(), value.toString(), floor.floor()));
            }
        }
        return found;
    }
}
