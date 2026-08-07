package dev.spectroscope.server;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import dev.spectroscope.core.skills.Skill;
import dev.spectroscope.core.skills.SkillLibrary;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.springframework.core.io.Resource;

import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.attribute.PosixFilePermission;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Set;
import java.util.stream.Stream;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * Card 182's shelf: the vendored catalogue is enumerated off the classpath, and
 * one chosen skill is copied — whole leaf directory, licence beside it, nothing
 * executed, nothing overwritten — into the user's skills root.
 */
class SkillCatalogueTest {

    private static final ObjectMapper JSON = new ObjectMapper();

    /** Measured against this tree's {@code .spectro/skills-catalogue}. */
    private static final int CATALOGUE_SIZE = 57;

    @TempDir
    Path dir;

    private Path root;

    private Path root() throws IOException {
        root = dir.resolve("skills");
        Files.createDirectories(root);
        return root;
    }

    /** The destination the controller derives: {@code <root>/<pack>/<skill>}. */
    private Path into(String pack, String skill) throws IOException {
        return root().resolve(pack).resolve(skill);
    }

    /** Staging is a SIBLING of the skills root — a half-built folder under the
     *  root would be read as a pack while it is still being written. */
    private Path staging() throws IOException {
        return root().resolveSibling(SkillCatalogue.STAGING_DIR);
    }

    private static SkillCatalogue.Entry entry(String id) {
        return SkillCatalogue.index().stream()
                .filter(e -> e.id().equals(id))
                .findFirst()
                .orElseThrow(() -> new AssertionError("catalogue is missing " + id));
    }

    // ---- the index -----------------------------------------------------------------------

    @Test
    void theIndexFindsEveryCatalogueSkill() {
        List<SkillCatalogue.Entry> index = SkillCatalogue.index();

        assertEquals(CATALOGUE_SIZE, index.size());
        Set<String> ids = new HashSet<>();
        for (SkillCatalogue.Entry e : index) {
            assertFalse(e.id().isBlank(), "id");
            assertFalse(e.name().isBlank(), "name of " + e.id());
            assertFalse(e.pack().isBlank(), "pack of " + e.id());
            assertFalse(e.licence().isBlank(), "licence of " + e.id());
            assertFalse(e.repo().isBlank(), "repo of " + e.id());
            assertFalse(e.commit().isBlank(), "commit of " + e.id());
            assertFalse(e.description().isBlank(), "description of " + e.id());
            // The block-scalar bug would show up here and nowhere else.
            assertFalse(e.description().length() < 3, "stub description on " + e.id());
            assertTrue(e.files() > 0, "files of " + e.id());
            assertTrue(e.bytes() > 0, "bytes of " + e.id());
            assertTrue(ids.add(e.id()), "duplicate id " + e.id());
        }
    }

    @Test
    void everyEntryNamesTheLeafFolderThatHoldsSkillMd() {
        for (SkillCatalogue.Entry e : SkillCatalogue.index()) {
            String[] segments = e.dir().split("/");
            assertEquals(segments[segments.length - 1], e.name(),
                    "the name is the leaf folder, not a nesting rule: " + e.dir());
            assertTrue(e.name().matches("^[a-z0-9][a-z0-9-]*$"), "unsafe folder name " + e.name());
            assertEquals(e.pack() + "/" + e.name(), e.id());
            assertEquals(e.pack(), segments[0], "the pack is the first segment of " + e.dir());
        }
    }

    @Test
    void theAnchorSurvivesANestedBootJarUrl() {
        // A Spring Boot fat jar spells its resources jar:nested:…!…!/…, so more
        // than one "!" and an unknowable number of "/" segments precede the
        // catalogue. Anchoring on the literal directory name is the only reading
        // that does not have to count either.
        String anchor = "skills-catalogue/superpowers/skills/brainstorming/";
        assertEquals("scripts/helper.js", SkillCatalogue.relativeAfter(
                "jar:nested:/opt/app.jar/!BOOT-INF/classes/!/skills-catalogue/superpowers/"
                        + "skills/brainstorming/scripts/helper.js", anchor));
        assertEquals("scripts/helper.js", SkillCatalogue.relativeAfter(
                "file:/Users/x/build/resources/main/skills-catalogue/superpowers/"
                        + "skills/brainstorming/scripts/helper.js", anchor));
        assertNull(SkillCatalogue.relativeAfter(
                "file:/Users/x/build/resources/main/bundled-skills/verification/SKILL.md", anchor));
    }

    // ---- the install ---------------------------------------------------------------------

    @Test
    void installCopiesTheLeafDirectoryUnderItsPackAndNothingBetween() throws IOException {
        SkillCatalogue.InstallResult result = new SkillCatalogue()
                .install(entry("superpowers/brainstorming"), into("superpowers", "brainstorming"), staging());

        assertEquals(SkillCatalogue.Status.INSTALLED, result.status(), result.message());
        assertTrue(Files.isRegularFile(root.resolve("superpowers/brainstorming/SKILL.md")));
        assertTrue(Files.isRegularFile(root.resolve("superpowers/brainstorming/scripts/helper.js")),
                "sub-directories below the skill survive");
        // Exactly ONE level of nesting: the pack. The catalogue's own two depths
        // (<pack>/skills/<skill> and <pack>/skills/<category>/<skill>) are the
        // shelf's business and do not travel — the loader reads packs, not trees.
        assertFalse(Files.exists(root.resolve("superpowers/skills")), "the collection folder is flattened away");
        assertFalse(Files.exists(root.resolve("skills")), "and it does not surface at the root either");
    }

    @Test
    void installCopiesTheLicenceBesideTheSkill() throws IOException {
        new SkillCatalogue().install(entry("superpowers/brainstorming"), into("superpowers", "brainstorming"), staging());

        byte[] upstream = classpathBytes("skills-catalogue/superpowers/LICENSE");
        assertArrayEqualsBytes(upstream, Files.readAllBytes(root.resolve("superpowers/brainstorming/LICENSE")));

        JsonNode provenance = JSON.readTree(Files.readString(root.resolve("superpowers/brainstorming/PROVENANCE.json")));
        assertFalse(provenance.path("repo").asText().isBlank());
        assertFalse(provenance.path("commit").asText().isBlank());
        assertFalse(provenance.path("licence").asText().isBlank());
        assertFalse(provenance.path("copyright").asText().isBlank());
    }

    @Test
    void installWritesItsOwnProvenanceRecord() throws IOException {
        new SkillCatalogue().install(entry("superpowers/brainstorming"), into("superpowers", "brainstorming"), staging());

        JsonNode record = JSON.readTree(Files.readString(root.resolve("superpowers/brainstorming/spectro-install.json")));
        JsonNode pack = JSON.readTree(Files.readString(root.resolve("superpowers/brainstorming/PROVENANCE.json")));
        assertEquals("superpowers", record.path("pack").asText());
        assertEquals("brainstorming", record.path("skill").asText());
        assertEquals(pack.path("commit").asText(), record.path("commit").asText());
        assertEquals(pack.path("repo").asText(), record.path("repo").asText());
        assertEquals("bundled catalogue", record.path("source").asText());
        assertFalse(record.path("installedOn").asText().isBlank());
    }

    @Test
    void anUnreadableLicenceRefusesTheInstall() throws IOException {
        // Card 182: "refuse an install whose licence the installer cannot read,
        // and say why". A copy without the LICENSE beside it is a copy the MIT
        // terms do not permit, so there is nothing honest to write.
        SkillCatalogue unlicensed = new SkillCatalogue() {
            @Override
            Resource packFile(String pack, String fileName) {
                return null;
            }
        };
        SkillCatalogue.InstallResult result =
                unlicensed.install(entry("superpowers/brainstorming"), into("superpowers", "brainstorming"), staging());

        assertEquals(SkillCatalogue.Status.FAILED, result.status());
        assertTrue(result.message().contains("unlicensed"), result.message());
        assertFalse(Files.exists(root.resolve("superpowers/brainstorming")));
    }

    @Test
    void theInstalledSkillIsWhatTheLoaderLoads() throws IOException {
        new SkillCatalogue().install(entry("superpowers/brainstorming"), into("superpowers", "brainstorming"), staging());

        SkillLibrary library = SkillLibrary.load(List.of(root));
        Skill installed = library.find("superpowers:brainstorming").orElseThrow();
        Skill shelf = SkillLibrary.parse(
                new String(classpathBytes("skills-catalogue/superpowers/skills/brainstorming/SKILL.md"),
                        StandardCharsets.UTF_8),
                "brainstorming", root.resolve("superpowers/brainstorming/SKILL.md"));
        assertEquals(shelf.body().length(), installed.body().length());
        assertTrue(library.systemPromptSection().contains("- superpowers:brainstorming:"),
                "the pack it came from is part of the name the model calls");
    }

    @Test
    void uiStylingCarriesItsSecondAndThirdLicences() throws IOException {
        new SkillCatalogue().install(entry("ui-ux-pro-max/ui-styling"), into("ui-ux-pro-max", "ui-styling"), staging());

        Path skill = root.resolve("ui-ux-pro-max/ui-styling");
        assertTrue(Files.isRegularFile(skill.resolve("LICENSE.txt")), "the skill's own licence");
        // The file opens with a blank line, so the heading is the first line with
        // anything on it — measured, not assumed.
        assertTrue(Files.readString(skill.resolve("LICENSE.txt")).lines()
                .filter(line -> !line.isBlank()).findFirst().orElse("")
                .contains("Apache License"), "and it is the Apache one");
        assertTrue(Files.isRegularFile(skill.resolve("LICENSE")), "the pack's MIT licence rides too");
        try (Stream<Path> fonts = Files.list(skill.resolve("canvas-fonts"))) {
            assertEquals(27, fonts.filter(p -> p.getFileName().toString().endsWith("-OFL.txt")).count());
        }
    }

    @Test
    void aFailedCopyLeavesNothingBehind() throws IOException {
        SkillCatalogue breaking = new SkillCatalogue() {
            private int copies;

            @Override
            void copy(Resource source, Path destination) throws IOException {
                if (++copies == 3) {
                    throw new IOException("disk gave up");
                }
                super.copy(source, destination);
            }
        };
        SkillCatalogue.InstallResult result =
                breaking.install(entry("superpowers/brainstorming"), into("superpowers", "brainstorming"), staging());

        assertEquals(SkillCatalogue.Status.FAILED, result.status());
        assertFalse(Files.exists(root.resolve("superpowers/brainstorming")));
        try (Stream<Path> left = Files.list(root)) {
            assertEquals(List.of(), left.toList(), "the skills root never saw a half skill");
        }
        Path stagingRoot = staging();
        if (Files.exists(stagingRoot)) {
            try (Stream<Path> left = Files.list(stagingRoot)) {
                assertEquals(List.of(), left.toList(), "no staging leftovers");
            }
        }
    }

    @Test
    void theCeilingRefusesAnOversizedSkill() throws IOException {
        SkillCatalogue.InstallResult result = new SkillCatalogue(1, 24L * 1024 * 1024)
                .install(entry("superpowers/brainstorming"), into("superpowers", "brainstorming"), staging());

        assertEquals(SkillCatalogue.Status.TOO_LARGE, result.status());
        assertTrue(result.facts().containsKey("files"));
        assertTrue(result.facts().containsKey("bytes"));
        try (Stream<Path> left = Files.list(root)) {
            assertEquals(List.of(), left.toList());
        }
    }

    @Test
    void nothingCopiedIsExecutable() throws IOException {
        new SkillCatalogue().install(entry("superpowers/brainstorming"), into("superpowers", "brainstorming"), staging());

        Path shell = root.resolve("superpowers/brainstorming/scripts/start-server.sh");
        assertTrue(Files.isRegularFile(shell), "the shell script is copied, just not armed");
        if (!Files.getFileStore(shell).supportsFileAttributeView("posix")) {
            return; // a filesystem without a mode bit cannot set one either
        }
        List<Path> executable = new ArrayList<>();
        try (Stream<Path> walk = Files.walk(root.resolve("superpowers/brainstorming"))) {
            for (Path p : walk.filter(Files::isRegularFile).toList()) {
                if (Files.getPosixFilePermissions(p).contains(PosixFilePermission.OWNER_EXECUTE)) {
                    executable.add(p);
                }
            }
        }
        assertEquals(List.of(), executable, "nothing installed may be run as a program");
    }

    // ---- helpers -------------------------------------------------------------------------

    private static byte[] classpathBytes(String resource) throws IOException {
        try (InputStream in = SkillCatalogueTest.class.getClassLoader().getResourceAsStream(resource)) {
            assertNotNull(in, "missing classpath resource " + resource);
            return in.readAllBytes();
        }
    }

    private static void assertArrayEqualsBytes(byte[] expected, byte[] actual) {
        assertEquals(new String(expected, StandardCharsets.UTF_8), new String(actual, StandardCharsets.UTF_8));
    }
}
