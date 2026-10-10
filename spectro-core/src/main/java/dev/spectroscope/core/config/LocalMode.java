package dev.spectroscope.core.config;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.JsonNodeFactory;
import dev.spectroscope.core.ToolGroup;
import dev.spectroscope.core.config.governing.Governs;

import java.lang.reflect.RecordComponent;
import java.util.ArrayList;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;

/**
 * Card 493: the Local mode switch's table, Alternative A of
 * {@code konzept/RUN-PROFILES.md}.
 *
 * <p>Switching Local mode on writes each value below for one chat; the server
 * folds nothing for a mode. The knob keys are the {@link SpectroConfig}
 * components marked {@link LocalModeKnob}, read off the record. What the switch
 * wrote, and what it gives back when it is switched off, is
 * {@link LocalModeState}'s.</p>
 */
public final class LocalMode {

    /** The key that records, in a folder's local file, what the switch wrote. */
    public static final String RECORD_KEY = "localModeKeys";

    /** The session count Local mode writes: the default count of card 490,
     *  the main agent and two helpers, the owner's figure. */
    @Governs(kind = Governs.Kind.ALIAS, unit = Governs.Unit.COUNT)
    public static final int PRESET_SESSIONS_PER_CHAT = SpectroConfig.DEFAULT_SESSIONS_PER_CHAT;

    /** The tool groups Local mode switches off. {@code web} stays on because it
     *  is how the model reaches the outside world, {@code mcp} because the
     *  operator installed those tools on purpose, {@code agents} because the
     *  owner asked for helpers ({@code konzept/RUN-PROFILES.md}, Knobs). */
    public static final List<String> PRESET_TOOL_GROUPS_OFF = List.of(
            ToolGroup.BROWSER.wireName(), ToolGroup.LAUNCH.wireName(),
            ToolGroup.IMAGES.wireName(), ToolGroup.ROLES.wireName());

    /** The read share Local mode writes, in per cent. A proposal: nobody has
     *  measured it. The measurement the concept names is whole reads refused,
     *  paged reads, extra turns and wall clock on card 486's task set at 10 and
     *  at 25 per cent. */
    @Governs(kind = Governs.Kind.UNEXAMINED, unit = Governs.Unit.PERCENT)
    public static final int PRESET_READ_SHARE_PERCENT = 10;

    /** Local mode turns the care paragraph on. */
    public static final String PRESET_CARE_PARAGRAPH = SpectroConfig.CARE_PARAGRAPH_ON;

    private static final JsonNodeFactory NODES = JsonNodeFactory.instance;

    /** Static table, never instantiated. */
    private LocalMode() {
    }

    /**
     * The knob keys, read off the record: every {@link SpectroConfig}
     * component marked {@link LocalModeKnob}, in record order.
     *
     * @return the key names
     */
    public static List<String> knobs() {
        List<String> knobs = new ArrayList<>();
        for (RecordComponent component : SpectroConfig.class.getRecordComponents()) {
            if (component.isAnnotationPresent(LocalModeKnob.class)) {
                knobs.add(component.getName());
            }
        }
        return Collections.unmodifiableList(knobs);
    }

    /**
     * The value Local mode writes for each knob, in the order the gear shows
     * the rows (card 493, criterion 1).
     *
     * @return key to value, as the settings file holds it
     */
    public static Map<String, JsonNode> preset() {
        Map<String, JsonNode> preset = new LinkedHashMap<>();
        preset.put("sessionsPerChat", NODES.numberNode(PRESET_SESSIONS_PER_CHAT));
        ArrayNode groups = NODES.arrayNode();
        PRESET_TOOL_GROUPS_OFF.forEach(groups::add);
        preset.put("toolGroupsOff", groups);
        preset.put("readSharePercent", NODES.numberNode(PRESET_READ_SHARE_PERCENT));
        preset.put("careParagraph", NODES.textNode(PRESET_CARE_PARAGRAPH));
        return Collections.unmodifiableMap(preset);
    }

    /**
     * Why a value may not be held for a knob, or null when it may. The frame
     * that carries it is untrusted input, so every value is checked against
     * the key's shape, its floor ({@link SettingFloors}) and its known values.
     *
     * @param key   the settings key
     * @param value the value as JSON
     * @return the reason, or null
     */
    public static String refusal(String key, JsonNode value) {
        if (!knobs().contains(key)) {
            return "\"" + key + "\" is not a value of the Local mode switch (known: "
                    + String.join(", ", preset().keySet()) + ")";
        }
        if (value == null || value.isNull() || value.isMissingNode()) {
            return "\"" + key + "\" needs a value";
        }
        switch (key) {
            case "sessionsPerChat", "readSharePercent" -> {
                if (!value.isIntegralNumber() || !value.canConvertToInt()) {
                    return "\"" + key + "\" must be a whole number";
                }
                Integer floor = SettingFloors.floors().get(key);
                if (floor != null && value.asInt() < floor) {
                    return "\"" + key + "\" is " + value.asInt() + ", below its floor of " + floor;
                }
                return null;
            }
            case "careParagraph" -> {
                return value.isTextual() && SpectroConfig.KNOWN_CARE_PARAGRAPH_VALUES.contains(value.asText())
                        ? null
                        : "\"careParagraph\" must be " + SpectroConfig.CARE_PARAGRAPH_ON + " or "
                        + SpectroConfig.CARE_PARAGRAPH_OFF;
            }
            case "toolGroupsOff" -> {
                if (!value.isArray()) {
                    return "\"toolGroupsOff\" must be a list";
                }
                for (JsonNode entry : value) {
                    if (!entry.isTextual() || ToolGroup.named(entry.asText()).isEmpty()) {
                        return "Unknown tool group: \"" + entry.asText() + "\" (allowed: "
                                + String.join(", ", ToolGroup.wireNames()) + ")";
                    }
                }
                return null;
            }
            default -> {
                return "\"" + key + "\" has no check in the Local mode switch";
            }
        }
    }

    /**
     * A knob's value in a config, as the settings file holds it. The tool
     * groups come in the order {@link ToolGroup} lists them, so two lists
     * with the same groups compare equal.
     *
     * @param config the configuration
     * @param key    a knob key
     * @return the value as JSON; JSON null for an unset count
     */
    public static JsonNode valueIn(SpectroConfig config, String key) {
        return switch (key) {
            case "sessionsPerChat" -> config.sessionsPerChat() == null
                    ? NODES.nullNode() : NODES.numberNode(config.sessionsPerChat());
            case "toolGroupsOff" -> groups(config.toolGroupsOffSet());
            case "readSharePercent" -> NODES.numberNode(config.readSharePercent());
            case "careParagraph" -> NODES.textNode(config.careParagraph());
            default -> throw new IllegalArgumentException("not a knob: " + key);
        };
    }

    /**
     * Tool groups as the list the settings file and the switch's rows hold.
     *
     * @param groups the groups
     * @return their wire names in {@link ToolGroup} order
     */
    public static ArrayNode groups(Set<ToolGroup> groups) {
        ArrayNode list = NODES.arrayNode();
        for (ToolGroup group : ToolGroup.values()) {
            if (groups.contains(group)) {
                list.add(group.wireName());
            }
        }
        return list;
    }

    /**
     * Puts a list of tool group names in {@link ToolGroup} order, so a list
     * a person typed compares equal to the preset when it names the same
     * groups. Any other key's value comes back as it is.
     *
     * @param key  the knob the value belongs to
     * @param list the value; for the tool groups, names that are each a known group
     * @return the value, the tool groups in canonical order
     */
    public static JsonNode canonical(String key, JsonNode list) {
        if (!"toolGroupsOff".equals(key) || list == null || !list.isArray()) {
            return list;
        }
        java.util.EnumSet<ToolGroup> set = java.util.EnumSet.noneOf(ToolGroup.class);
        list.forEach(entry -> ToolGroup.named(entry.asText()).ifPresent(set::add));
        return groups(set);
    }
}
