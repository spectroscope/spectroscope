package dev.spectroscope.core.config;

import org.junit.jupiter.api.Test;

import java.lang.reflect.RecordComponent;
import java.util.ArrayList;
import java.util.List;
import java.util.Set;
import java.util.TreeSet;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * Card 493, criterion 8: the switch's table and the knob keys are one list.
 *
 * <p>The knob keys are read off the record: every {@link SpectroConfig}
 * component marked {@link LocalModeKnob}. A knob key without a preset value
 * turns this red, and so does a preset value for a key that is not a marked
 * component. Nothing here types a key name.</p>
 */
class LocalModeKnobsDriftTest {

    private static Set<String> markedComponents() {
        Set<String> marked = new TreeSet<>();
        for (RecordComponent component : SpectroConfig.class.getRecordComponents()) {
            if (component.isAnnotationPresent(LocalModeKnob.class)) {
                marked.add(component.getName());
            }
        }
        return marked;
    }

    @Test
    void theRecordMarksSomeKnobs() {
        assertFalse(markedComponents().isEmpty(),
                "no SpectroConfig component carries @LocalModeKnob, so this guard watches nothing");
    }

    @Test
    void everyMarkedKnobHasAPresetValueAndEveryPresetValueAMarkedKnob() {
        Set<String> preset = new TreeSet<>(LocalMode.preset().keySet());
        List<String> problems = new ArrayList<>();
        for (String knob : markedComponents()) {
            if (!preset.contains(knob)) {
                problems.add(knob + " is a knob of the Local mode switch with no preset value");
            }
        }
        for (String key : preset) {
            if (!markedComponents().contains(key)) {
                problems.add(key + " has a preset value and is no marked SpectroConfig component");
            }
        }
        assertTrue(problems.isEmpty(), String.join("\n", problems));
    }

    @Test
    void theKnobListIsReadOffTheRecord() {
        assertEquals(markedComponents(), new TreeSet<>(LocalMode.knobs()),
                "LocalMode.knobs() is not the list of marked components");
    }

    @Test
    void everyPresetValueIsOneTheSwitchItselfWouldAccept() {
        LocalMode.preset().forEach((key, value) -> assertEquals(null, LocalMode.refusal(key, value),
                "the preset value of " + key + " is refused by the switch's own check"));
    }

    @Test
    void theRecordKeyIsAKeyTheWriterKnows() {
        assertTrue(SettingsWriter.knownKeys().contains(LocalMode.RECORD_KEY),
                "the switch writes " + LocalMode.RECORD_KEY + " into the local file and the writer refuses it");
    }
}
