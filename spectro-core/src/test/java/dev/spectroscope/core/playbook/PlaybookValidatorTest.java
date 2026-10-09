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
}
