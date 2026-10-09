package dev.spectroscope.core.playbook;

import org.junit.jupiter.api.Test;

import java.util.List;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

class PlaybookReaderTest {

    static final String MINIMAL = """
        { "schema_version": 1, "id": "p", "name": "P", "description": "d",
          "models": { "fast": { "primary": { "provider": "ollama", "model": "qwen3:8b" } } },
          "documents": { "spec": { "name": "Spec", "purpose": "design", "location": "docs/{slug}.md",
                                   "template": "templates/spec.md", "sections": ["Goal"] } },
          "checks": { "spec_ok": { "kind": "sections", "documents": ["spec"] } },
          "start": "write",
          "nodes": [
            { "kind": "step", "id": "write", "name": "Write", "skills": ["spectropowers:brainstorming"],
              "model": "fast", "produces": ["spec"] },
            { "kind": "decision", "id": "ok", "name": "Spec ok", "check": "spec_ok", "max_rounds": 2 },
            { "kind": "end", "id": "done", "result": "done" }
          ],
          "arrows": [
            { "from": "write", "to": "ok" },
            { "from": "ok", "to": "done", "on": "pass" },
            { "from": "ok", "to": "write", "on": "fail" },
            { "from": "ok", "to": "done", "on": "exhausted" }
          ],
          "contents": { "skills": ["skills/spectropowers"] } }
        """;

    @Test
    void readsTheMinimalPlaybookWithDefaults() {
        PlaybookReader.Read read = PlaybookReader.read(MINIMAL);
        assertEquals(List.of(), read.findings());
        Playbook p = read.playbook();
        assertNotNull(p);
        assertEquals("write", p.start());
        Playbook.Step write = (Playbook.Step) p.nodes().get(0);
        assertEquals("chat", write.performer(), "performer defaults to chat");
        assertEquals("cheap", write.privacy());
        assertEquals("inherit", write.permission());
        assertEquals(List.of(), write.consumes());
        Playbook.Decision ok = (Playbook.Decision) p.nodes().get(1);
        assertEquals(2, ok.maxRounds());
        assertEquals(List.of(), p.models().get("fast").fallbacks());
        assertEquals(List.of(), p.contents().agents());
    }

    @Test
    void anUnknownFieldIsAFindingWithItsPath() {
        String json = MINIMAL.replace("\"name\": \"Write\"", "\"name\": \"Write\", \"colour\": \"red\"");
        PlaybookReader.Read read = PlaybookReader.read(json);
        assertTrue(read.findings().stream().anyMatch(f -> f.path().equals("nodes[0].colour")), read.findings().toString());
        assertNotNull(read.playbook(), "an unknown field does not stop the read");
    }

    @Test
    void aKeyOrAddressInTheFileIsRefusedAndNothingIsRead() {
        String json = MINIMAL.replace("\"model\": \"fast\"", "\"model\": \"fast\", \"baseUrl\": \"http://10.0.0.5:8080\"");
        PlaybookReader.Read read = PlaybookReader.read(json);
        assertNull(read.playbook());
        assertTrue(read.findings().stream().anyMatch(f -> f.path().equals("nodes[0].baseUrl")
                && f.message().contains("refused")), read.findings().toString());
    }

    @Test
    void aRefusedKeyIsRefusedAnywhereInTheFileNotOnlyWhereTheReaderLooks() {
        String json = MINIMAL.replace("\"start\": \"write\",",
                "\"vars\": { \"apiKey\": \"sk-x\" }, \"start\": \"write\", \"extra\": { \"inner\": { \"endpoint\": \"http://h\" } },");
        PlaybookReader.Read read = PlaybookReader.read(json);
        assertNull(read.playbook());
        assertTrue(read.findings().stream().anyMatch(f -> f.path().equals("vars.apiKey")
                && f.message().contains("refused")), read.findings().toString());
        assertTrue(read.findings().stream().anyMatch(f -> f.path().equals("extra.inner.endpoint")
                && f.message().contains("refused")), read.findings().toString());
    }

    @Test
    void hooksInsideContentsIsAListOfPathsAndReadsClean() {
        String json = MINIMAL.replace("\"contents\": { \"skills\": [\"skills/spectropowers\"] }",
                "\"contents\": { \"skills\": [\"skills/spectropowers\"], \"hooks\": [\"hooks/hooks.json\"] }");
        PlaybookReader.Read read = PlaybookReader.read(json);
        assertEquals(List.of(), read.findings());
        assertNotNull(read.playbook());
        assertEquals(List.of("hooks/hooks.json"), read.playbook().contents().hooks());
    }

    @Test
    void hooksOutsideContentsIsStillRefused() {
        String atTop = MINIMAL.replace("\"start\": \"write\",", "\"hooks\": [\"hooks/hooks.json\"], \"start\": \"write\",");
        PlaybookReader.Read top = PlaybookReader.read(atTop);
        assertNull(top.playbook());
        assertTrue(top.findings().stream().anyMatch(f -> f.path().equals("hooks")
                && f.message().contains("refused")), top.findings().toString());
        String inContents = MINIMAL.replace("\"contents\": { \"skills\": [\"skills/spectropowers\"] }",
                "\"contents\": { \"skills\": [\"skills/spectropowers\"], \"baseUrl\": \"http://h\" }");
        PlaybookReader.Read contents = PlaybookReader.read(inContents);
        assertNull(contents.playbook());
        assertTrue(contents.findings().stream().anyMatch(f -> f.path().equals("contents.baseUrl")
                && f.message().contains("refused")), contents.findings().toString());
    }

    @Test
    void splitAndJoinAreNotSupportedInVersionOne() {
        String json = MINIMAL.replace("{ \"kind\": \"end\", \"id\": \"done\", \"result\": \"done\" }",
                "{ \"kind\": \"end\", \"id\": \"done\", \"result\": \"done\" }, { \"kind\": \"split\", \"id\": \"s\", \"join\": \"j\" }");
        PlaybookReader.Read read = PlaybookReader.read(json);
        assertNull(read.playbook());
        assertTrue(read.findings().stream().anyMatch(f -> f.path().equals("nodes[3].kind")
                && f.message().contains("not supported in version 1")));
    }

    @Test
    void malformedJsonIsOneFindingAtTheRoot() {
        PlaybookReader.Read read = PlaybookReader.read("{ not json");
        assertNull(read.playbook());
        assertEquals(1, read.findings().size());
        assertEquals("", read.findings().get(0).path());
    }
}
