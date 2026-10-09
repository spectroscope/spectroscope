package dev.spectroscope.core.config;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.JsonNodeFactory;
import com.fasterxml.jackson.databind.node.MissingNode;
import org.junit.jupiter.api.Test;

import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * Card 493: the Local mode switch as a record of what it wrote.
 *
 * <p>Alternative A of {@code konzept/RUN-PROFILES.md}: switching on writes
 * each underlying value for the chat, an edit in a row of the switch shows as
 * changed, and switching off gives every key back what it held before. A key
 * the operator set by hand before switching on is left as it is. The state
 * here decides; the session applies what it returns.</p>
 */
class LocalModeTest {

    private static final ObjectMapper JSON = new ObjectMapper();
    private static final JsonNodeFactory NODES = JsonNodeFactory.instance;
    private static final JsonNode MISSING = MissingNode.getInstance();

    /** A chat that holds nothing: every knob is read from the settings files. */
    private static Map<String, JsonNode> nothingHeld() {
        Map<String, JsonNode> held = new LinkedHashMap<>();
        for (String key : LocalMode.preset().keySet()) {
            held.put(key, MISSING);
        }
        return held;
    }

    /** What the files give a chat that set nothing anywhere: v0.14.4. */
    private static Map<String, JsonNode> shipped() {
        Map<String, JsonNode> effective = new LinkedHashMap<>();
        effective.put("sessionsPerChat", NODES.nullNode());
        effective.put("toolGroupsOff", JSON.createArrayNode());
        effective.put("readSharePercent", NODES.numberNode(25));
        effective.put("careParagraph", NODES.textNode("off"));
        return effective;
    }

    @Test
    void thePresetIsTheConceptsLocalModeColumnInTheGearsOrder() {
        Map<String, JsonNode> preset = LocalMode.preset();
        assertEquals(List.of("sessionsPerChat", "toolGroupsOff", "readSharePercent", "careParagraph"),
                List.copyOf(preset.keySet()));
        assertEquals(3, preset.get("sessionsPerChat").asInt());
        assertEquals("[\"browser\",\"launch\",\"images\",\"roles\"]", preset.get("toolGroupsOff").toString());
        assertEquals(10, preset.get("readSharePercent").asInt());
        assertEquals("on", preset.get("careParagraph").asText());
    }

    @Test
    void switchingOnWritesThePresetForEveryKeyTheOperatorDidNotSet() {
        LocalModeState state = new LocalModeState();
        LocalModeState.Plan plan = state.switchOn(nothingHeld(), shipped(), Set.of(), nothingHeld());
        assertTrue(state.on());
        assertEquals(LocalMode.preset(), plan.session());
        assertEquals(Set.copyOf(LocalMode.preset().keySet()), state.owned());
        assertEquals(LocalMode.preset().get("readSharePercent"), plan.file().get("readSharePercent"));
        assertEquals("[\"sessionsPerChat\",\"toolGroupsOff\",\"readSharePercent\",\"careParagraph\"]",
                plan.file().get(LocalMode.RECORD_KEY).toString(),
                "the file must record which keys the switch wrote");
    }

    @Test
    void aKeyTheOperatorSetByHandIsLeftAndShowsAsChanged() {
        LocalModeState state = new LocalModeState();
        Map<String, JsonNode> effective = shipped();
        effective.put("toolGroupsOff", JSON.createArrayNode().add("browser"));
        LocalModeState.Plan plan = state.switchOn(nothingHeld(), effective, Set.of("toolGroupsOff"),
                nothingHeld());
        assertFalse(state.owned().contains("toolGroupsOff"));
        assertEquals("[\"browser\"]", plan.session().get("toolGroupsOff").toString(),
                "the chat's own list must replace the preset, not merge with it");
        assertFalse(plan.file().containsKey("toolGroupsOff"), "the switch wrote a key it does not own");
        LocalModeState.Row row = state.rows(effective).stream()
                .filter(r -> r.key().equals("toolGroupsOff")).findFirst().orElseThrow();
        assertTrue(row.changed());

        LocalModeState.Plan off = state.switchOff();
        assertTrue(off.session().get("toolGroupsOff").isMissingNode(),
                "switching off must give the key back to what it held before");
        assertFalse(off.file().containsKey("toolGroupsOff"), "switching off touched a hand-set key in the file");
    }

    @Test
    void anEditShowsChangedAndAResetBringsThePresetBack() {
        LocalModeState state = new LocalModeState();
        state.switchOn(nothingHeld(), shipped(), Set.of(), nothingHeld());
        LocalModeState.Plan edit = state.edit("sessionsPerChat", NODES.numberNode(2));
        assertEquals(2, edit.session().get("sessionsPerChat").asInt());
        assertEquals(2, edit.file().get("sessionsPerChat").asInt());
        Map<String, JsonNode> now = new LinkedHashMap<>(LocalMode.preset());
        now.put("sessionsPerChat", NODES.numberNode(2));
        assertTrue(state.rows(now).get(0).changed());
        assertFalse(state.rows(now).get(1).changed());

        LocalModeState.Plan reset = state.reset("sessionsPerChat");
        assertEquals(3, reset.session().get("sessionsPerChat").asInt());
        assertFalse(state.rows(LocalMode.preset()).get(0).changed());
    }

    @Test
    void switchingOffGivesEveryKeyBackWhatItHeldBeforeAndTheFileWhatItHadBefore() {
        LocalModeState state = new LocalModeState();
        Map<String, JsonNode> held = nothingHeld();
        held.put("toolGroupsOff", JSON.createArrayNode().add("web"));
        Map<String, JsonNode> file = nothingHeld();
        file.put(LocalMode.RECORD_KEY, MISSING);
        state.switchOn(held, shipped(), Set.of(), file);
        state.edit("sessionsPerChat", NODES.numberNode(2));
        LocalModeState.Plan off = state.switchOff();
        assertFalse(state.on());
        assertEquals("[\"web\"]", off.session().get("toolGroupsOff").toString());
        assertTrue(off.session().get("sessionsPerChat").isMissingNode());
        assertTrue(off.session().get("careParagraph").isMissingNode());
        for (String key : LocalMode.preset().keySet()) {
            assertTrue(off.file().get(key).isMissingNode(), key + " stays in the file after switching off");
        }
        assertTrue(off.file().get(LocalMode.RECORD_KEY).isMissingNode());
    }

    @Test
    void anEditMadeInLocalModeComesBackTheNextTimeItIsSwitchedOn() {
        LocalModeState state = new LocalModeState();
        state.switchOn(nothingHeld(), shipped(), Set.of(), nothingHeld());
        state.edit("sessionsPerChat", NODES.numberNode(2));
        state.switchOff();
        LocalModeState.Plan again = state.switchOn(nothingHeld(), shipped(), Set.of(), nothingHeld());
        assertEquals(2, again.session().get("sessionsPerChat").asInt());
    }

    @Test
    void nothingMovesWhileTheSwitchIsOff() {
        LocalModeState state = new LocalModeState();
        assertThrows(IllegalStateException.class,
                () -> state.edit("sessionsPerChat", NODES.numberNode(2)));
        assertThrows(IllegalStateException.class, () -> state.reset("sessionsPerChat"));
        assertTrue(state.switchOff().session().isEmpty(), "switching off an off switch changed something");
    }

    @Test
    void aRecordReadFromTheFileTurnsTheSwitchOnForTheKeysItNames() {
        LocalModeState state = new LocalModeState();
        LocalModeState.Plan seeded = state.adopt(List.of("sessionsPerChat", "readSharePercent"),
                LocalMode.preset());
        assertTrue(state.on());
        assertEquals(Set.of("sessionsPerChat", "readSharePercent"), state.owned());
        assertEquals(LocalMode.preset(), seeded.session(), "the chat must hold every value while on");
        LocalModeState.Plan off = state.switchOff();
        assertTrue(off.file().get("sessionsPerChat").isMissingNode());
        assertFalse(off.file().containsKey("careParagraph"), "a key the record does not name was removed");
    }

    @Test
    void theValueOfEveryKnobIsCheckedAgainstItsFloorAndItsKnownValues() {
        assertNull(LocalMode.refusal("sessionsPerChat", NODES.numberNode(2)));
        assertNotNull(LocalMode.refusal("sessionsPerChat", NODES.numberNode(1)));
        assertNull(LocalMode.refusal("readSharePercent", NODES.numberNode(1)));
        assertNotNull(LocalMode.refusal("readSharePercent", NODES.numberNode(0)));
        assertNotNull(LocalMode.refusal("readSharePercent", NODES.textNode("ten")));
        assertNull(LocalMode.refusal("careParagraph", NODES.textNode("off")));
        assertNotNull(LocalMode.refusal("careParagraph", NODES.textNode("maybe")));
        assertNull(LocalMode.refusal("toolGroupsOff", JSON.createArrayNode().add("web")));
        assertNotNull(LocalMode.refusal("toolGroupsOff", JSON.createArrayNode().add("everything")));
        assertNotNull(LocalMode.refusal("maxTurns", NODES.numberNode(3)), "a key the switch does not hold");
    }
}
