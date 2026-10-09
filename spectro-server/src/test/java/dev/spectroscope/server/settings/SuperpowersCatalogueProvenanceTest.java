package dev.spectroscope.server.settings;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.Test;

import java.io.IOException;
import java.io.InputStream;
import java.util.List;
import java.util.Set;
import java.util.TreeSet;
import java.util.stream.Collectors;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * Card 479: the vendored superpowers pack is the 6.3.0 release, named by its
 * commit, and carries exactly the fourteen skills of that release.
 */
class SuperpowersCatalogueProvenanceTest {

    private static final ObjectMapper JSON = new ObjectMapper();

    private static final String COMMIT = "b36e0829c6d0140e93cfef2ca599b1b07d4a7797";

    private static final Set<String> SKILLS = new TreeSet<>(List.of(
            "brainstorming", "dispatching-parallel-agents", "executing-plans",
            "finishing-a-development-branch", "receiving-code-review", "requesting-code-review",
            "subagent-driven-development", "systematic-debugging", "test-driven-development",
            "using-git-worktrees", "using-superpowers", "verification-before-completion",
            "writing-plans", "writing-skills"));

    private static byte[] classpath(String path) throws IOException {
        try (InputStream in = SuperpowersCatalogueProvenanceTest.class.getClassLoader().getResourceAsStream(path)) {
            assertNotNull(in, "missing on the classpath: " + path);
            return in.readAllBytes();
        }
    }

    @Test
    void provenanceNamesTheSixPointThreePointZeroRelease() throws IOException {
        JsonNode p = JSON.readTree(classpath("skills-catalogue/superpowers/PROVENANCE.json"));

        assertEquals(COMMIT, p.path("commit").asText());
        assertEquals("6.3.0", p.path("version").asText());
        assertEquals("v6.3.0", p.path("tag").asText());
        assertEquals("https://github.com/obra/superpowers", p.path("repo").asText());
        assertEquals("MIT", p.path("licence").asText());
    }

    @Test
    void thePackListsExactlyTheFourteenSkillsOfTheRelease() {
        Set<String> ids = SkillCatalogue.index().stream()
                .map(SkillCatalogue.Entry::id)
                .filter(id -> id.startsWith("superpowers/"))
                .map(id -> id.substring("superpowers/".length()))
                .collect(Collectors.toCollection(TreeSet::new));

        assertEquals(SKILLS, ids);
        assertEquals(14, ids.size());
    }

    @Test
    void aSubFileAddedInSixPointThreeIsCarried() throws IOException {
        byte[] hermes = classpath("skills-catalogue/superpowers/skills/using-superpowers/references/hermes-tools.md");

        assertTrue(hermes.length > 0, "hermes-tools.md is empty");
    }
}
