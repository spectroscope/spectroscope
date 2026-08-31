package dev.spectroscope.core.events;

import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.Test;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * Card 354: {@code settings_ignored} carries what the refusal COSTS, and
 * carries it additively.
 *
 * <p>The reading is a tri-state on purpose and the wire has to keep all three
 * apart. A line written before this card took no reading at all, and a reader
 * that turns "absent" into "not in force" would put a sentence the harness
 * never measured into an old session's chat — the same class of defect as a
 * comment claiming a property the code lacks, only replayed at the operator.</p>
 */
class SettingsIgnoredCostAdditivityTest {

    private static final ObjectMapper JSON = new ObjectMapper();

    @Test
    void aFreeRefusalNamesTheScopeThatCarriesTheKey() throws Exception {
        String line = JSON.writeValueAsString(new RunEvent.SettingsIgnored(
                "allowLocalhost", "/Users/x/ForgeDemo/.spectro/settings.json",
                "the net fence's opt-in belongs in ~/.spectro/settings.json", true, "user", 99L));

        assertTrue(line.contains("\"inForce\":true"), line);
        assertTrue(line.contains("\"inForceFrom\":\"user\""), line);

        RunEvent.SettingsIgnored back = (RunEvent.SettingsIgnored) JSON.readValue(line, RunEvent.class);
        assertEquals(Boolean.TRUE, back.inForce());
        assertEquals("user", back.inForceFrom());
        assertEquals("allowLocalhost", back.key());
    }

    @Test
    void anExpensiveRefusalSaysSoAndNamesNoScope() throws Exception {
        String line = JSON.writeValueAsString(new RunEvent.SettingsIgnored(
                "searxngUrl", "/w/.spectro/settings.json", "belongs in ~/.spectro/settings.json",
                false, null, 99L));

        assertTrue(line.contains("\"inForce\":false"), line);
        assertFalse(line.contains("inForceFrom"),
                "there is no scope, so the key is absent rather than null: " + line);

        RunEvent.SettingsIgnored back = (RunEvent.SettingsIgnored) JSON.readValue(line, RunEvent.class);
        assertEquals(Boolean.FALSE, back.inForce());
        assertNull(back.inForceFrom());
    }

    @Test
    void theOldShapeDoesNotGrowAKey() throws Exception {
        // The pre-354 constructor is the whole compatibility story: a caller that
        // never heard of the reading must serialize byte-for-byte as before.
        String line = JSON.writeValueAsString(new RunEvent.SettingsIgnored(
                "allowLocalhost", "/w/.spectro/settings.json", "belongs elsewhere", 99L));

        assertFalse(line.contains("inForce"), line);
        assertEquals("{\"type\":\"settings_ignored\",\"key\":\"allowLocalhost\","
                + "\"file\":\"/w/.spectro/settings.json\",\"hint\":\"belongs elsewhere\","
                + "\"ts\":99}", line);
    }

    @Test
    void aSessionRecordedBeforeThisCardStatesNoReading() throws Exception {
        // A real pre-354 line, as the sessions on this machine carry it. It must
        // come back as "unmeasured" and NOT as "not in force" — the owner's own
        // ForgeDemo sessions are full of these, and every one of them was free.
        String old = "{\"type\":\"settings_ignored\",\"key\":\"allowLocalhost\","
                + "\"file\":\"/Users/x/ForgeDemo/.spectro/settings.json\","
                + "\"hint\":\"the net fence's opt-in belongs in ~/.spectro/settings.json\","
                + "\"ts\":1756000000000}";

        RunEvent.SettingsIgnored back = (RunEvent.SettingsIgnored) JSON.readValue(old, RunEvent.class);

        assertNull(back.inForce(), "an old line took no reading, and may not invent one");
        assertNull(back.inForceFrom());
        assertEquals("allowLocalhost", back.key());
        assertEquals(1_756_000_000_000L, back.ts());
    }
}
