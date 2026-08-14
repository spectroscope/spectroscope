package dev.spectroscope.server.settings;

import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * First-start skill seeding (card 90): the bundled skills reach a fresh
 * ~/.spectro/skills exactly once — a user's edit is never overwritten and a
 * user's DELETION sticks (the .seeded ledger remembers the offer).
 */
class BundledSkillsTest {

    @TempDir
    Path home;

    private final Map<String, String> bundled = Map.of(
            "brainstorming", "# brainstorming\nbody",
            "verification", "# verification\nbody");

    @Test
    void aFreshHomeReceivesEveryBundledSkillOnce() throws IOException {
        List<String> seeded = BundledSkills.seed(bundled, home);
        assertEquals(2, seeded.size());
        assertTrue(Files.readString(home.resolve("brainstorming/SKILL.md")).startsWith("# brainstorming"));
        assertTrue(Files.readString(home.resolve(".seeded")).contains("verification"));
    }

    @Test
    void aUsersEditIsNeverOverwritten() throws IOException {
        BundledSkills.seed(bundled, home);
        Files.writeString(home.resolve("brainstorming/SKILL.md"), "MY OWN VERSION");
        BundledSkills.seed(bundled, home);
        assertEquals("MY OWN VERSION", Files.readString(home.resolve("brainstorming/SKILL.md")));
    }

    @Test
    void aUsersDeletionSticks() throws IOException {
        BundledSkills.seed(bundled, home);
        Files.delete(home.resolve("verification/SKILL.md"));
        Files.delete(home.resolve("verification"));
        List<String> second = BundledSkills.seed(bundled, home);
        assertEquals(0, second.size(), "a deleted seeded skill must not come back");
        assertFalse(Files.exists(home.resolve("verification")));
    }

    @Test
    void aPreexistingUserSkillOfTheSameNameStaysUntouched() throws IOException {
        Files.createDirectories(home.resolve("brainstorming"));
        Files.writeString(home.resolve("brainstorming/SKILL.md"), "the user's own");
        List<String> seeded = BundledSkills.seed(bundled, home);
        assertEquals("the user's own", Files.readString(home.resolve("brainstorming/SKILL.md")));
        assertFalse(seeded.contains("brainstorming"));
    }

    // ---- card 207: the product's own PACK skill ships namespaced ----------------------

    @Test
    void aPackSkillSeedsIntoItsNamespacedFolder() throws IOException {
        Map<String, String> withPack = Map.of("spectroscope/research", "# research\nbody");
        List<String> seeded = BundledSkills.seed(withPack, home);
        assertEquals(List.of("spectroscope/research"), seeded);
        assertTrue(Files.readString(home.resolve("spectroscope/research/SKILL.md"))
                .startsWith("# research"));
        assertTrue(Files.readString(home.resolve(".seeded")).contains("spectroscope/research"));
    }

    @Test
    void aDeletedPackSkillStaysDeleted() throws IOException {
        Map<String, String> withPack = Map.of("spectroscope/research", "# research\nbody");
        BundledSkills.seed(withPack, home);
        Files.delete(home.resolve("spectroscope/research/SKILL.md"));
        Files.delete(home.resolve("spectroscope/research"));
        Files.delete(home.resolve("spectroscope"));
        assertEquals(0, BundledSkills.seed(withPack, home).size(),
                "a deleted pack skill must not come back");
        assertFalse(Files.exists(home.resolve("spectroscope")));
    }

    @Test
    void theShippedBundleCarriesTheNamespacedResearchSkill() throws IOException {
        Map<String, String> bundle = BundledSkills.readBundle();
        assertTrue(bundle.containsKey("verification"),
                "flat bundled skills keep their bare name: " + bundle.keySet());
        assertTrue(bundle.containsKey("spectroscope/research"),
                "the research skill ships as the spectroscope pack (card 207): " + bundle.keySet());
    }
}
