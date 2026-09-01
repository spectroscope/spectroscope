package dev.spectroscope.core.launch;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import dev.spectroscope.core.CancelSignal;
import dev.spectroscope.core.tools.StandardTools;
import dev.spectroscope.core.tools.Tool;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.Map;
import java.util.function.Function;
import java.util.stream.Collectors;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * Card 352, criterion 1: the door that was bolted while the wall had a hole.
 *
 * <p><b>What was already true.</b> {@code ClaudeFolderStaysTheirsDriftTest} pins
 * that no source reachable from a tool touches {@link LaunchWriter}, so no tool
 * can author a launch file through the product's own writer. Card 350 built that
 * guard and it holds.
 *
 * <p><b>What was measured on 2026-09-01 and was not true.</b> The agent does not
 * need {@link LaunchWriter}. {@code write_file} takes a free path and free
 * content, and {@code .spectro/launch.json} is inside the working directory, so
 * the sandbox waves it through — an agent could write the very file the code
 * calls "a remote-code-execution primitive wearing a config file's clothes",
 * then have {@code launch_start} run it. The refusal criterion 1 asks for was by
 * OMISSION: nothing offered to write one, and nothing declined either.
 *
 * <p><b>What this fixes and what it deliberately does not.</b> It closes the
 * launch file specifically, at both locations the reader searches, because that
 * is the file this card is about. It is not a general rule about {@code
 * .spectro} or about another vendor's folder — an agent may still write a
 * settings file or a skill, which are gated the ordinary way and start no
 * process. And it is not a claim that a determined model cannot reach the same
 * effect: {@code run_command} exists and is gated by the same prompt. What it
 * ends is the case where writing a launch entry looks like writing any other
 * text file, which is exactly how it would happen by accident.
 */
class AgentsCannotAuthorALaunchFileTest {

    private static final ObjectMapper JSON = new ObjectMapper();

    /** A launch file an agent might plausibly write for itself. */
    private static final String AN_ENTRY = """
            {"version":"0.0.1","configurations":[
              {"name":"dev","runtimeExecutable":"npm","runtimeArgs":["run","dev"],"port":5173}]}
            """;

    private static Map<String, Tool> tools() {
        return StandardTools.all().stream()
                .collect(Collectors.toMap(Tool::name, Function.identity()));
    }

    private static Tool.ToolContext contextIn(Path cwd) {
        return new Tool.ToolContext(cwd, new CancelSignal());
    }

    /**
     * Both locations, derived rather than typed.
     *
     * <p>The canon's own lesson: a hand-list guarded by a test that types the
     * same hand-list is two copies of one lie. If {@link LaunchFile#LOCATIONS}
     * grows a third place the reader searches, this test asks about it without
     * anybody remembering to.
     */
    @Test
    void neitherWriteToolWillAuthorALaunchFileAtAnyLocationTheReaderSearches(
            @TempDir Path project) {
        Tool write = tools().get("write_file");
        assertFalse(LaunchFile.LOCATIONS.isEmpty(), "the reader searches nowhere at all");
        for (String location : LaunchFile.LOCATIONS) {
            ObjectNode input = JSON.createObjectNode()
                    .put("path", location).put("content", AN_ENTRY);

            String said = write.execute(input, contextIn(project));

            assertTrue(said.startsWith("ERROR: "), location + ": " + said);
            assertTrue(said.contains(location), "the sentence names the file: " + said);
            assertFalse(Files.exists(project.resolve(location)),
                    "and nothing was written: " + location);
        }
    }

    /** The sentence says WHY, and points at the road that is open. */
    @Test
    void theRefusalNamesTheReasonRatherThanJustSayingNo(@TempDir Path project) {
        String said = tools().get("write_file").execute(JSON.createObjectNode()
                .put("path", LaunchFile.OURS).put("content", AN_ENTRY), contextIn(project));

        assertTrue(said.toLowerCase().contains("launch configuration"), said);
        assertTrue(said.contains("run"),
                "a model reading this has to learn that the file STARTS a program,"
                        + " not merely that a path is forbidden: " + said);
    }

    /**
     * And the edit tool too, which is the same authority one keystroke apart.
     *
     * <p>A guard on {@code write_file} alone would be the kind of fix that reads
     * as done: {@code edit_file} can turn an existing entry's {@code
     * runtimeExecutable} into anything at all, which is the whole of the danger
     * with none of the effort.
     */
    @Test
    void anExistingLaunchFileCannotBeEditedEither(@TempDir Path project) throws Exception {
        Files.createDirectories(project.resolve(LaunchFile.OURS).getParent());
        Files.writeString(project.resolve(LaunchFile.OURS), AN_ENTRY, StandardCharsets.UTF_8);

        String said = tools().get("edit_file").execute(JSON.createObjectNode()
                .put("path", LaunchFile.OURS)
                .put("old_string", "npm")
                .put("new_string", "/bin/sh"), contextIn(project));

        assertTrue(said.startsWith("ERROR: "), said);
        assertEquals(AN_ENTRY, Files.readString(project.resolve(LaunchFile.OURS),
                StandardCharsets.UTF_8), "the file is byte-identical after the refusal");
    }

    /**
     * The guard is about the launch file, not about the folder it sits in.
     *
     * <p>Stated as a test because the cheap over-reach would be to refuse
     * everything under {@code .spectro}, and that would break the settings and
     * skill writing this product already does through paths an agent legitimately
     * touches. The line is the file the reader would RUN.
     */
    @Test
    void anOrdinaryFileBesideItIsStillWritable(@TempDir Path project) {
        String said = tools().get("write_file").execute(JSON.createObjectNode()
                .put("path", dev.spectroscope.core.config.SpectroDir.project("notes.md"))
                .put("content", "# notes\n"), contextIn(project));

        assertFalse(said.startsWith("ERROR"), said);
    }

    /**
     * A path that RESOLVES to the launch file is the same file.
     *
     * <p>The refusal is asked of the resolved path, not of the string the model
     * typed. A check on the raw argument would be defeated by
     * {@code ./.spectro/../.spectro/launch.json}, which is the first thing
     * anybody tries and the reason the sandbox normalises before it judges.
     */
    @Test
    void aPathThatWalksAroundAndComesBackIsTheSameFile(@TempDir Path project) {
        String said = tools().get("write_file").execute(JSON.createObjectNode()
                .put("path", "docs/../" + LaunchFile.OURS).put("content", AN_ENTRY),
                contextIn(project));

        assertTrue(said.startsWith("ERROR: "), said);
        assertFalse(Files.exists(project.resolve(LaunchFile.OURS)), "nothing was written");
    }

    /**
     * A capital letter is not a different file on the machines this ships to.
     *
     * <p>APFS and NTFS are case-insensitive by default, so {@code
     * .spectro/Launch.json} IS the launch file on a Mac and on Windows, and an
     * exact string match would be a guard anybody walks around by holding shift.
     * The comparison is therefore case-insensitive everywhere, which on a
     * case-sensitive file system refuses a path that would have been a different
     * file — an over-refusal of a name nobody legitimately writes, and the safe
     * direction for a door meant to be shut.
     */
    @Test
    void aCapitalLetterDoesNotWalkPastIt(@TempDir Path project) {
        String said = tools().get("write_file").execute(JSON.createObjectNode()
                .put("path", ".spectro/Launch.json").put("content", AN_ENTRY),
                contextIn(project));

        assertTrue(said.startsWith("ERROR: "), said);
        assertFalse(Files.exists(project.resolve(".spectro/Launch.json")), "nothing was written");
    }

    /** And the tier map still carries no writing launch verb — the other half of the door. */
    @Test
    void theProductStillOffersTheModelNoLaunchWritingVerb() {
        List<String> launchTools = StandardTools.all().stream().map(Tool::name)
                .filter(name -> name.startsWith("launch_")).toList();
        assertEquals(List.of(), launchTools,
                "the standard belt carries no launch verb at all; the five of card 202"
                        + " are built by LaunchTools and none of them writes: " + launchTools);
    }
}
