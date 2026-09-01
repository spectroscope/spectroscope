package dev.spectroscope.server.settings;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import dev.spectroscope.core.config.governing.GoverningNumber;
import dev.spectroscope.core.config.governing.GoverningNumbers;
import org.junit.jupiter.api.Test;

import java.util.List;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * The endpoint the settings room reads — card 357.
 *
 * <p>Nothing here types a constant, a value or a reason: the expectations are
 * the registry itself, which {@code GoverningNumbersDriftTest} holds to the
 * source tree one module down. What this file pins is that the JOURNEY loses
 * nothing — the wire shape carries every field the page needs, so a rename on
 * the record cannot leave the room drawing blanks.</p>
 */
class GoverningNumbersControllerTest {

    private static final ObjectMapper JSON = new ObjectMapper();

    private final GoverningNumbersController controller = new GoverningNumbersController();

    @Test
    void theEndpointAnswersTheWholeRegistryAndNotASelection() {
        assertEquals(GoverningNumbers.all(), controller.governingNumbers(),
                "the endpoint filtered or reordered the registry — the room would show a"
                        + " different set of numbers than the build actually runs on");
        assertFalse(controller.governingNumbers().isEmpty(),
                "an empty answer passes every other assertion here");
    }

    @Test
    void everyFieldTheRoomDrawsSurvivesTheWire() throws Exception {
        JsonNode wire = JSON.readTree(JSON.writeValueAsString(controller.governingNumbers()));
        assertEquals(GoverningNumbers.all().size(), wire.size());

        List<String> needed = List.of("owner", "field", "value", "expression",
                "kind", "unit", "key", "explanation");
        for (JsonNode entry : wire) {
            for (String name : needed) {
                assertTrue(entry.has(name), "the wire dropped \"" + name + "\" from "
                        + entry.path("field").asText() + " — the room draws it");
            }
        }

        // The kinds and units travel as their NAMES. The room groups by them and
        // translates the labels, so a Jackson setting that numbered them would
        // silently turn the taxonomy into ordinals nobody can read.
        for (GoverningNumber number : GoverningNumbers.all()) {
            JsonNode entry = find(wire, number.owner(), number.field());
            assertEquals(number.kind().name(), entry.path("kind").asText());
            assertEquals(number.unit().name(), entry.path("unit").asText());
            assertEquals(number.value(), entry.path("value").asText());
        }
    }

    private static JsonNode find(JsonNode wire, String owner, String field) {
        for (JsonNode entry : wire) {
            if (owner.equals(entry.path("owner").asText())
                    && field.equals(entry.path("field").asText())) {
                return entry;
            }
        }
        throw new AssertionError(owner + "#" + field + " never reached the wire");
    }
}
