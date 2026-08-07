package dev.spectroscope.server;

import dev.spectroscope.core.skills.Skill;
import dev.spectroscope.core.skills.SkillLibrary;

import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.springframework.http.ResponseEntity;
import org.springframework.mock.web.MockHttpServletRequest;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

/** The settings skill manager (card 90): list both roots incl. disabled, flip
 *  the marker, delete user-root skills only — all behind the full fence. */
class SkillsControllerTest {

    @TempDir
    Path dir;

    private Path userRoot;
    private Path projectRoot;

    private SkillsController controller() throws IOException {
        userRoot = dir.resolve("user");
        projectRoot = dir.resolve("project");
        write(userRoot, "verification", "---\ndescription: check before claiming\n---\nbody");
        write(projectRoot, "brainstorming", "---\ndescription: explore first\n---\nbody");
        return new SkillsController(userRoot, projectRoot);
    }

    private static void write(Path root, String name, String content) throws IOException {
        Files.createDirectories(root.resolve(name));
        Files.writeString(root.resolve(name).resolve("SKILL.md"), content);
    }

    private static MockHttpServletRequest local() {
        return new MockHttpServletRequest();
    }

    @SuppressWarnings("unchecked")
    private static List<Map<String, Object>> skills(SkillsController c, MockHttpServletRequest req) {
        return (List<Map<String, Object>>) c.list(req).getBody().get("skills");
    }

    @Test
    void listsBothRootsWithSourceAndDisabledState() throws IOException {
        SkillsController c = controller();
        Files.writeString(userRoot.resolve("verification").resolve(".disabled"), "");
        List<Map<String, Object>> rows = skills(c, local());
        assertEquals(2, rows.size());
        Map<String, Object> brainstorming = rows.get(0);
        assertEquals("brainstorming", brainstorming.get("name"));
        assertEquals("project", brainstorming.get("source"));
        assertEquals(false, brainstorming.get("disabled"));
        Map<String, Object> verification = rows.get(1);
        assertEquals("user", verification.get("source"));
        assertEquals(true, verification.get("disabled"));
        assertEquals("check before claiming", verification.get("description"));
    }

    @Test
    void togglesTheDisabledMarker() throws IOException {
        SkillsController c = controller();
        c.setDisabled(null, "verification", Map.of("disabled", true), local());
        assertTrue(Files.exists(userRoot.resolve("verification/.disabled")));
        c.setDisabled(null, "verification", Map.of("disabled", false), local());
        assertFalse(Files.exists(userRoot.resolve("verification/.disabled")));
    }

    @Test
    void deletesAUserSkillButRefusesAProjectSkill() throws IOException {
        SkillsController c = controller();
        assertEquals(200, c.delete(null, "verification", local()).getStatusCode().value());
        assertFalse(Files.exists(userRoot.resolve("verification")));
        assertEquals(409, c.delete(null, "brainstorming", local()).getStatusCode().value());
        assertTrue(Files.exists(projectRoot.resolve("brainstorming")));
    }

    @Test
    void refusesPathTraversalInTheName() throws IOException {
        SkillsController c = controller();
        Files.writeString(dir.resolve("outside.txt"), "precious");
        assertEquals(404, c.delete(null, "../outside.txt", local()).getStatusCode().value());
        assertTrue(Files.exists(dir.resolve("outside.txt")));
    }

    // ---- card 182: the catalogue and its install verb ------------------------------------

    /** Roots with nothing in them — the fixture's project-root brainstorming would
     *  otherwise refuse every install for the wrong reason. */
    private SkillsController marketplace() throws IOException {
        userRoot = dir.resolve("user");
        projectRoot = dir.resolve("project");
        Files.createDirectories(userRoot);
        Files.createDirectories(projectRoot);
        return new SkillsController(userRoot, projectRoot);
    }

    private static ResponseEntity<Map<String, Object>> install(SkillsController c, String id,
            MockHttpServletRequest request) {
        return c.install(id == null ? Map.of() : Map.of("skill", id), request);
    }

    @Test
    void installWritesTheSkillUnderItsPackAndAnswersWithItsFacts() throws IOException {
        SkillsController c = marketplace();

        ResponseEntity<Map<String, Object>> answer = install(c, "superpowers/brainstorming", local());

        assertEquals(200, answer.getStatusCode().value());
        assertEquals("brainstorming", answer.getBody().get("name"));
        assertEquals("superpowers", answer.getBody().get("pack"));
        assertEquals("MIT", answer.getBody().get("licence"));
        assertTrue(((Number) answer.getBody().get("files")).intValue() > 0);
        assertTrue(((Number) answer.getBody().get("bytes")).longValue() > 0);
        assertTrue(Files.isRegularFile(userRoot.resolve("superpowers/brainstorming/SKILL.md")));
        assertTrue(Files.isRegularFile(userRoot.resolve("superpowers/brainstorming/LICENSE")));
        assertFalse(Files.exists(userRoot.resolve("brainstorming")), "nothing lands at the top level");
    }

    @Test
    void installLandsBesideALocalSkillOfTheSameName() throws IOException {
        // What the namespace bought. Three catalogue skills share a name with
        // skills people write themselves; before this, a copying install had to
        // choose between clobbering one and refusing outright. Now both exist,
        // under names the model can tell apart.
        SkillsController c = marketplace();
        write(userRoot, "brainstorming", "---\nname: brainstorming\ndescription: mine\n---\nmine");

        assertEquals(200, install(c, "superpowers/brainstorming", local()).getStatusCode().value());

        assertEquals("---\nname: brainstorming\ndescription: mine\n---\nmine",
                Files.readString(userRoot.resolve("brainstorming/SKILL.md")), "the local one is untouched");
        assertTrue(Files.isRegularFile(userRoot.resolve("superpowers/brainstorming/SKILL.md")));

        List<String> loaded = SkillLibrary.load(List.of(userRoot)).skills().stream()
                .map(Skill::name).toList();
        assertEquals(List.of("brainstorming", "superpowers:brainstorming"), loaded);
    }

    @Test
    void installIgnoresATopLevelProjectSkillOfTheSameName() throws IOException {
        // The old refusal reasoned that the project layer wins by name and the
        // copy would be invisible. Namespaced it is a different name, so there
        // is nothing to lose to and nothing to say.
        SkillsController c = controller(); // project root carries a bare "brainstorming"

        assertEquals(200, install(c, "superpowers/brainstorming", local()).getStatusCode().value());
        assertTrue(Files.isRegularFile(userRoot.resolve("superpowers/brainstorming/SKILL.md")));
    }

    @Test
    void installIsRefusedWhenTheProjectCarriesTheSamePackedSkill() throws IOException {
        // The one shadowing case that survives: same pack, same skill, project
        // layer. That really would win over the copy, so say it instead of
        // writing a skill the agent never sees.
        SkillsController c = marketplace();
        Files.createDirectories(projectRoot.resolve("superpowers/brainstorming"));
        Files.writeString(projectRoot.resolve("superpowers/brainstorming/SKILL.md"), "theirs");

        ResponseEntity<Map<String, Object>> answer = install(c, "superpowers/brainstorming", local());

        assertEquals(409, answer.getStatusCode().value());
        assertEquals("project", answer.getBody().get("root"));
        assertEquals("superpowers:brainstorming", answer.getBody().get("name"));
        assertFalse(Files.exists(userRoot.resolve("superpowers")));
    }

    @Test
    void aSecondInstallOfTheSameSkillIsRefused() throws IOException {
        // Re-install is a 409, not an idempotent no-op: the folder on disk may
        // carry the user's edits and a .disabled marker, and neither survives a
        // copy over the top. The way through is DELETE, then install.
        SkillsController c = marketplace();
        assertEquals(200, install(c, "superpowers/brainstorming", local()).getStatusCode().value());
        long before = Files.size(userRoot.resolve("superpowers/brainstorming/SKILL.md"));

        ResponseEntity<Map<String, Object>> answer = install(c, "superpowers/brainstorming", local());

        assertEquals(409, answer.getStatusCode().value());
        assertEquals("user", answer.getBody().get("root"));
        assertEquals(before, Files.size(userRoot.resolve("superpowers/brainstorming/SKILL.md")));
    }

    @Test
    void theStagingDirectoryNeverSitsInsideTheSkillsRoot() throws IOException {
        // The trap the second level opens: staging used to be derived from the
        // target's parent, which was the root itself. One level deeper, that
        // same derivation lands INSIDE the root — where a half-written folder
        // already carries a SKILL.md and the loader would read it as a pack.
        SkillsController c = marketplace();
        install(c, "superpowers/brainstorming", local());

        try (var left = Files.list(userRoot)) {
            assertEquals(List.of("superpowers"),
                    left.map(p -> p.getFileName().toString()).sorted().toList());
        }
        assertFalse(Files.exists(userRoot.resolve(".skill-install")));
    }

    @Test
    void packedSkillsListToggleAndDelete() throws IOException {
        SkillsController c = marketplace();
        install(c, "superpowers/brainstorming", local());

        Map<String, Object> row = skills(c, local()).stream()
                .filter(r -> "superpowers:brainstorming".equals(r.get("name"))).findFirst().orElseThrow();
        assertEquals("superpowers", row.get("pack"));
        assertEquals("brainstorming", row.get("folder"));
        assertEquals("user", row.get("source"));
        assertEquals(false, row.get("disabled"));
        assertFalse(String.valueOf(row.get("description")).isBlank());

        c.setDisabled("superpowers", "brainstorming", Map.of("disabled", true), local());
        assertTrue(Files.exists(userRoot.resolve("superpowers/brainstorming/.disabled")));
        assertTrue(SkillLibrary.load(List.of(userRoot)).skills().isEmpty(), "and the loader drops it");

        assertEquals(200, c.delete("superpowers", "brainstorming", local()).getStatusCode().value());
        assertFalse(Files.exists(userRoot.resolve("superpowers")), "the emptied pack folder goes too");
    }

    @Test
    void anEmptiedPackIsRemovedButAPopulatedOneStays() throws IOException {
        SkillsController c = marketplace();
        install(c, "superpowers/brainstorming", local());
        install(c, "superpowers/writing-plans", local());

        c.delete("superpowers", "brainstorming", local());

        assertTrue(Files.isDirectory(userRoot.resolve("superpowers")), "the sibling still lives here");
        assertTrue(Files.isRegularFile(userRoot.resolve("superpowers/writing-plans/SKILL.md")));
    }

    @Test
    void traversalIsRefusedInBothSegments() throws IOException {
        SkillsController c = controller();
        Files.writeString(dir.resolve("outside.txt"), "precious");

        assertEquals(404, c.delete("..", "outside.txt", local()).getStatusCode().value());
        assertEquals(404, c.delete("../..", "user", local()).getStatusCode().value());
        assertEquals(404, c.delete("user", "..", local()).getStatusCode().value());
        assertEquals(404, c.setDisabled("..", "outside.txt", Map.of("disabled", true), local())
                .getStatusCode().value());

        assertEquals("precious", Files.readString(dir.resolve("outside.txt")));
        assertTrue(Files.exists(userRoot.resolve("verification")));
    }

    @Test
    void installRefusesAnUnknownCatalogueId() throws IOException {
        SkillsController c = marketplace();

        ResponseEntity<Map<String, Object>> answer = install(c, "nope/nope", local());

        assertEquals(404, answer.getStatusCode().value());
        assertTrue(String.valueOf(answer.getBody().get("message")).contains("nope/nope"));
        try (var left = Files.list(userRoot)) {
            assertEquals(List.of(), left.toList());
        }
    }

    @Test
    void installRefusesATraversalId() throws IOException {
        // The traversal test. The id is matched against the enumerated index by
        // string equality and is never resolved as a path, so a traversal-shaped
        // id is simply not on the shelf — the same answer as any other typo.
        SkillsController c = marketplace();
        Files.writeString(dir.resolve("outside.txt"), "precious");

        for (String id : List.of("../../../../etc/passwd", "superpowers/../../../../tmp/x",
                "/etc/passwd", "superpowers/skills/brainstorming")) {
            assertEquals(404, install(c, id, local()).getStatusCode().value(), id);
        }

        assertEquals("precious", Files.readString(dir.resolve("outside.txt")));
        try (var left = Files.list(userRoot)) {
            assertEquals(List.of(), left.toList());
        }
        assertFalse(Files.exists(dir.resolve("tmp")));
        assertFalse(Files.exists(dir.resolve("etc")));
    }

    @Test
    void installRefusesAMissingSkillField() throws IOException {
        SkillsController c = marketplace();

        assertEquals(400, install(c, null, local()).getStatusCode().value());
        assertEquals(400, install(c, "  ", local()).getStatusCode().value());
        assertEquals(400, c.install(Map.of("skill", 7), local()).getStatusCode().value());
    }

    @Test
    void theFullFenceGuardsInstallToo() throws IOException {
        SkillsController c = controller();

        MockHttpServletRequest rebound = local();
        rebound.setServerName("attacker.example");
        assertEquals(404, install(c, "superpowers/brainstorming", rebound).getStatusCode().value());
        assertNull(install(c, "superpowers/brainstorming", rebound).getBody(), "a refusal says nothing");

        MockHttpServletRequest crossSite = local();
        crossSite.addHeader("Origin", "https://evil.example");
        assertEquals(404, install(c, "superpowers/brainstorming", crossSite).getStatusCode().value());

        MockHttpServletRequest remote = local();
        remote.setRemoteAddr("203.0.113.7");
        assertEquals(404, install(c, "superpowers/brainstorming", remote).getStatusCode().value());

        try (var left = Files.list(userRoot)) {
            assertEquals(List.of("verification"),
                    left.map(p -> p.getFileName().toString()).sorted().toList());
        }
    }

    @Test
    @SuppressWarnings("unchecked")
    void theCatalogueRidesInTheListResponse() throws IOException {
        SkillsController c = marketplace();

        List<Map<String, Object>> before =
                (List<Map<String, Object>>) c.list(local()).getBody().get("catalogue");
        assertEquals(57, before.size());
        assertEquals(false, row(before, "superpowers/brainstorming").get("installed"));
        assertEquals("brainstorming", row(before, "superpowers/brainstorming").get("name"));
        assertEquals("superpowers", row(before, "superpowers/brainstorming").get("pack"));
        assertEquals("MIT", row(before, "superpowers/brainstorming").get("licence"));

        install(c, "superpowers/brainstorming", local());

        List<Map<String, Object>> after =
                (List<Map<String, Object>>) c.list(local()).getBody().get("catalogue");
        assertEquals(true, row(after, "superpowers/brainstorming").get("installed"));
    }

    private static Map<String, Object> row(List<Map<String, Object>> rows, String id) {
        return rows.stream().filter(r -> id.equals(r.get("id"))).findFirst().orElseThrow();
    }

    @Test
    void theFullFenceGuardsEveryRoute() throws IOException {
        SkillsController c = controller();
        MockHttpServletRequest rebound = local();
        rebound.setServerName("attacker.example");
        assertEquals(404, c.list(rebound).getStatusCode().value());
        MockHttpServletRequest crossSite = local();
        crossSite.addHeader("Origin", "https://evil.example");
        assertEquals(404, c.setDisabled(null, "verification", Map.of("disabled", true), crossSite)
                .getStatusCode().value());
        MockHttpServletRequest remote = local();
        remote.setRemoteAddr("203.0.113.7");
        assertEquals(404, c.delete(null, "verification", remote).getStatusCode().value());
        assertTrue(Files.exists(userRoot.resolve("verification")), "nothing happened");
    }
}
