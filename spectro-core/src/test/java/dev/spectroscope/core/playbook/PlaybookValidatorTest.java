package dev.spectroscope.core.playbook;

import org.junit.jupiter.api.Test;

import java.util.List;

import static org.junit.jupiter.api.Assertions.assertDoesNotThrow;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

class PlaybookValidatorTest {

    private static Playbook read(String json) {
        PlaybookReader.Read r = PlaybookReader.read(json);
        assertEquals(List.of(), r.findings(), "fixture must read clean");
        return r.playbook();
    }

    private static boolean has(List<Finding> findings, String path, String fragment) {
        return findings.stream().anyMatch(f -> f.path().equals(path) && f.message().contains(fragment));
    }

    @Test
    void theMinimalPlaybookIsValid() {
        assertEquals(List.of(), PlaybookValidator.validate(read(PlaybookReaderTest.MINIMAL)));
    }

    @Test
    void rule1SchemaVersionAndId() {
        Playbook p = read(PlaybookReaderTest.MINIMAL.replace("\"schema_version\": 1", "\"schema_version\": 2")
                .replace("\"id\": \"p\"", "\"id\": \"Bad Id\""));
        List<Finding> f = PlaybookValidator.validate(p);
        assertTrue(has(f, "schema_version", "1"), f.toString());
        assertTrue(has(f, "id", "[a-z][a-z0-9-]*"), f.toString());
    }

    @Test
    void rule2StartAndReachability() {
        Playbook p = read(PlaybookReaderTest.MINIMAL.replace("\"start\": \"write\"", "\"start\": \"nowhere\""));
        assertTrue(has(PlaybookValidator.validate(p), "start", "names no node"));
        Playbook orphan = read(PlaybookReaderTest.MINIMAL.replace(
                "{ \"kind\": \"end\", \"id\": \"done\", \"result\": \"done\" }",
                "{ \"kind\": \"end\", \"id\": \"done\", \"result\": \"done\" }, { \"kind\": \"end\", \"id\": \"lost\", \"result\": \"x\" }"));
        assertTrue(has(PlaybookValidator.validate(orphan), "nodes[3]", "not reachable from start"));
    }

    @Test
    void anArrowToAnUnknownNodeIsAFindingNotACrash() {
        Playbook p = read(PlaybookReaderTest.MINIMAL.replace(
                "{ \"from\": \"write\", \"to\": \"ok\" }", "{ \"from\": \"write\", \"to\": \"okk\" }"));
        List<Finding> f = assertDoesNotThrow(() -> PlaybookValidator.validate(p));
        assertTrue(has(f, "arrows[0].to", "okk"), f.toString());
    }

    @Test
    void rule3OneArrowPerOutcome() {
        Playbook missing = read(PlaybookReaderTest.MINIMAL.replace(
                "{ \"from\": \"ok\", \"to\": \"write\", \"on\": \"fail\" },", ""));
        assertTrue(has(PlaybookValidator.validate(missing), "nodes[1]", "no arrow for outcome fail"));
        Playbook extra = read(PlaybookReaderTest.MINIMAL.replace(
                "{ \"from\": \"ok\", \"to\": \"done\", \"on\": \"exhausted\" }",
                "{ \"from\": \"ok\", \"to\": \"done\", \"on\": \"exhausted\" }, { \"from\": \"ok\", \"to\": \"done\", \"on\": \"maybe\" }"));
        assertTrue(has(PlaybookValidator.validate(extra), "arrows[4]", "outcome maybe"));
    }

    @Test
    void rule4EveryLoopHasACeiling() {
        Playbook p = read(PlaybookReaderTest.MINIMAL.replace(", \"max_rounds\": 2", "")
                .replace("{ \"from\": \"ok\", \"to\": \"done\", \"on\": \"exhausted\" }", "{ \"from\": \"ok\", \"to\": \"done\", \"on\": \"pass\" }")
                .replace("{ \"from\": \"ok\", \"to\": \"done\", \"on\": \"pass\" },\n", ""));
        List<Finding> f = PlaybookValidator.validate(p);
        assertTrue(f.stream().anyMatch(x -> x.path().startsWith("arrows[") && x.message().contains("max_rounds")), f.toString());
    }

    @Test
    void rule5NamesResolve() {
        Playbook p = read(PlaybookReaderTest.MINIMAL.replace("\"model\": \"fast\"", "\"model\": \"slow\"")
                .replace("\"produces\": [\"spec\"]", "\"produces\": [\"plan\"]")
                .replace("\"check\": \"spec_ok\"", "\"check\": \"nope\""));
        List<Finding> f = PlaybookValidator.validate(p);
        assertTrue(has(f, "nodes[0].model", "slow"), f.toString());
        assertTrue(has(f, "nodes[0].produces", "plan"), f.toString());
        assertTrue(has(f, "nodes[1].check", "nope"), f.toString());
    }

    @Test
    void rule6PermissionNeverExtended() {
        Playbook p = read(PlaybookReaderTest.MINIMAL.replace("\"model\": \"fast\"", "\"model\": \"fast\", \"permission\": \"extended\""));
        assertTrue(has(PlaybookValidator.validate(p), "nodes[0].permission", "extended"));
    }

    @Test
    void rule7VarsAreDeclared() {
        Playbook p = read(PlaybookReaderTest.MINIMAL.replace("\"spec_ok\": { \"kind\": \"sections\", \"documents\": [\"spec\"] }",
                "\"spec_ok\": { \"kind\": \"command\", \"run\": \"{test}\" }"));
        assertTrue(has(PlaybookValidator.validate(p), "checks.spec_ok.run", "test"));
    }

    private static final String BASE_CONTENTS = "\"contents\": { \"skills\": [\"skills/spectropowers\"] }";

    private static String childWith(String role, String contentsJson) {
        return PlaybookReaderTest.MINIMAL
                .replace("\"model\": \"fast\"", "\"performer\": \"child\", \"role\": \"" + role + "\", \"model\": \"fast\"")
                .replace(BASE_CONTENTS, "\"contents\": " + contentsJson);
    }

    @Test
    void aChildStepMayNameAnAgentTheContentsList() {
        Playbook listed = read(childWith("agent:reviewer", "{ \"agents\": [\"agents/reviewer.md\"] }"));
        assertEquals(List.of(), PlaybookValidator.validate(listed));
        Playbook missing = read(childWith("agent:reviewer", "{ \"agents\": [] }"));
        List<Finding> f = PlaybookValidator.validate(missing);
        assertTrue(has(f, "nodes[0].role", "agents/reviewer.md"), f.toString());
        Playbook plain = read(childWith("worker", "{ \"agents\": [] }"));
        assertEquals(List.of(), PlaybookValidator.validate(plain), "a static role needs no agent file");
        Playbook unknown = read(childWith("boss", "{ \"agents\": [\"agents/reviewer.md\"] }"));
        assertTrue(has(PlaybookValidator.validate(unknown), "nodes[0].role", "agent:<name>"));
        Playbook empty = read(childWith("agent:", "{ \"agents\": [\"agents/.md\"] }"));
        assertTrue(PlaybookValidator.validate(empty).stream().anyMatch(x -> x.path().equals("nodes[0].role")),
                "agent: with no name never resolves");
    }

    @Test
    void contentsPathsHaveTheirShape() {
        Playbook p = read(PlaybookReaderTest.MINIMAL.replace(BASE_CONTENTS, """
                "contents": {
                  "skills": ["skills/spectropowers", "skills/a b", "skills/p"],
                  "agents": ["agents/reviewer.md", "agents/x.txt"],
                  "hooks": ["hooks/hooks.json", "hooks/other.json"],
                  "commands": ["commands/ship.md"],
                  "workflows": ["workflows/build.js", "workflows/a/b.js"] }"""));
        List<String> paths = PlaybookValidator.validate(p).stream().map(Finding::path).toList();
        assertEquals(List.of("contents.skills[1]", "contents.skills[2]", "contents.agents[1]",
                "contents.hooks[1]", "contents.workflows[1]"), paths);
        assertTrue(has(PlaybookValidator.validate(p), "contents.skills[2]", "playbook id"));
    }

    @Test
    void contentsWithEveryKindInShapeIsClean() {
        Playbook p = read(PlaybookReaderTest.MINIMAL.replace(BASE_CONTENTS, """
                "contents": {
                  "skills": ["skills/spectropowers", "skills/team_pack-2"],
                  "agents": ["agents/reviewer.md"],
                  "hooks": ["hooks/hooks.json"],
                  "commands": ["commands/ship.md"],
                  "workflows": ["workflows/build.js"] }"""));
        assertEquals(List.of(), PlaybookValidator.validate(p));
    }
}
