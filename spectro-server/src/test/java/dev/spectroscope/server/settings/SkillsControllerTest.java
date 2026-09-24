package dev.spectroscope.server.settings;

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
import static org.junit.jupiter.api.Assumptions.assumeFalse;
import static org.junit.jupiter.api.Assumptions.assumeTrue;

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

    // ---- card 410: a pack installs and uninstalls as one set -----------------------------

    private static final List<String> THREE = List.of(
            "superpowers/brainstorming", "superpowers/writing-plans", "superpowers/test-driven-development");

    private static ResponseEntity<Map<String, Object>> installSet(SkillsController c, List<?> ids,
            MockHttpServletRequest request) {
        return c.installSet(Map.of("skills", ids), request);
    }

    private static ResponseEntity<Map<String, Object>> removeSet(SkillsController c, List<?> ids,
            MockHttpServletRequest request) {
        return c.removeSet(Map.of("skills", ids), request);
    }

    @SuppressWarnings("unchecked")
    private static List<Map<String, Object>> refused(ResponseEntity<Map<String, Object>> answer) {
        return (List<Map<String, Object>>) answer.getBody().get("refused");
    }

    @Test
    void aSetInstallWritesEverySkillIntoTheUserRootAndNothingIntoTheProject() throws IOException {
        SkillsController c = marketplace();

        ResponseEntity<Map<String, Object>> answer = installSet(c, THREE, local());

        assertEquals(200, answer.getStatusCode().value());
        for (String id : THREE) {
            String leaf = id.substring(id.indexOf('/') + 1);
            assertTrue(Files.isRegularFile(userRoot.resolve("superpowers").resolve(leaf).resolve("SKILL.md")), id);
            assertTrue(Files.isRegularFile(userRoot.resolve("superpowers").resolve(leaf).resolve("LICENSE")), id);
        }
        try (var left = Files.list(projectRoot)) {
            assertEquals(List.of(), left.toList(), "the project root is never a set's destination");
        }
        @SuppressWarnings("unchecked")
        List<Map<String, Object>> installed = (List<Map<String, Object>>) answer.getBody().get("installed");
        assertEquals(THREE, installed.stream().map(r -> r.get("skill")).toList());
    }

    @Test
    void aSetInstallWithOneTakenIdWritesNothingAndNamesTheTakenOne() throws IOException {
        // All or nothing: one refusal means the other two are not written either,
        // and the refusal carries the same facts a single install's 409 does.
        SkillsController c = marketplace();
        assertEquals(200, install(c, "superpowers/writing-plans", local()).getStatusCode().value());

        ResponseEntity<Map<String, Object>> answer = installSet(c, THREE, local());

        assertEquals(409, answer.getStatusCode().value());
        List<Map<String, Object>> refused = refused(answer);
        assertEquals(1, refused.size());
        assertEquals("superpowers/writing-plans", refused.get(0).get("skill"));
        assertEquals(409, refused.get(0).get("status"));
        assertEquals("user", refused.get(0).get("root"));
        assertEquals("superpowers:writing-plans", refused.get(0).get("name"));
        assertFalse(String.valueOf(refused.get(0).get("message")).isBlank());
        assertFalse(Files.exists(userRoot.resolve("superpowers/brainstorming")));
        assertFalse(Files.exists(userRoot.resolve("superpowers/test-driven-development")));
        assertTrue(Files.isRegularFile(userRoot.resolve("superpowers/writing-plans/SKILL.md")), "and the taken one stays");
    }

    @Test
    void aSetInstallNamesAnUnknownIdAndWritesNothing() throws IOException {
        SkillsController c = marketplace();

        ResponseEntity<Map<String, Object>> answer =
                installSet(c, List.of("superpowers/brainstorming", "superpowers/../../x"), local());

        assertEquals(409, answer.getStatusCode().value());
        assertEquals(List.of("superpowers/../../x"), refused(answer).stream().map(r -> r.get("skill")).toList());
        assertEquals(404, refused(answer).get(0).get("status"));
        try (var left = Files.list(userRoot)) {
            assertEquals(List.of(), left.toList());
        }
    }

    @Test
    void aSetInstallThatFailsHalfwayTakesBackWhatItAlreadyWrote() throws IOException {
        // The first skill lands, the second one's copy breaks: the set answers
        // as a failure, so the first one must not stay behind as if it had not.
        userRoot = dir.resolve("user");
        projectRoot = dir.resolve("project");
        Files.createDirectories(userRoot);
        Files.createDirectories(projectRoot);
        SkillCatalogue breaking = new SkillCatalogue() {
            @Override
            void copy(org.springframework.core.io.Resource source, Path destination) throws IOException {
                if (destination.toString().contains("writing-plans-")) {
                    throw new IOException("disk gave up");
                }
                super.copy(source, destination);
            }
        };
        SkillsController c = new SkillsController(userRoot, projectRoot, breaking);

        ResponseEntity<Map<String, Object>> answer = installSet(c, THREE, local());

        assertEquals(500, answer.getStatusCode().value());
        assertEquals(List.of("superpowers/writing-plans"), refused(answer).stream().map(r -> r.get("skill")).toList());
        try (var left = Files.list(userRoot)) {
            assertEquals(List.of(), left.toList(), "brainstorming was written and taken back, the pack folder too");
        }
        assertFalse(Files.exists(userRoot.resolveSibling(".skill-install")), "no staging leftovers");
    }

    @Test
    void aSetInstallWhoseTakeBackCannotDeleteACopyNamesTheCopyThatStayed() throws IOException {
        // The second copy breaks, and the first one's folder will not delete.
        // That folder stays where the loader reads it, so the answer may not
        // say nothing was installed.
        userRoot = dir.resolve("user");
        projectRoot = dir.resolve("project");
        Files.createDirectories(userRoot);
        Files.createDirectories(projectRoot);
        assumeTrue(Files.getFileStore(userRoot).supportsFileAttributeView("posix"), "needs POSIX permissions");
        Path first = userRoot.resolve("superpowers/brainstorming");
        boolean[] stillWritable = {true};
        SkillCatalogue breaking = new SkillCatalogue() {
            @Override
            void copy(org.springframework.core.io.Resource source, Path destination) throws IOException {
                if (destination.toString().contains("writing-plans-")) {
                    Files.setPosixFilePermissions(first,
                            java.nio.file.attribute.PosixFilePermissions.fromString("r-xr-xr-x"));
                    stillWritable[0] = Files.isWritable(first);
                    throw new IOException("disk gave up");
                }
                super.copy(source, destination);
            }
        };
        SkillsController c = new SkillsController(userRoot, projectRoot, breaking);

        ResponseEntity<Map<String, Object>> answer;
        try {
            answer = installSet(c, THREE, local());
            assumeFalse(stillWritable[0], "running as root deletes it anyway");
        } finally {
            if (Files.exists(first)) {
                Files.setPosixFilePermissions(first, java.nio.file.attribute.PosixFilePermissions.fromString("rwxr-xr-x"));
            }
        }

        assertEquals(500, answer.getStatusCode().value());
        assertEquals(List.of("superpowers/brainstorming"), answer.getBody().get("leftover"));
        String message = String.valueOf(answer.getBody().get("message"));
        assertTrue(message.contains("superpowers/brainstorming"), message);
        assertFalse(message.startsWith("Nothing was installed"), message);
        assertEquals(List.of("superpowers/writing-plans"), refused(answer).stream().map(r -> r.get("skill")).toList());
        assertTrue(Files.isRegularFile(first.resolve("SKILL.md")), "the copy the answer names is really still there");
    }

    @Test
    void aSetRemoveThatCannotPutAFolderBackNamesItAndWhereItWaits() throws IOException {
        // The second move out fails, and the first folder will not go back.
        // It is out of the root, so the answer may not say nothing was removed,
        // and it names the holding folder the skill now waits in.
        SkillsController plain = marketplace();
        assertEquals(200, installSet(plain, List.of("humanizer/humanizer", "superpowers/brainstorming"), local())
                .getStatusCode().value());
        Path humanizer = userRoot.resolve("humanizer/humanizer");
        Path brainstorming = userRoot.resolve("superpowers/brainstorming");
        SkillsController c = new SkillsController(userRoot, projectRoot) {
            @Override
            void move(Path from, Path to) throws IOException {
                if (from.equals(brainstorming) || to.equals(humanizer)) {
                    throw new IOException("the disk said no");
                }
                super.move(from, to);
            }
        };

        ResponseEntity<Map<String, Object>> answer =
                removeSet(c, List.of("humanizer/humanizer", "superpowers/brainstorming"), local());

        assertEquals(500, answer.getStatusCode().value());
        assertEquals(List.of("humanizer/humanizer"), answer.getBody().get("leftover"));
        String message = String.valueOf(answer.getBody().get("message"));
        assertTrue(message.contains("humanizer/humanizer"), message);
        assertFalse(message.startsWith("Nothing was removed"), message);
        assertEquals(List.of("superpowers/brainstorming"), refused(answer).stream().map(r -> r.get("skill")).toList());
        Path holding = Path.of(String.valueOf(answer.getBody().get("holding")));
        assertTrue(holding.startsWith(userRoot.resolveSibling(".skill-remove")), holding.toString());
        assertTrue(message.contains(holding.toString()), message);
        assertTrue(Files.isRegularFile(holding.resolve("0").resolve("SKILL.md")), "it waits where the answer says");
        assertFalse(Files.exists(humanizer), "and it is out of the root");
        assertTrue(Files.isRegularFile(brainstorming.resolve("SKILL.md")), "the one that failed to move stays");
    }

    @Test
    void aSetNeedsANonEmptyListOfIds() throws IOException {
        SkillsController c = marketplace();

        assertEquals(400, c.installSet(Map.of(), local()).getStatusCode().value());
        assertEquals(400, installSet(c, List.of(), local()).getStatusCode().value());
        assertEquals(400, installSet(c, List.of(7), local()).getStatusCode().value());
        assertEquals(400, installSet(c, List.of(" "), local()).getStatusCode().value());
        assertEquals(400, c.removeSet(Map.of("skills", "superpowers/brainstorming"), local()).getStatusCode().value());
    }

    @Test
    void aSetRemoveTakesOutExactlyTheNamedSkills() throws IOException {
        SkillsController c = marketplace();
        installSet(c, THREE, local());

        ResponseEntity<Map<String, Object>> answer =
                removeSet(c, List.of("superpowers/brainstorming", "superpowers/writing-plans"), local());

        assertEquals(200, answer.getStatusCode().value());
        assertEquals(List.of("superpowers/brainstorming", "superpowers/writing-plans"),
                answer.getBody().get("removed"));
        assertFalse(Files.exists(userRoot.resolve("superpowers/brainstorming")));
        assertFalse(Files.exists(userRoot.resolve("superpowers/writing-plans")));
        assertTrue(Files.isRegularFile(userRoot.resolve("superpowers/test-driven-development/SKILL.md")));

        assertEquals(200, removeSet(c, List.of("superpowers/test-driven-development"), local())
                .getStatusCode().value());
        try (var left = Files.list(userRoot)) {
            assertEquals(List.of(), left.toList(), "the emptied pack folder goes with its last skill");
        }
        assertFalse(Files.exists(userRoot.resolveSibling(".skill-remove")), "no holding folder left behind");
    }

    @Test
    void aSetRemoveWithOneRefusalRemovesNothing() throws IOException {
        SkillsController c = marketplace();
        install(c, "superpowers/brainstorming", local());
        Files.createDirectories(projectRoot.resolve("superpowers/writing-plans"));
        Files.writeString(projectRoot.resolve("superpowers/writing-plans/SKILL.md"), "theirs");

        ResponseEntity<Map<String, Object>> answer = removeSet(c, THREE, local());

        assertEquals(409, answer.getStatusCode().value());
        Map<Object, Object> byId = new java.util.HashMap<>();
        refused(answer).forEach(r -> byId.put(r.get("skill"), r.get("status")));
        assertEquals(Map.of("superpowers/writing-plans", 409, "superpowers/test-driven-development", 404), byId);
        assertEquals("project", refused(answer).stream()
                .filter(r -> "superpowers/writing-plans".equals(r.get("skill"))).findFirst().orElseThrow().get("root"));
        assertTrue(Files.isRegularFile(userRoot.resolve("superpowers/brainstorming/SKILL.md")), "nothing was removed");
        assertTrue(Files.isRegularFile(projectRoot.resolve("superpowers/writing-plans/SKILL.md")));
    }

    @Test
    void aSetRemoveThatFailsHalfwayPutsBackWhatItAlreadyMoved() throws IOException {
        // Two packs, the second one's folder read-only: the first skill has
        // already left the root when the second one cannot. All or nothing
        // means the first one comes back.
        SkillsController c = marketplace();
        assertEquals(200, installSet(c, List.of("humanizer/humanizer", "superpowers/brainstorming"), local())
                .getStatusCode().value());
        Path pack = userRoot.resolve("superpowers");
        java.util.Set<java.nio.file.attribute.PosixFilePermission> before;
        try {
            before = Files.getPosixFilePermissions(pack);
        } catch (UnsupportedOperationException notPosix) {
            org.junit.jupiter.api.Assumptions.assumeTrue(false, "needs POSIX permissions");
            return;
        }
        Files.setPosixFilePermissions(pack, java.nio.file.attribute.PosixFilePermissions.fromString("r-xr-xr-x"));
        ResponseEntity<Map<String, Object>> answer;
        try {
            assumeFalse(Files.isWritable(pack), "running as root moves it anyway");
            answer = removeSet(c, List.of("humanizer/humanizer", "superpowers/brainstorming"), local());
        } finally {
            Files.setPosixFilePermissions(pack, before);
        }

        assertEquals(500, answer.getStatusCode().value());
        assertEquals(List.of("superpowers/brainstorming"), refused(answer).stream().map(r -> r.get("skill")).toList());
        assertTrue(Files.isRegularFile(userRoot.resolve("humanizer/humanizer/SKILL.md")), "the moved one is back");
        assertTrue(Files.isRegularFile(userRoot.resolve("superpowers/brainstorming/SKILL.md")));
        assertFalse(Files.exists(userRoot.resolveSibling(".skill-remove")), "no holding folder left behind");
    }

    @Test
    void theFullFenceGuardsBothSetRoutes() throws IOException {
        SkillsController c = marketplace();
        install(c, "superpowers/brainstorming", local());

        MockHttpServletRequest rebound = local();
        rebound.setServerName("attacker.example");
        assertEquals(404, installSet(c, THREE, rebound).getStatusCode().value());
        assertNull(installSet(c, THREE, rebound).getBody(), "a refusal says nothing");

        MockHttpServletRequest crossSite = local();
        crossSite.addHeader("Origin", "https://evil.example");
        assertEquals(404, removeSet(c, List.of("superpowers/brainstorming"), crossSite).getStatusCode().value());

        MockHttpServletRequest remote = local();
        remote.setRemoteAddr("203.0.113.7");
        assertEquals(404, removeSet(c, List.of("superpowers/brainstorming"), remote).getStatusCode().value());

        assertTrue(Files.isRegularFile(userRoot.resolve("superpowers/brainstorming/SKILL.md")));
        assertFalse(Files.exists(userRoot.resolve("superpowers/writing-plans")));
    }

    @Test
    @SuppressWarnings("unchecked")
    void aCatalogueRowSaysWhichRootCarriesItReadFreshOnEveryList() throws IOException {
        // The count the pack header shows is read from these rows, so they must
        // follow the disk, not an earlier answer: a folder written or deleted
        // behind the server's back shows on the next list.
        SkillsController c = marketplace();
        java.util.function.Supplier<Map<String, Object>> brainstorming = () -> row(
                (List<Map<String, Object>>) c.list(local()).getBody().get("catalogue"), "superpowers/brainstorming");

        assertNull(brainstorming.get().get("root"));
        assertTrue(brainstorming.get().containsKey("root"), "the field is there, empty, when nothing carries it");

        Files.createDirectories(userRoot.resolve("superpowers/brainstorming"));
        assertEquals("user", brainstorming.get().get("root"));
        assertEquals(true, brainstorming.get().get("installed"));

        Files.delete(userRoot.resolve("superpowers/brainstorming"));
        Files.createDirectories(projectRoot.resolve("superpowers/brainstorming"));
        assertEquals("project", brainstorming.get().get("root"));
        assertEquals(true, brainstorming.get().get("installed"));

        Files.delete(projectRoot.resolve("superpowers/brainstorming"));
        assertNull(brainstorming.get().get("root"));
        assertEquals(false, brainstorming.get().get("installed"));
    }
}
