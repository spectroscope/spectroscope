package dev.spectroscope.core.playbook;

import org.junit.jupiter.api.Test;

import java.util.List;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

class AgentFileTest {

    static final String PATH = "agents/reviewer.md";

    static final String VALID = """
        ---
        name: reviewer
        description: Reads the diff against the spec and returns pass or fail.
        type: explore
        skill: spectropowers:requesting-code-review
        ---
        You are the reviewer.
        Read the diff first.
        """;

    private static AgentFile.Read read(String raw) {
        return AgentFile.read(raw, PATH);
    }

    private static List<String> paths(AgentFile.Read r) {
        return r.findings().stream().map(Finding::path).toList();
    }

    @Test
    void aValidFileReadsToTheRecordWithTheBodyAsPreamble() {
        AgentFile.Read r = read(VALID);
        assertEquals(List.of(), r.findings());
        AgentFile a = r.agent();
        assertNotNull(a);
        assertEquals("reviewer", a.name());
        assertEquals("Reads the diff against the spec and returns pass or fail.", a.description());
        assertEquals("explore", a.type());
        assertEquals("spectropowers:requesting-code-review", a.skill());
        assertEquals("You are the reviewer.\nRead the diff first.", a.preamble());
    }

    @Test
    void theSkillFieldIsOptionalAndQuotedValuesAreUnquotedOnce() {
        AgentFile.Read r = read("""
            ---
            name: "reviewer"
            description: 'Reads the diff.'
            type: worker
            ---
            Body.
            """);
        assertEquals(List.of(), r.findings());
        assertNull(r.agent().skill());
        assertEquals("reviewer", r.agent().name());
        assertEquals("Reads the diff.", r.agent().description());
        assertEquals("worker", r.agent().type());
    }

    @Test
    void windowsLineEndingsReadTheSame() {
        AgentFile.Read r = read(VALID.replace("\n", "\r\n"));
        assertEquals(List.of(), r.findings());
        assertEquals("reviewer", r.agent().name());
        assertEquals("explore", r.agent().type());
        assertTrue(r.agent().preamble().startsWith("You are the reviewer."));
    }

    @Test
    void aBeltIsOneFindingAndTheAgentIsStillRead() {
        AgentFile.Read r = read(VALID.replace("type: explore", "type: explore\nbelt: [read_file]"));
        assertEquals(List.of(PATH + "#belt"), paths(r));
        assertTrue(r.findings().get(0).message().contains("the belt follows the type and the model follows the step"));
        assertNotNull(r.agent());
        assertEquals("explore", r.agent().type());
    }

    @Test
    void modelPermissionAndToolsGetTheSameSentence() {
        for (String field : List.of("model", "permission", "tools")) {
            AgentFile.Read r = read(VALID.replace("type: explore", "type: explore\n" + field + ": x"));
            assertEquals(List.of(PATH + "#" + field), paths(r), field);
            assertTrue(r.findings().get(0).message().contains("a playbook cannot set them"), field);
            assertNotNull(r.agent(), field);
        }
    }

    @Test
    void anUnknownFieldIsOneFindingAndTheAgentIsStillRead() {
        AgentFile.Read r = read(VALID.replace("type: explore", "type: explore\nmood: grumpy"));
        assertEquals(List.of(PATH + "#mood"), paths(r));
        assertEquals("unknown field", r.findings().get(0).message());
        assertNotNull(r.agent());
    }

    @Test
    void aRefusedFieldMakesTheAgentNull() {
        AgentFile.Read r = read(VALID.replace("type: explore", "type: explore\napiKey: x"));
        assertEquals(List.of(PATH + "#apiKey"), paths(r));
        assertEquals(PlaybookReader.REFUSAL, r.findings().get(0).message());
        assertNull(r.agent());
    }

    @Test
    void everyFieldOfTheP2RefusalSetRefusesTheFile() {
        for (String field : PlaybookReader.REFUSED) {
            AgentFile.Read r = read(VALID.replace("type: explore", "type: explore\n" + field + ": x"));
            assertEquals(List.of(PATH + "#" + field), paths(r), field);
            assertNull(r.agent(), field);
        }
    }

    @Test
    void aTypeOutsideTheClosedSetIsAFinding() {
        AgentFile.Read r = read(VALID.replace("type: explore", "type: boss"));
        assertEquals(List.of(PATH + "#type"), paths(r));
        assertTrue(r.findings().get(0).message().contains("explore, research, worker"));
    }

    @Test
    void everyTypeOfTheClosedSetReadsClean() {
        for (String type : AgentFile.TYPES) {
            AgentFile.Read r = read(VALID.replace("type: explore", "type: " + type));
            assertEquals(List.of(), r.findings(), type);
            assertEquals(type, r.agent().type());
        }
        assertEquals(java.util.Set.of("explore", "worker", "research"), AgentFile.TYPES);
        assertEquals(java.util.Set.of("name", "description", "type", "skill"), AgentFile.FIELDS);
    }

    @Test
    void aMissingTypeIsAFinding() {
        AgentFile.Read r = read(VALID.replace("type: explore\n", ""));
        assertEquals(List.of(PATH + "#type"), paths(r));
    }

    @Test
    void aNameThatIsNotTheFileStemNamesTheStem() {
        AgentFile.Read r = read(VALID.replace("name: reviewer", "name: other"));
        assertEquals(List.of(PATH + "#name"), paths(r));
        assertTrue(r.findings().get(0).message().contains("reviewer"));
        assertNotNull(r.agent());
    }

    @Test
    void aMissingNameIsAFinding() {
        AgentFile.Read r = read(VALID.replace("name: reviewer\n", ""));
        assertEquals(List.of(PATH + "#name"), paths(r));
    }

    @Test
    void aMissingDescriptionIsAFinding() {
        AgentFile.Read r = read(VALID.replace("description: Reads the diff against the spec and returns pass or fail.\n", ""));
        assertEquals(List.of(PATH + "#description"), paths(r));
    }

    @Test
    void anEmptyBodyIsAFinding() {
        AgentFile.Read r = read("""
            ---
            name: reviewer
            description: d
            type: explore
            ---
            \s\s
            """);
        assertEquals(List.of(PATH + "#body"), paths(r));
    }

    @Test
    void aBlockScalarIsAFindingAtItsField() {
        for (String marker : List.of("|", ">", "|-", ">+", "|2")) {
            AgentFile.Read r = read(VALID.replace("description: Reads the diff against the spec and returns pass or fail.",
                    "description: " + marker));
            assertTrue(paths(r).contains(PATH + "#description"), marker);
            assertTrue(r.findings().stream().anyMatch(f -> f.message().contains("block scalar")), marker);
        }
    }

    @Test
    void aFileWithoutFrontmatterIsOneFindingAtThePath() {
        AgentFile.Read r = read("You are the reviewer.\n");
        assertEquals(List.of(PATH), paths(r));
        assertNull(r.agent());
    }

    @Test
    void frontmatterThatNeverClosesIsOneFindingAtThePath() {
        AgentFile.Read r = read("---\nname: reviewer\ndescription: d\ntype: explore\nBody.\n");
        assertEquals(List.of(PATH), paths(r));
        assertNull(r.agent());
    }

    @Test
    void aLineThatIsNotKeyValueIsAFindingAtThePath() {
        AgentFile.Read r = read(VALID.replace("type: explore", "type: explore\njust some words"));
        assertEquals(List.of(PATH), paths(r));
    }

    @Test
    void aValueMayContainAColon() {
        AgentFile.Read r = read(VALID.replace("returns pass or fail.", "returns: pass or fail."));
        assertEquals(List.of(), r.findings());
        assertEquals("Reads the diff against the spec and returns: pass or fail.", r.agent().description());
    }

    @Test
    void theStemComesFromTheLastPathSegment() {
        AgentFile.Read r = AgentFile.read(VALID.replace("name: reviewer", "name: other"), "agents/other.md");
        assertEquals(List.of(), r.findings());
        assertEquals("other", r.agent().name());
    }
}
