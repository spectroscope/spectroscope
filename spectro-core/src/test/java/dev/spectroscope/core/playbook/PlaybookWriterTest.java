package dev.spectroscope.core.playbook;

import org.junit.jupiter.api.Test;

import java.util.ArrayList;
import java.util.List;

import static org.junit.jupiter.api.Assertions.assertEquals;

class PlaybookWriterTest {

    /** PlaybookReaderTest.MINIMAL in the canonical form, written out by hand from the spec's rules. */
    static final String MINIMAL_CANONICAL = """
        {
          "schema_version": 1,
          "id": "p",
          "name": "P",
          "description": "d",
          "models": {
            "fast": {
              "primary": { "provider": "ollama", "model": "qwen3:8b" },
              "fallbacks": []
            }
          },
          "documents": {
            "spec": {
              "name": "Spec",
              "purpose": "design",
              "location": "docs/{slug}.md",
              "template": "templates/spec.md",
              "sections": ["Goal"]
            }
          },
          "checks": {
            "spec_ok": {
              "kind": "sections",
              "documents": ["spec"]
            }
          },
          "vars": {},
          "start": "write",
          "nodes": [
            {
              "kind": "step",
              "id": "write",
              "name": "Write",
              "performer": "chat",
              "skills": ["spectropowers:brainstorming"],
              "model": "fast",
              "privacy": "cheap",
              "permission": "inherit",
              "consumes": [],
              "produces": ["spec"],
              "nod": false
            },
            {
              "kind": "decision",
              "id": "ok",
              "name": "Spec ok",
              "check": "spec_ok",
              "max_rounds": 2
            },
            {
              "kind": "end",
              "id": "done",
              "result": "done"
            }
          ],
          "arrows": [
            { "from": "write", "to": "ok" },
            { "from": "ok", "to": "done", "on": "pass" },
            { "from": "ok", "to": "write", "on": "fail" },
            { "from": "ok", "to": "done", "on": "exhausted" }
          ],
          "contents": {
            "skills": ["skills/spectropowers"],
            "agents": [],
            "hooks": [],
            "commands": [],
            "workflows": []
          }
        }
        """;

    private static Playbook read(String json) {
        PlaybookReader.Read r = PlaybookReader.read(json);
        assertEquals(List.of(), r.findings(), "fixture must read clean");
        return r.playbook();
    }

    @Test
    void writesTheMinimalPlaybookInTheCanonicalForm() {
        assertEquals(MINIMAL_CANONICAL, PlaybookWriter.write(read(PlaybookReaderTest.MINIMAL)));
    }

    @Test
    void theCanonicalFormRoundTripsByteForByte() {
        assertEquals(MINIMAL_CANONICAL, PlaybookWriter.write(read(MINIMAL_CANONICAL)));
        assertEquals(read(PlaybookReaderTest.MINIMAL), read(MINIMAL_CANONICAL), "the records survive the form");
    }

    @Test
    void oneChangedFieldChangesExactlyOneLine() {
        String renamed = MINIMAL_CANONICAL.replace("\"name\": \"Write\"", "\"name\": \"Write the spec\"");
        List<String> before = MINIMAL_CANONICAL.lines().toList();
        List<String> after = PlaybookWriter.write(read(renamed)).lines().toList();
        assertEquals(before.size(), after.size());
        List<Integer> changed = new ArrayList<>();
        for (int i = 0; i < before.size(); i++) {
            if (!before.get(i).equals(after.get(i))) changed.add(i);
        }
        assertEquals(1, changed.size(), changed.toString());
    }

    @Test
    void mapOrderIsKeptAndStringsAreEscapedOnlyWhereJsonMust() {
        String json = MINIMAL_CANONICAL
                .replace("\"vars\": {}", "\"vars\": {\n    \"zeta\": \"z\",\n    \"alpha\": \"a \\\"quoted\\\" ü\"\n  }");
        String written = PlaybookWriter.write(read(json));
        assertEquals(true, written.indexOf("\"zeta\"") < written.indexOf("\"alpha\""), "map order is content");
        assertEquals(true, written.contains("\"alpha\": \"a \\\"quoted\\\" ü\""), written);
    }

    @Test
    void nullOptionalsAreOmittedAndDefaultsAreWritten() {
        String written = PlaybookWriter.write(read(PlaybookReaderTest.MINIMAL));
        assertEquals(false, written.contains("\"goal\""));
        assertEquals(false, written.contains("\"role\""));
        assertEquals(false, written.contains("\"outcomes\""));
        assertEquals(true, written.contains("\"performer\": \"chat\""), "a default is written");
    }
}
