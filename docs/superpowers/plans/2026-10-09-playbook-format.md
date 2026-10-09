# Playbook Format and spectro Playbook Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A playbook folder loads, validates and draws in a third view mode `developer`, and the product ships the spectro playbook built on spectropowers, copied into a folder by one button.

**Architecture:** The format lives in `spectro-core` (`dev.spectroscope.core.playbook`: records, a strict Jackson reader, a validator with named findings, a projection to the engine's `Topology`). The server (`dev.spectroscope.server.playbooks`) keeps the known folders and the pin per workspace in `~/.spectro/playbooks.json`, serves load, register, pin and copy routes behind the loopback fence, and ships `bundled-playbooks/spectro/` as classpath resources. The web adds the mode word, a `developer` column in the surface table, a fourth segment `playbook` in its own chunk with a folder picker, a graph drawn by `layoutStateGraph` with a renderer of its own, a step table and the findings. spectropowers is the vendored superpowers copy with the house rules worked in, plus licence and provenance.

**Tech Stack:** Java 21, Jackson, JUnit 5; TypeScript, React 18, vitest, the existing `stategraph/layout.ts` engine; Python 3 stdlib for the documentation builder.

**Spec:** `docs/superpowers/specs/2026-10-09-playbook-format-design.md`.

## Global Constraints

- Same as P1: worktree per card, `npm ci`, business English, both languages for every string, no dashes as punctuation, no emoji, red first with evidence, mutation probe after each commit, full gates alone and never through a pipe, explicit staging paths, `git commit -F`.
- Nothing from a playbook file may name a key, an address, a hook or an MCP server; the loader refuses with the path (spec rule 6).
- No YAML. No new settings key. The RunEvent wire is untouched (P2 writes no events).
- Every loop in a playbook has a ceiling (spec rule 4).
- The playbook segment and its chunk exist only in developer; learn and light never request the chunk.
- spectropowers keeps the MIT `LICENSE` text of the source beside the copy and a `PROVENANCE.md`; the pack name is `spectropowers`, folder names stay.
- The engine's start and end ids are `StateGraph.START` and `StateGraph.END` (`spectro-core/.../graph/StateGraph.java`); read their values before writing a test that spells them.

---

### Task 1: The playbook records and the strict reader (core)

**Files:**
- Create: `spectro-core/src/main/java/dev/spectroscope/core/playbook/Playbook.java`
- Create: `spectro-core/src/main/java/dev/spectroscope/core/playbook/PlaybookReader.java`
- Create: `spectro-core/src/main/java/dev/spectroscope/core/playbook/Finding.java`
- Test: `spectro-core/src/test/java/dev/spectroscope/core/playbook/PlaybookReaderTest.java`

**Interfaces:**
- Produces:

```java
public record Finding(String path, String message) {}
public record Playbook(int schemaVersion, String id, String name, String description,
        Map<String, ModelChoice> models, Map<String, DocumentType> documents, Map<String, Check> checks,
        Map<String, String> vars, String start, List<Node> nodes, List<Arrow> arrows, Contents contents) {
    public record ModelChoice(ModelRef primary, List<ModelRef> fallbacks) {}
    public record ModelRef(String provider, String model) {}
    public record DocumentType(String name, String purpose, String location, String template, List<String> sections) {}
    public record Check(String kind, List<String> documents, List<String> forbid, String run, String model,
            List<String> reads, String ask, List<String> labels) {}
    public sealed interface Node permits Step, Decision, End { String id(); String kind(); }
    public record Step(String id, String name, String goal, String performer, String role, List<String> skills,
            String model, String privacy, String permission, List<String> consumes, List<String> produces, boolean nod) implements Node {
        public String kind() { return "step"; } }
    public record Decision(String id, String name, String check, List<String> outcomes, Integer maxRounds) implements Node {
        public String kind() { return "decision"; } }
    public record End(String id, String result) implements Node { public String kind() { return "end"; } }
    public record Arrow(String from, String to, String on) {}
    public record Contents(List<String> skills, List<String> agents, List<String> hooks, List<String> commands, List<String> workflows) {}
}
public final class PlaybookReader {
    public record Read(Playbook playbook, List<Finding> findings) {}
    public static Read read(String json);
}
```

The reader is strict in the sense the spec names: an unknown field is a finding with its JSON path, a refused field (`apiKey`, `key`, `baseUrl`, `endpoint`, `address`, `hooks`, `mcpServers`, `autoApprove`) is a finding and makes `playbook` null; a node kind `split`, `join` or a step field `fallback_chain` or `sub_playbook` is a finding "not supported in version 1". Missing optional fields get defaults: `fallbacks` empty, `performer` `chat`, `privacy` `cheap`, `permission` `inherit`, `nod` false, `consumes` and `produces` empty, `contents` lists empty.

- [ ] **Step 1: Write the failing test**

```java
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
```

- [ ] **Step 2: Run it to verify it fails**

Run: `./gradlew :spectro-core:test --tests 'dev.spectroscope.core.playbook.PlaybookReaderTest' --rerun-tasks --no-build-cache`
Expected: compilation failure. Save to `kanban/evidence/<card>/task1-red.log`.

- [ ] **Step 3: Write the records, `Finding`, and the reader**

`Finding.java` and `Playbook.java` exactly as in Interfaces (with `@JsonIgnoreProperties` not used: the reader walks the tree by hand so it can name every unknown path). The reader:

```java
package dev.spectroscope.core.playbook;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;

import java.util.ArrayList;
import java.util.Iterator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;

/**
 * Reads playbook.json into {@link Playbook}, naming every field it does not
 * know and refusing every field a shared folder may not carry. The tree is
 * walked by hand rather than bound, so a finding can carry the JSON path a
 * person can go and look at.
 */
public final class PlaybookReader {

    public record Read(Playbook playbook, List<Finding> findings) {}

    private static final ObjectMapper JSON = new ObjectMapper();

    /** Fields a playbook may never carry: they route material or widen rights. */
    static final Set<String> REFUSED = Set.of("apiKey", "key", "baseUrl", "endpoint", "address", "hooks",
            "mcpServers", "autoApprove");
    static final Set<String> RESERVED_KINDS = Set.of("split", "join");
    static final Set<String> RESERVED_STEP_FIELDS = Set.of("fallback_chain", "sub_playbook");

    static final Set<String> TOP = Set.of("schema_version", "id", "name", "description", "models", "documents",
            "checks", "vars", "start", "nodes", "arrows", "contents");
    static final Set<String> STEP = Set.of("kind", "id", "name", "goal", "performer", "role", "skills", "model",
            "privacy", "permission", "consumes", "produces", "nod");
    static final Set<String> DECISION = Set.of("kind", "id", "name", "check", "outcomes", "max_rounds");
    static final Set<String> END = Set.of("kind", "id", "result");
    static final Set<String> ARROW = Set.of("from", "to", "on");
    static final Set<String> MODEL_CHOICE = Set.of("primary", "fallbacks");
    static final Set<String> MODEL_REF = Set.of("provider", "model");
    static final Set<String> DOCUMENT = Set.of("name", "purpose", "location", "template", "sections");
    static final Set<String> CHECK = Set.of("kind", "documents", "forbid", "run", "model", "reads", "ask", "labels");
    static final Set<String> CONTENTS = Set.of("skills", "agents", "hooks", "commands", "workflows");

    private final List<Finding> findings = new ArrayList<>();
    private boolean refused;

    private PlaybookReader() {
    }

    public static Read read(String json) {
        PlaybookReader r = new PlaybookReader();
        JsonNode root;
        try {
            root = JSON.readTree(json);
        } catch (Exception malformed) {
            return new Read(null, List.of(new Finding("", "not JSON: " + malformed.getMessage())));
        }
        if (root == null || !root.isObject()) {
            return new Read(null, List.of(new Finding("", "the playbook must be a JSON object")));
        }
        Playbook p = r.playbook(root);
        return new Read(r.refused ? null : p, List.copyOf(r.findings));
    }

    private void unknown(JsonNode node, Set<String> known, String path) {
        Iterator<String> names = node.fieldNames();
        while (names.hasNext()) {
            String field = names.next();
            String at = path.isEmpty() ? field : path + "." + field;
            if (REFUSED.contains(field)) {
                findings.add(new Finding(at, "refused: a playbook may not carry keys, addresses, hooks or MCP servers"));
                refused = true;
            } else if (!known.contains(field)) {
                findings.add(new Finding(at, "unknown field"));
            }
        }
    }

    private static String text(JsonNode node, String field, String fallback) {
        JsonNode v = node.get(field);
        return v == null || v.isNull() ? fallback : v.asText();
    }

    private static List<String> strings(JsonNode node, String field) {
        JsonNode v = node.get(field);
        if (v == null || !v.isArray()) {
            return List.of();
        }
        List<String> out = new ArrayList<>();
        for (JsonNode e : v) {
            out.add(e.asText());
        }
        return List.copyOf(out);
    }

    private Playbook playbook(JsonNode root) {
        unknown(root, TOP, "");
        Map<String, Playbook.ModelChoice> models = new LinkedHashMap<>();
        JsonNode m = root.path("models");
        m.fields().forEachRemaining(e -> {
            unknown(e.getValue(), MODEL_CHOICE, "models." + e.getKey());
            models.put(e.getKey(), new Playbook.ModelChoice(
                    modelRef(e.getValue().path("primary"), "models." + e.getKey() + ".primary"),
                    refs(e.getValue().path("fallbacks"), "models." + e.getKey() + ".fallbacks")));
        });
        Map<String, Playbook.DocumentType> documents = new LinkedHashMap<>();
        root.path("documents").fields().forEachRemaining(e -> {
            unknown(e.getValue(), DOCUMENT, "documents." + e.getKey());
            JsonNode d = e.getValue();
            documents.put(e.getKey(), new Playbook.DocumentType(text(d, "name", e.getKey()), text(d, "purpose", ""),
                    text(d, "location", ""), text(d, "template", null), strings(d, "sections")));
        });
        Map<String, Playbook.Check> checks = new LinkedHashMap<>();
        root.path("checks").fields().forEachRemaining(e -> {
            unknown(e.getValue(), CHECK, "checks." + e.getKey());
            JsonNode c = e.getValue();
            checks.put(e.getKey(), new Playbook.Check(text(c, "kind", ""), strings(c, "documents"), strings(c, "forbid"),
                    text(c, "run", null), text(c, "model", null), strings(c, "reads"), text(c, "ask", null), strings(c, "labels")));
        });
        Map<String, String> vars = new LinkedHashMap<>();
        root.path("vars").fields().forEachRemaining(e -> vars.put(e.getKey(), e.getValue().asText()));
        List<Playbook.Node> nodes = new ArrayList<>();
        int i = 0;
        for (JsonNode n : root.path("nodes")) {
            Playbook.Node node = node(n, "nodes[" + i + "]");
            if (node != null) {
                nodes.add(node);
            }
            i++;
        }
        List<Playbook.Arrow> arrows = new ArrayList<>();
        int j = 0;
        for (JsonNode a : root.path("arrows")) {
            unknown(a, ARROW, "arrows[" + j + "]");
            arrows.add(new Playbook.Arrow(text(a, "from", ""), text(a, "to", ""), text(a, "on", null)));
            j++;
        }
        JsonNode c = root.path("contents");
        unknown(c, CONTENTS, "contents");
        Playbook.Contents contents = new Playbook.Contents(strings(c, "skills"), strings(c, "agents"),
                strings(c, "hooks"), strings(c, "commands"), strings(c, "workflows"));
        return new Playbook(root.path("schema_version").asInt(0), text(root, "id", ""), text(root, "name", ""),
                text(root, "description", ""), models, documents, checks, vars, text(root, "start", ""),
                List.copyOf(nodes), List.copyOf(arrows), contents);
    }

    private Playbook.ModelRef modelRef(JsonNode n, String path) {
        unknown(n, MODEL_REF, path);
        return new Playbook.ModelRef(text(n, "provider", ""), text(n, "model", ""));
    }

    private List<Playbook.ModelRef> refs(JsonNode arr, String path) {
        List<Playbook.ModelRef> out = new ArrayList<>();
        int i = 0;
        for (JsonNode n : arr) {
            out.add(modelRef(n, path + "[" + i++ + "]"));
        }
        return List.copyOf(out);
    }

    private Playbook.Node node(JsonNode n, String path) {
        String kind = text(n, "kind", "");
        if (RESERVED_KINDS.contains(kind)) {
            findings.add(new Finding(path + ".kind", kind + " is not supported in version 1"));
            refused = true;
            return null;
        }
        switch (kind) {
            case "step" -> {
                for (String reserved : RESERVED_STEP_FIELDS) {
                    if (n.has(reserved)) {
                        findings.add(new Finding(path + "." + reserved, reserved + " is not supported in version 1"));
                        refused = true;
                    }
                }
                unknown(n, STEP, path);
                return new Playbook.Step(text(n, "id", ""), text(n, "name", ""), text(n, "goal", null),
                        text(n, "performer", "chat"), text(n, "role", null), strings(n, "skills"), text(n, "model", null),
                        text(n, "privacy", "cheap"), text(n, "permission", "inherit"), strings(n, "consumes"),
                        strings(n, "produces"), n.path("nod").asBoolean(false));
            }
            case "decision" -> {
                unknown(n, DECISION, path);
                JsonNode rounds = n.get("max_rounds");
                return new Playbook.Decision(text(n, "id", ""), text(n, "name", ""), text(n, "check", ""),
                        strings(n, "outcomes"), rounds == null || rounds.isNull() ? null : rounds.asInt());
            }
            case "end" -> {
                unknown(n, END, path);
                return new Playbook.End(text(n, "id", ""), text(n, "result", "done"));
            }
            default -> {
                findings.add(new Finding(path + ".kind", "unknown node kind: " + kind));
                refused = true;
                return null;
            }
        }
    }
}
```

The `RESERVED_STEP_FIELDS` check must run before `unknown`, or the reserved field would be reported as unknown as well; both findings are acceptable, the test asserts only the reserved one.

- [ ] **Step 4: Run the test to verify it passes, then commit**

```bash
git add spectro-core/src/main/java/dev/spectroscope/core/playbook/Playbook.java \
        spectro-core/src/main/java/dev/spectroscope/core/playbook/PlaybookReader.java \
        spectro-core/src/main/java/dev/spectroscope/core/playbook/Finding.java \
        spectro-core/src/test/java/dev/spectroscope/core/playbook/PlaybookReaderTest.java
git commit -F /tmp/msg-p2-task1.txt
```

---

### Task 2: The validator (core)

**Files:**
- Create: `spectro-core/src/main/java/dev/spectroscope/core/playbook/PlaybookValidator.java`
- Test: `spectro-core/src/test/java/dev/spectroscope/core/playbook/PlaybookValidatorTest.java`

**Interfaces:**
- Consumes: `Playbook`, `Finding`.
- Produces: `public static List<Finding> validate(Playbook p)`; helpers `static Set<String> outcomesOf(Playbook p, Playbook.Node n)` (step: one unlabelled outcome, spelled `""`; decision: its `outcomes` or the check kind's labels, plus `exhausted` when `maxRounds` is set; end: none) and `static boolean canReach(Playbook p, String from, String to)`.

Check kind labels: `sections`, `open_items` and `command` give `pass` and `fail`; `review` and `human` give the check's `labels`; a `review` or `human` check without labels gives `pass` and `fail`.

- [ ] **Step 1: Write the failing test**, one case per spec rule:

```java
package dev.spectroscope.core.playbook;

import org.junit.jupiter.api.Test;

import java.util.List;

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
```

Rule 8 (paths under the folder) needs a folder and is tested in Task 5 with the loader.

- [ ] **Step 2: Run it to verify it fails**

Run: `./gradlew :spectro-core:test --tests 'dev.spectroscope.core.playbook.PlaybookValidatorTest' --rerun-tasks --no-build-cache`
Expected: compilation failure (`PlaybookValidator` missing).

- [ ] **Step 3: Write the validator**

```java
package dev.spectroscope.core.playbook;

import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Deque;
import java.util.HashMap;
import java.util.HashSet;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/** The structural rules of a playbook (spec rules 1 to 7). Every finding names a path. */
public final class PlaybookValidator {

    private PlaybookValidator() {
    }

    static final Pattern ID = Pattern.compile("[a-z][a-z0-9-]*");
    static final Pattern VAR = Pattern.compile("\\{([a-z][a-z0-9_]*)}");
    static final Set<String> LOCATION_VARS = Set.of("date", "slug", "n");
    static final Set<String> PERFORMERS = Set.of("chat", "child");
    static final Set<String> ROLES = Set.of("explore", "worker", "research");
    static final Set<String> PRIVACY = Set.of("private", "cheap");
    static final Set<String> PERMISSIONS = Set.of("inherit", "readonly", "ask", "auto");
    static final Set<String> CHECK_KINDS = Set.of("sections", "open_items", "command", "review", "human");

    public static List<Finding> validate(Playbook p) {
        List<Finding> out = new ArrayList<>();
        if (p.schemaVersion() != 1) {
            out.add(new Finding("schema_version", "must be 1"));
        }
        if (!ID.matcher(p.id()).matches()) {
            out.add(new Finding("id", "must match [a-z][a-z0-9-]*"));
        }
        Map<String, Integer> index = new HashMap<>();
        for (int i = 0; i < p.nodes().size(); i++) {
            Playbook.Node n = p.nodes().get(i);
            if (index.containsKey(n.id())) {
                out.add(new Finding("nodes[" + i + "].id", "duplicate id " + n.id()));
            }
            index.put(n.id(), i);
        }
        if (!index.containsKey(p.start())) {
            out.add(new Finding("start", "names no node: " + p.start()));
        }
        // rule 5 and 6 per node
        for (int i = 0; i < p.nodes().size(); i++) {
            String at = "nodes[" + i + "]";
            Playbook.Node n = p.nodes().get(i);
            if (n instanceof Playbook.Step s) {
                if (s.model() != null && !p.models().containsKey(s.model())) {
                    out.add(new Finding(at + ".model", "unknown model choice " + s.model()));
                }
                for (String d : s.consumes()) {
                    if (!p.documents().containsKey(d)) out.add(new Finding(at + ".consumes", "unknown document " + d));
                }
                for (String d : s.produces()) {
                    if (!p.documents().containsKey(d)) out.add(new Finding(at + ".produces", "unknown document " + d));
                }
                if (!PERFORMERS.contains(s.performer())) out.add(new Finding(at + ".performer", "must be chat or child"));
                if ("child".equals(s.performer()) && (s.role() == null || !ROLES.contains(s.role()))) {
                    out.add(new Finding(at + ".role", "a child step needs a role: explore, worker or research"));
                }
                if (!PRIVACY.contains(s.privacy())) out.add(new Finding(at + ".privacy", "must be private or cheap"));
                if ("extended".equals(s.permission()) || !PERMISSIONS.contains(s.permission())) {
                    out.add(new Finding(at + ".permission", "extended is never allowed from a playbook; use inherit, readonly, ask or auto"));
                }
                for (String skill : s.skills()) {
                    if (skill == null || skill.isBlank()) out.add(new Finding(at + ".skills", "empty skill name"));
                }
            } else if (n instanceof Playbook.Decision d) {
                if (!p.checks().containsKey(d.check())) {
                    out.add(new Finding(at + ".check", "unknown check " + d.check()));
                }
            }
        }
        // checks
        p.checks().forEach((name, c) -> {
            String at = "checks." + name;
            if (!CHECK_KINDS.contains(c.kind())) out.add(new Finding(at + ".kind", "unknown check kind " + c.kind()));
            for (String d : c.documents()) {
                if (!p.documents().containsKey(d)) out.add(new Finding(at + ".documents", "unknown document " + d));
            }
            if ("command".equals(c.kind())) {
                if (c.run() == null) out.add(new Finding(at + ".run", "a command check needs run"));
                else undeclared(c.run(), p.vars().keySet(), Set.of()).forEach(v ->
                        out.add(new Finding(at + ".run", "undeclared var " + v)));
            }
            if ("review".equals(c.kind()) && (c.model() == null || !p.models().containsKey(c.model()))) {
                out.add(new Finding(at + ".model", "a review check needs a model choice"));
            }
            if ("human".equals(c.kind()) && c.ask() == null) out.add(new Finding(at + ".ask", "a human check needs ask"));
        });
        p.documents().forEach((name, d) -> undeclared(d.location(), p.vars().keySet(), LOCATION_VARS).forEach(v ->
                out.add(new Finding("documents." + name + ".location", "undeclared var " + v))));
        // rule 3: one arrow per outcome
        Map<String, List<Integer>> arrowsFrom = new HashMap<>();
        for (int j = 0; j < p.arrows().size(); j++) {
            Playbook.Arrow a = p.arrows().get(j);
            if (!index.containsKey(a.from())) out.add(new Finding("arrows[" + j + "].from", "names no node: " + a.from()));
            if (!index.containsKey(a.to())) out.add(new Finding("arrows[" + j + "].to", "names no node: " + a.to()));
            arrowsFrom.computeIfAbsent(a.from(), k -> new ArrayList<>()).add(j);
        }
        for (int i = 0; i < p.nodes().size(); i++) {
            Playbook.Node n = p.nodes().get(i);
            Set<String> outcomes = outcomesOf(p, n);
            Set<String> seen = new HashSet<>();
            for (int j : arrowsFrom.getOrDefault(n.id(), List.of())) {
                String on = p.arrows().get(j).on() == null ? "" : p.arrows().get(j).on();
                if (!outcomes.contains(on)) {
                    out.add(new Finding("arrows[" + j + "]", n.id() + " has no outcome " + (on.isEmpty() ? "(unlabelled)" : on)));
                } else if (!seen.add(on)) {
                    out.add(new Finding("arrows[" + j + "]", "second arrow for outcome " + on + " out of " + n.id()));
                }
            }
            for (String o : outcomes) {
                if (!seen.contains(o)) out.add(new Finding("nodes[" + i + "]", "no arrow for outcome " + (o.isEmpty() ? "(unlabelled)" : o)));
            }
        }
        // rule 2: reachability both ways
        if (index.containsKey(p.start())) {
            Set<String> fromStart = reach(p, p.start());
            for (int i = 0; i < p.nodes().size(); i++) {
                if (!fromStart.contains(p.nodes().get(i).id())) out.add(new Finding("nodes[" + i + "]", "not reachable from start"));
            }
            for (int i = 0; i < p.nodes().size(); i++) {
                Playbook.Node n = p.nodes().get(i);
                if (n instanceof Playbook.End) continue;
                boolean endReachable = reach(p, n.id()).stream().anyMatch(id -> p.nodes().get(index.get(id)) instanceof Playbook.End);
                if (!endReachable) out.add(new Finding("nodes[" + i + "]", "cannot reach an end"));
            }
        }
        // rule 4: every back arrow passes a decision with max_rounds
        for (int j = 0; j < p.arrows().size(); j++) {
            Playbook.Arrow a = p.arrows().get(j);
            if (!index.containsKey(a.from()) || !index.containsKey(a.to())) continue;
            if (!canReach(p, a.to(), a.from())) continue; // not a loop
            boolean ceiling = loopNodes(p, a.to(), a.from()).stream()
                    .map(id -> p.nodes().get(index.get(id)))
                    .anyMatch(n -> n instanceof Playbook.Decision d && d.maxRounds() != null && d.maxRounds() > 0);
            if (!ceiling) out.add(new Finding("arrows[" + j + "]", "a loop from " + a.from() + " back to " + a.to()
                    + " passes no decision with max_rounds"));
        }
        return List.copyOf(out);
    }

    static Set<String> outcomesOf(Playbook p, Playbook.Node n) {
        if (n instanceof Playbook.End) return Set.of();
        if (n instanceof Playbook.Step) return Set.of("");
        Playbook.Decision d = (Playbook.Decision) n;
        Set<String> out = new LinkedHashSet<>();
        if (!d.outcomes().isEmpty()) {
            out.addAll(d.outcomes());
        } else {
            Playbook.Check c = p.checks().get(d.check());
            if (c != null && (("review".equals(c.kind()) || "human".equals(c.kind())) && !c.labels().isEmpty())) {
                out.addAll(c.labels());
            } else {
                out.add("pass");
                out.add("fail");
            }
        }
        if (d.maxRounds() != null) out.add("exhausted");
        return out;
    }

    static Set<String> reach(Playbook p, String from) {
        Set<String> seen = new LinkedHashSet<>();
        Deque<String> todo = new ArrayDeque<>();
        todo.add(from);
        while (!todo.isEmpty()) {
            String id = todo.poll();
            if (!seen.add(id)) continue;
            for (Playbook.Arrow a : p.arrows()) {
                if (a.from().equals(id)) todo.add(a.to());
            }
        }
        return seen;
    }

    static boolean canReach(Playbook p, String from, String to) {
        return reach(p, from).contains(to);
    }

    /** The nodes on any path from {@code from} to {@code to}, {@code to} included. */
    static Set<String> loopNodes(Playbook p, String from, String to) {
        Set<String> forward = reach(p, from);
        Set<String> out = new LinkedHashSet<>();
        for (String id : forward) {
            if (canReach(p, id, to)) out.add(id);
        }
        return out;
    }

    static List<String> undeclared(String text, Set<String> vars, Set<String> builtIn) {
        List<String> out = new ArrayList<>();
        if (text == null) return out;
        Matcher m = VAR.matcher(text);
        while (m.find()) {
            String v = m.group(1);
            if (!vars.contains(v) && !builtIn.contains(v)) out.add(v);
        }
        return out;
    }
}
```

- [ ] **Step 4: Run the test to verify it passes; mutation probe (remove the `ceiling` check, see rule 4 red, restore); commit** with explicit paths.

---

### Task 3: The drawing: playbook to `Topology` (core)

**Files:**
- Create: `spectro-core/src/main/java/dev/spectroscope/core/playbook/PlaybookTopology.java`
- Test: `spectro-core/src/test/java/dev/spectroscope/core/playbook/PlaybookTopologyTest.java`

**Interfaces:**
- Consumes: `Topology`, `Topology.Node`, `Topology.Edge`, `Topology.Branch`, `StateGraph.START`, `StateGraph.END` (`dev.spectroscope.core.graph`).
- Produces: `public static Topology of(Playbook p)`: nodes `START`, every step and decision (label = name), `END`; edges: `START -> start` direct; a step's arrow direct; a decision's arrows conditional with `branch` = the decision id; an arrow to an `end` node lands on `END` (end nodes are not drawn as boxes; their `result` becomes the branch label); one `Branch(decisionId, decisionId, targets)` per decision.

- [ ] **Step 1: Write the failing test**

```java
package dev.spectroscope.core.playbook;

import dev.spectroscope.core.graph.StateGraph;
import dev.spectroscope.core.graph.Topology;
import org.junit.jupiter.api.Test;

import java.util.List;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

class PlaybookTopologyTest {

    @Test
    void drawsStepsAndDecisionsBetweenStartAndEnd() {
        Playbook p = PlaybookReader.read(PlaybookReaderTest.MINIMAL).playbook();
        Topology t = PlaybookTopology.of(p);
        assertEquals(List.of(StateGraph.START, "write", "ok", StateGraph.END), t.nodes().stream().map(Topology.Node::id).toList());
        assertEquals("write", t.entry());
        assertTrue(t.edges().contains(new Topology.Edge(StateGraph.START, "write", "direct", null)));
        assertTrue(t.edges().contains(new Topology.Edge("write", "ok", "direct", null)));
        assertTrue(t.edges().contains(new Topology.Edge("ok", StateGraph.END, "conditional", "ok")));
        assertTrue(t.edges().contains(new Topology.Edge("ok", "write", "conditional", "ok")), "the loop is drawn, not reversed");
        assertEquals(1, t.branches().size());
        assertEquals("ok", t.branches().get(0).source());
        assertEquals(Topology.SCHEMA_VERSION, t.schemaVersion());
    }
}
```

- [ ] **Step 2: Run it to verify it fails**, **Step 3: Implement**

```java
package dev.spectroscope.core.playbook;

import dev.spectroscope.core.graph.StateGraph;
import dev.spectroscope.core.graph.Topology;

import java.util.ArrayList;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Set;

/** A playbook as the engine's drawing record, so the web draws it with the state graph layout. */
public final class PlaybookTopology {

    private PlaybookTopology() {
    }

    public static Topology of(Playbook p) {
        Set<String> ends = new LinkedHashSet<>();
        List<Topology.Node> nodes = new ArrayList<>();
        nodes.add(new Topology.Node(StateGraph.START, StateGraph.START));
        for (Playbook.Node n : p.nodes()) {
            if (n instanceof Playbook.End) {
                ends.add(n.id());
            } else if (n instanceof Playbook.Step s) {
                nodes.add(new Topology.Node(s.id(), s.name()));
            } else if (n instanceof Playbook.Decision d) {
                nodes.add(new Topology.Node(d.id(), d.name()));
            }
        }
        nodes.add(new Topology.Node(StateGraph.END, StateGraph.END));
        List<Topology.Edge> edges = new ArrayList<>();
        edges.add(new Topology.Edge(StateGraph.START, p.start(), "direct", null));
        List<Topology.Branch> branches = new ArrayList<>();
        for (Playbook.Node n : p.nodes()) {
            if (n instanceof Playbook.Decision d) {
                List<String> targets = new ArrayList<>();
                for (Playbook.Arrow a : p.arrows()) {
                    if (a.from().equals(d.id())) {
                        String to = ends.contains(a.to()) ? StateGraph.END : a.to();
                        edges.add(new Topology.Edge(d.id(), to, "conditional", d.id()));
                        if (!targets.contains(to)) targets.add(to);
                    }
                }
                branches.add(new Topology.Branch(d.id(), d.id(), List.copyOf(targets)));
            } else if (n instanceof Playbook.Step s) {
                for (Playbook.Arrow a : p.arrows()) {
                    if (a.from().equals(s.id())) {
                        edges.add(new Topology.Edge(s.id(), ends.contains(a.to()) ? StateGraph.END : a.to(), "direct", null));
                    }
                }
            }
        }
        return new Topology(Topology.SCHEMA_VERSION, p.start(), List.copyOf(nodes), List.copyOf(edges), List.copyOf(branches));
    }
}
```

If `Topology.Edge`'s record component order differs from `(from, to, kind, branch)` at `1cba586c` (read `Topology.java:73 to 83`), adapt the constructor calls; the test asserts by record equality.

- [ ] **Step 4: Run, commit** with explicit paths.

---

### Task 4: Playbook folders and the pin (server)

**Files:**
- Create: `spectro-server/src/main/java/dev/spectroscope/server/playbooks/PlaybookFolders.java`
- Test: `spectro-server/src/test/java/dev/spectroscope/server/playbooks/PlaybookFoldersTest.java`

**Interfaces:**
- Produces: `PlaybookFolders(Path file)` with `static PlaybookFolders inHome()` (`~/.spectro/playbooks.json`); `record State(List<String> folders, Map<String, String> activeByWorkspace)`; `State read()`; `void register(Path folder)` (requires `folder/playbook.json` to exist; stores the real path; idempotent); `void pin(Path workspace, Path folder)` (folder must be registered); `Path activeFor(Path workspace)` (null when none). Writes are atomic (temp file plus move), the file is `{"folders":[...],"active":{"<workspace>":"<folder>"}}`.

- [ ] **Step 1: Write the failing test**

```java
package dev.spectroscope.server.playbooks;

import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertThrows;

class PlaybookFoldersTest {

    @TempDir Path tmp;

    private Path playbookFolder(String name) throws IOException {
        Path folder = Files.createDirectories(tmp.resolve(name));
        Files.writeString(folder.resolve("playbook.json"), "{}");
        return folder;
    }

    @Test
    void registersAFolderOnceAndPinsItToAWorkspace() throws IOException {
        PlaybookFolders folders = new PlaybookFolders(tmp.resolve("playbooks.json"));
        Path a = playbookFolder("a");
        folders.register(a);
        folders.register(a);
        assertEquals(List.of(a.toRealPath().toString()), folders.read().folders());
        Path ws = Files.createDirectories(tmp.resolve("ws"));
        assertNull(folders.activeFor(ws));
        folders.pin(ws, a);
        assertEquals(a.toRealPath(), folders.activeFor(ws));
        // survives a fresh reader
        assertEquals(a.toRealPath(), new PlaybookFolders(tmp.resolve("playbooks.json")).activeFor(ws));
    }

    @Test
    void refusesAFolderWithoutAPlaybookAndAPinToAnUnknownFolder() throws IOException {
        PlaybookFolders folders = new PlaybookFolders(tmp.resolve("playbooks.json"));
        Path empty = Files.createDirectories(tmp.resolve("empty"));
        assertThrows(IllegalArgumentException.class, () -> folders.register(empty));
        Path ws = Files.createDirectories(tmp.resolve("ws"));
        assertThrows(IllegalArgumentException.class, () -> folders.pin(ws, empty));
    }

    @Test
    void aMissingFileReadsAsEmpty() {
        PlaybookFolders folders = new PlaybookFolders(tmp.resolve("none.json"));
        assertEquals(List.of(), folders.read().folders());
    }
}
```

- [ ] **Step 2: Run to verify it fails**, **Step 3: Implement** with Jackson (`ObjectMapper`), `Files.writeString` to `file.resolveSibling(file.getFileName() + ".tmp")` then `Files.move(..., ATOMIC_MOVE, REPLACE_EXISTING)`, `toRealPath()` on every stored path, `IllegalArgumentException` for the two refusals. `inHome()` uses `Path.of(System.getProperty("user.home"), ".spectro", "playbooks.json")`, the same home rule the tests already redirect.

- [ ] **Step 4: Run, commit**.

---

### Task 5: The loader and the routes (server)

**Files:**
- Create: `spectro-server/src/main/java/dev/spectroscope/server/playbooks/PlaybookLoader.java`
- Create: `spectro-server/src/main/java/dev/spectroscope/server/playbooks/PlaybookController.java`
- Test: `spectro-server/src/test/java/dev/spectroscope/server/playbooks/PlaybookLoaderTest.java`
- Test: `spectro-server/src/test/java/dev/spectroscope/server/playbooks/PlaybookControllerTest.java`

**Interfaces:**
- Consumes: `PlaybookReader`, `PlaybookValidator`, `PlaybookTopology`, `SkillLibrary.load(SkillLibrary.defaultRoots(cwd))` and `SkillLibrary.find(name)`, `ProviderRegistry.shared().rows(config)` from P1 (when P1 is merged; otherwise `SpectroConfig.onboardingStatus`, see the note).
- Produces:

```java
public record Loaded(Playbook playbook, Topology topology, List<Finding> findings,
                     List<StepResolution> steps, String dir) {}
public record StepResolution(String id, List<SkillState> skills, ModelState model) {}
public record SkillState(String name, boolean installed) {}
public record ModelState(String choice, String provider, String model, String state, String reason) {}
public static Loaded load(Path dir, Path workspace, SpectroConfig config);
```

Rule 8 lives here: every `contents` path is resolved against `dir.toRealPath()` and must start with it and exist; a violation is a finding `contents.skills[i]`. Caps: `playbook.json` at most 1 MB; the folder at most 200 files (counted with `Files.walk` depth 4, the way `SkillCatalogue.MAX_FILES` is enforced).

Routes (all in `PlaybookController`, fence as in P1 Task 4 for every write):

| Route | Body or query | Answer |
|---|---|---|
| `GET /api/playbooks?workspace=` | | `{ folders: [..], active: "<dir>" or null }` |
| `POST /api/playbooks/folders` | `{ "dir": "/abs/path" }` | 200 the state; 400 not a folder or no `playbook.json`; 404 foreign |
| `PUT /api/playbooks/active` | `{ "workspace": "/abs", "dir": "/abs" }` | 200 the state; 400 unknown folder |
| `GET /api/playbooks/load?dir=&workspace=` | | 200 `Loaded`; 400 unknown folder (only registered folders load, so the wire cannot read arbitrary paths) |
| `POST /api/playbooks/bundled/{id}/copy` | `{ "dir": "/abs" }` | 200 `{written, dir}`; 404 unknown id; 409 conflicts; registers the folder |

The copy reuses the scaffold's two pass logic (`BundleController.java:118 to 133`): resolve every target, refuse any path outside, refuse if any exists, then write. The bundled files come from classpath `bundled-playbooks/<id>/**` through `PathMatchingResourcePatternResolver`, as `BundledSkills.java:73` reads `bundled-skills/**/SKILL.md`.

P1 dependency: `ModelState.state` is the registry row's `state` for `provider` when `ProviderRegistry` exists on the classpath, with `reason` from the row; the model is marked `unverified` when the row has no live list containing it. Until P1 merges, build this task against `SpectroConfig.onboardingStatus(provider, keyPresent)` behind a package private `ProviderStates` interface with one implementation, and swap the implementation to the registry in P1's integration (one method, one test).

- [ ] **Step 1: Write the failing tests**: `PlaybookLoaderTest` loads the spec's `MINIMAL` written to a temp folder with `skills/spectropowers/brainstorming/SKILL.md` present and asserts zero findings, a topology with four nodes, and a step resolution whose skill `spectropowers:brainstorming` is `installed=false` (the temp home has no such skill) and whose model state is a known word; a second case with `"skills": ["../outside"]` in `contents` asserts a finding at `contents.skills[0]`; a third case with 201 files asserts a finding at `contents`. `PlaybookControllerTest` drives the controller with `MockHttpServletRequest` as P1 Task 4 does: register, pin, load, copy into an empty temp folder (asserts `playbook.json`, `LICENSE`, `PROVENANCE.md`, `skills/spectropowers/brainstorming/SKILL.md` exist afterwards), copy again (409), foreign caller (404).

- [ ] **Step 2: Run to verify they fail**, **Step 3: Implement** the loader and the controller as specified (the controller has a no arg constructor using `PlaybookFolders.inHome()` and a package private one taking `PlaybookFolders` for tests), **Step 4: Run, commit**.

---

### Task 6: spectropowers and the spectro playbook (content)

**Files:**
- Create: `spectro-server/src/main/resources/bundled-playbooks/spectro/playbook.json`
- Create: `spectro-server/src/main/resources/bundled-playbooks/spectro/LICENSE` (the MIT text from `.spectro/skills-catalogue/superpowers/LICENSE`, byte identical)
- Create: `spectro-server/src/main/resources/bundled-playbooks/spectro/PROVENANCE.md`
- Create: `spectro-server/src/main/resources/bundled-playbooks/spectro/skills/spectropowers/<each of the 14 skill folders>/...` (copied from `.spectro/skills-catalogue/superpowers/skills/`, then edited)
- Create: `spectro-server/src/main/resources/bundled-playbooks/spectro/templates/{ticket,spec,plan,task-report,review-report}.md`
- Create: `scripts/copy_spectropowers.py` (stdlib: copies the catalogue skills into the bundle folder, renames `using-superpowers` to `using-spectropowers`, replaces the word `superpowers` by `spectropowers` in skill names and cross references, and writes `PROVENANCE.md` with the catalogue's `PROVENANCE.json` fields, the date passed as `--date`, and one line per edited file; rerunnable, byte identical for the same inputs)
- Test: `spectro-server/src/test/java/dev/spectroscope/server/playbooks/SpectroPlaybookTest.java`

**Interfaces:**
- Consumes: `PlaybookReader`, `PlaybookValidator`, `PlaybookTopology`, the catalogue at `.spectro/skills-catalogue/superpowers` (commit `44c9b2d6` per its `PROVENANCE.json`, vendored 2026-08-06).
- Produces: the bundle. Its `playbook.json` has the graph of the spec (section "The spectro playbook and spectropowers"), model choices `fast`, `standard`, `strong`, `judge` with the provider and model ids chosen from what the owner's machine lists at build time and recorded in the card, document types `ticket`, `spec`, `plan`, `task_report`, `review_report`, checks `classify_check` (human, labels spike, bounded, architectural), `spec_sections`, `spec_nod` (human), `plan_sections`, `plan_nod` (human), `tests_green` (command `{test}`), `task_review` (review, model `standard`, labels pass, fail), `final_review` (review, model `judge`, labels pass, fail), vars `test`.

- [ ] **Step 1: Write the failing test**

```java
package dev.spectroscope.server.playbooks;

import dev.spectroscope.core.playbook.Finding;
import dev.spectroscope.core.playbook.Playbook;
import dev.spectroscope.core.playbook.PlaybookReader;
import dev.spectroscope.core.playbook.PlaybookValidator;
import org.junit.jupiter.api.Test;
import org.springframework.core.io.ClassPathResource;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.util.List;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

/** The shipped playbook is valid, licensed, provenanced and carries the house rules. */
class SpectroPlaybookTest {

    private static String resource(String path) throws IOException {
        return new ClassPathResource("bundled-playbooks/spectro/" + path).getContentAsString(StandardCharsets.UTF_8);
    }

    @Test
    void theShippedPlaybookReadsAndValidatesClean() throws IOException {
        PlaybookReader.Read read = PlaybookReader.read(resource("playbook.json"));
        assertEquals(List.of(), read.findings());
        List<Finding> findings = PlaybookValidator.validate(read.playbook());
        assertEquals(List.of(), findings, findings.toString());
        Playbook p = read.playbook();
        assertEquals("spectro", p.id());
        assertTrue(p.models().keySet().containsAll(List.of("fast", "standard", "strong", "judge")));
        assertTrue(p.documents().keySet().containsAll(List.of("ticket", "spec", "plan", "task_report", "review_report")));
    }

    @Test
    void everyStepNamesASpectropowersSkillThatShipsInTheBundle() throws IOException {
        Playbook p = PlaybookReader.read(resource("playbook.json")).playbook();
        for (Playbook.Node n : p.nodes()) {
            if (n instanceof Playbook.Step s) {
                for (String skill : s.skills()) {
                    assertTrue(skill.startsWith("spectropowers:"), s.id() + " names " + skill);
                    String folder = skill.substring("spectropowers:".length());
                    assertTrue(new ClassPathResource("bundled-playbooks/spectro/skills/spectropowers/" + folder + "/SKILL.md").exists(),
                            s.id() + " names a skill that does not ship: " + skill);
                }
            }
        }
    }

    @Test
    void licenceAndProvenanceTravelWithTheCopy() throws IOException {
        assertTrue(resource("LICENSE").startsWith("MIT License"));
        String provenance = resource("PROVENANCE.md");
        assertTrue(provenance.contains("https://github.com/obra/superpowers"));
        assertTrue(provenance.contains("44c9b2d6e889982ac18c27d05a19fefe335194e1"));
        for (String skill : List.of("brainstorming", "writing-plans", "subagent-driven-development", "executing-plans",
                "test-driven-development", "verification-before-completion", "finishing-a-development-branch",
                "requesting-code-review", "using-spectropowers")) {
            assertTrue(provenance.contains(skill), "provenance names " + skill);
        }
    }

    /** One marker sentence per house rule change (spec table), each tested as present. */
    static final Map<String, String> MARKERS = Map.of(
            "brainstorming", "chris-criticism",
            "writing-plans", "explicit staging paths",
            "subagent-driven-development", "stop and ask the owner",
            "executing-plans", "TASKS.md",
            "test-driven-development", "commit first, break the implementation",
            "verification-before-completion", "never through a pipe",
            "finishing-a-development-branch", "--no-ff",
            "requesting-code-review", "merge base",
            "using-spectropowers", "User instructions");

    @Test
    void theHouseRulesArePresentInTheRewrittenSkills() throws IOException {
        for (Map.Entry<String, String> e : MARKERS.entrySet()) {
            String text = resource("skills/spectropowers/" + e.getKey() + "/SKILL.md");
            assertTrue(text.contains(e.getValue()), e.getKey() + " lacks the marker: " + e.getValue());
            assertTrue(!text.contains("superpowers:") || e.getKey().equals("using-spectropowers"),
                    e.getKey() + " still references a superpowers: skill name");
        }
    }

    @Test
    void noDashAsPunctuationInTheShippedSkills() throws IOException {
        for (String skill : MARKERS.keySet()) {
            String text = resource("skills/spectropowers/" + skill + "/SKILL.md");
            assertTrue(!text.contains("—") && !text.contains("–"), skill + " carries a dash");
        }
    }
}
```

The last test will go red on the verbatim copy (the upstream skills use dashes); the rewrite pass replaces them. That is the measured scope of the pass: count them first with `grep -c` per file and record the numbers in the card.

- [ ] **Step 2: Run to verify it fails** (resources missing).

- [ ] **Step 3: Copy the catalogue skills** with `scripts/copy_spectropowers.py --date 2026-10-10` (write the script: `shutil.copytree` of each skill folder, the rename of `using-superpowers`, a text pass over every `.md` that replaces `superpowers:` with `spectropowers:` and `superpowers` in headings with `spectropowers`, a `PROVENANCE.md` written from the catalogue's `PROVENANCE.json` plus a table of files changed). Commit the verbatim copy plus the script as its own commit, so the rewrite is a readable diff on top.

- [ ] **Step 4: Work the house rules in**, one skill at a time, each the exact change the spec table names, with the marker sentence from `MARKERS` present in the text, and every dash replaced by a comma, a colon, parentheses or a new sentence. The nine edits:

1. `brainstorming/SKILL.md`: in "Three Paths" under Bounded, replace "No spec file, no implementation plan document." with "No spec file. The short design is written as a numbered plan into the ticket before implementation starts." Add to the Checklist for every path a first item "Read the ticket: technical requirements, non functional requirements and the Gherkin scenarios. Without a ticket, write one with the story-writing form first." After "Spec Self-Review" add the section "Stress test: run chris-criticism on the spec and fix what it finds before the user review gate."
2. `writing-plans/SKILL.md`: in the plan header add the line "**Ticket:** [path to the card]"; in the Task Structure commit step replace the example with `git add <exact paths>` and the sentence "Stage explicit staging paths, never `git add -A`."
3. `subagent-driven-development/SKILL.md`: in the stop conditions add "A plan conflict that touches architecture, language, repository or scope: stop and ask the owner; never rule on it." Replace the ledger deletion at the end with "Keep the ledger; copy the rulings into the project's TASKS.md and the open points into CLAUDE.md." In Model Selection replace the tier text with the role rule: "building on opus, reading and review on sonnet, mechanical steps on haiku, the final review on fable." In the implementer section: "Every task starts with the failing test; the report shows the red run." Add "Reviews may run in the background while the next implementer starts; findings are applied as follow up fixes."
4. `executing-plans/SKILL.md`: the same stop rule and "progress goes into TASKS.md after every task."
5. `test-driven-development/writing-good-tests.md`: replace the mental mutation with "The mutation probe is real: commit first, break the implementation, run the test and see it red, restore from the commit, see it green. Never revert with git checkout while uncommitted work sits in the same file."
6. `verification-before-completion/SKILL.md`: add "Gates run with a forced rerun (`--rerun-tasks --no-build-cache`, a fresh `vitest run`) and never through a pipe, because a pipe reports the exit code of the last command. UI work is verified in a browser in both themes at two widths."
7. `finishing-a-development-branch/SKILL.md`: Option 1 merges with `git merge --no-ff`; the rulings list is written into TASKS.md before cleanup; add "After the final review, run chris-criticism once on the branch summary."
8. `requesting-code-review/SKILL.md`: replace the `HEAD~1` example with "the base is the merge base of the branch (`git merge-base main HEAD`)".
9. `using-spectropowers/SKILL.md`: first paragraph: "User instructions (CLAUDE.md, the project's rules, direct requests) take precedence over every skill here."

- [ ] **Step 5: Write `playbook.json`** from the spec's graph. Node list (ids): `classify` (decision), `brainstorm`, `spec_ok` (decision, max_rounds 3), `spec_nod` (decision, human), `write_plan`, `plan_ok` (decision, max_rounds 3), `plan_nod` (decision, human), `setup` (step, skills `spectropowers:using-git-worktrees`), `implement` (step, child, worker, model `standard`, skills `spectropowers:test-driven-development`), `review_task` (decision, review by `standard`, max_rounds 5), `fix` (step, child, worker, model `strong`), `more_tasks` (decision, open_items on `plan`), `final_review` (decision, review by `judge`, max_rounds 2), `final_fix` (step), `finish` (step, skills `spectropowers:finishing-a-development-branch`), `design_in_chat` (step, bounded), `implement_bounded` (step), `probe` (step, spike), `done` (end), `cancelled` (end). Arrows per outcome, including `exhausted` arrows to `cancelled` for every decision with `max_rounds`. Run the validator through the test until it reports zero findings; keep the count of fixes in the card.

- [ ] **Step 6: Templates**: five Markdown templates whose headings match the `sections` of the document types (the `sections` check reads them). `ticket.md` follows the story-writing form (Story, Value, Context, Acceptance criteria, Scenario, Provenance; plus Non functional criteria), `spec.md` (Goal, Design, Requirements, Out of scope, Acceptance scenarios), `plan.md` (the writing-plans header: Goal, Architecture, Tech Stack, Spec, Ticket, Global Constraints, Tasks), `task-report.md` (Task, Red run, Green run, Files, Open points), `review-report.md` (Strengths, Critical, Important, Minor, Verdict).

- [ ] **Step 7: Run the test to verify it passes; commit the rewrite and the playbook as one commit** with a message that lists the nine edits.

---

### Task 7: The documentation page builder (scripts)

**Files:**
- Create: `scripts/build_playbook_docs.py` (stdlib only)
- Create: `spectro-server/src/main/resources/bundled-playbooks/spectro/docs/index.html` (generated)
- Test: `spectro-server/src/test/java/dev/spectroscope/server/playbooks/PlaybookDocsDriftTest.java`

**Interfaces:**
- Produces: `python3 scripts/build_playbook_docs.py <playbook folder>` writes `<folder>/docs/index.html`: a single file, no network, `<title>` = the playbook name, light and dark through `prefers-color-scheme` with CSS custom properties, an inline SVG of the graph (longest path ranks, columns per rank, straight arrows forward, arrows that go back drawn as a loop below the row with the outcome label), one section per step (performer, model choice, skills, consumes, produces, nod), one per decision (check, outcomes, max rounds), one per document type (purpose, location, sections), the licence and the provenance. Deterministic: no timestamps, dictionaries iterated in file order.

- [ ] **Step 1: Write the failing drift test**: it runs the script twice into two temp folders (`ProcessBuilder("python3", "scripts/build_playbook_docs.py", folder)`, skipped with `assumeTrue` when `python3` is absent), asserts the two outputs are byte identical, and asserts the committed `docs/index.html` equals the fresh output (so an edited `playbook.json` without a rebuild goes red, the house pattern of `ConfigDocDriftTest`).

- [ ] **Step 2: Run to verify it fails**, **Step 3: Write the script** (about 250 lines: `json.load`, a rank function by longest path over forward arrows with back arrows detected by a DFS, an SVG writer with `<rect>`, `<polygon>` for decisions, `<path>` arrows and `<text>` labels, all colours as `var(--...)` with a `:root` block for light and a `@media (prefers-color-scheme: dark)` block, HTML sections written with `html.escape`), **Step 4: Run the script, run the test, commit** the script and the generated page.

---

### Task 8: The third mode word (web)

**Files:**
- Modify: `spectro-web/src/state/viewMode.ts:15-20, 47-49`
- Modify: `spectro-web/src/state/surfaces.ts:43-87` (a `developer` column; `tabRow` and `leveling` get records of their own)
- Modify: `spectro-web/src/components/ModeSwitch.tsx:47, 57` (labels from a map), `modeForKey` (cycle over `VIEW_MODES`)
- Modify: `spectro-web/src/components/ModeIntro.tsx` (no code change expected; verify the picture draws the `playbook` row from `SURFACES`)
- Modify: `spectro-web/src/i18n/i18n.ts` (`hdr.mode.developer`, `hdr.mode.developerTitle`, `mode.intro.developer.name`, `.body`, `.switch`)
- Modify tests: `state/viewMode.test.ts:77` (remove `developer` from the odd words, add it as a stored word), `state/surfaces.test.ts:50-51` (three columns), `state/surfaces.guard.test.tsx:90, 124`, `state/firstStart.guard.test.tsx:107, 118`, `state/firstStart.test.ts:70` (iterate `VIEW_MODES`), `components/ModeSwitch.test.tsx` (three radios; the keyboard cycles learn, light, developer, learn), `components/modeIntro.test.tsx` (a third choice; the mock test at 126 to 142 replaced by the real word)

**Interfaces:**
- Produces: `export type ViewMode = "learn" | "light" | "developer"`; `VIEW_MODES = ["learn", "light", "developer"]`; `asMode` reads `VIEW_MODES.includes(raw)`; `SurfaceSpec.modes` is `Record<ViewMode, Presence>` (the type already forces the third column: the file does not compile until every entry has it); `playbook` surface entry `{ learn: "gone", light: "gone", developer: "open", chunks: ["playbook/PlaybookPane.tsx"] }` (the segment id is added in Task 10; add the entry there and the column here).

- [ ] **Step 1: Change the tests first** as listed, run `npx vitest run src/state src/components/ModeSwitch.test.tsx src/components/modeIntro.test.tsx` and save the red output (`task8-red.log`): `viewMode.test.ts` red on the stored word, `surfaces.test.ts` red on the shape, `ModeSwitch.test.tsx` red on three radios and the cycle, `modeIntro.test.tsx` red on the third choice.

- [ ] **Step 2: Implement**:

`viewMode.ts`:

```ts
export type ViewMode = "learn" | "light" | "developer";
export const VIEW_MODES: readonly ViewMode[] = ["learn", "light", "developer"];
function asMode(raw: string | null): ViewMode {
  return (VIEW_MODES as readonly string[]).includes(raw ?? "") ? (raw as ViewMode) : DEFAULT_VIEW_MODE;
}
```

`surfaces.ts`: `const EVERYWHERE = { learn: "open", light: "open", developer: "open" }`, `LEARN_ONLY = { learn: "open", light: "gone", developer: "open" }` (developer opens what learn opens), `tabRow: { modes: { learn: "open", light: "tutorial", developer: "open" } }`, `leveling: { modes: { learn: "open", light: "tutorial", developer: "tutorial" } }`, and the new `playbook` entry.

`ModeSwitch.tsx`: `title={t(lang, \`hdr.mode.${option}Title\`)}` and `{t(lang, \`hdr.mode.${option}\`)}`; `modeForKey` moves to the next or previous entry of `VIEW_MODES` with wrap.

Strings:

```ts
  "hdr.mode.developer": { de: "developer", en: "developer" },
  "hdr.mode.developerTitle": {
    de: "developer: alles wie learn, dazu das Playbook-Modul und ohne Tutorial",
    en: "developer: everything learn shows, plus the playbook module, with no tutorial",
  },
  "mode.intro.developer.name": { de: "developer", en: "developer" },
  "mode.intro.developer.body": {
    de: "Alles wie learn, dazu ein Playbook: eine Arbeitsweise aus Schritten, Übergabedokumenten und einem Modell je Schritt, die du zeichnest und nach der später gebaut wird. Kein Tutorial.",
    en: "Everything learn shows, plus a playbook: a way of working made of steps, handover documents and a model per step, which you draw and later build by. No tutorial.",
  },
  "mode.intro.developer.switch": {
    de: "Zu learn oder light wechselst du später mit dem Modus-Schalter oben rechts im Fenster.",
    en: "You can switch to learn or light later with the mode switch at the top right of the window.",
  },
```

Also update `hdr.mode.learnTitle` and `hdr.mode.lightTitle` where they say "the learn and light switch", and `mode.intro.learn.switch` and `mode.intro.light.switch` to name the mode switch without listing two words.

- [ ] **Step 3: Run the tests and `npm run gate`; commit** with explicit paths.

---

### Task 9: The web store `state/playbooks.ts`

**Files:**
- Create: `spectro-web/src/state/playbooks.ts`
- Test: `spectro-web/src/state/playbooks.test.ts`

**Interfaces:**
- Produces:

```ts
export interface PlaybookFoldersState { folders: string[]; active: string | null }
export interface LoadedPlaybook {
  playbook: { id: string; name: string; description: string; start: string; nodes: PlaybookNode[]; arrows: PlaybookArrow[];
              models: Record<string, { primary: { provider: string; model: string }; fallbacks: { provider: string; model: string }[] }>;
              documents: Record<string, { name: string; purpose: string; location: string; sections: string[] }> };
  topology: { entry: string; nodes: { id: string; label: string }[]; edges: { from: string; to: string; kind: string; branch?: string }[] };
  findings: { path: string; message: string }[];
  steps: { id: string; skills: { name: string; installed: boolean }[]; model: { choice: string; provider: string; model: string; state: string; reason: string | null } | null }[];
  dir: string;
}
export type PlaybookNode = { kind: "step"; id: string; name: string; performer: "chat" | "child"; skills: string[]; model: string | null; privacy: "private" | "cheap"; consumes: string[]; produces: string[]; nod: boolean }
  | { kind: "decision"; id: string; name: string; check: string; outcomes: string[]; maxRounds: number | null }
  | { kind: "end"; id: string; result: string };
export interface PlaybookArrow { from: string; to: string; on: string | null }
export function usePlaybookFolders(): PlaybookFoldersState;
export function useLoadedPlaybook(): LoadedPlaybook | null;
export function refreshFolders(workspace: string): Promise<void>;
export function registerFolder(dir: string): Promise<void>;
export function pinFolder(workspace: string, dir: string): Promise<void>;
export function loadPlaybook(dir: string, workspace: string): Promise<void>;
export function copyBundled(id: string, dir: string): Promise<{ ok: boolean; conflicts?: string[] }>;
export function toWebTopology(loaded: LoadedPlaybook): Topology;   // the layout engine's input type
export function __resetPlaybooks(): void;
```

`toWebTopology` maps the server's `Topology` JSON to `stategraph/layout.ts`'s `Topology`: `entry`, `nodes`, `edges` with `kind` narrowed to `direct` or `conditional`.

- [ ] **Step 1: Write the failing test** in the style of `providerRegistry.test.ts` (P1 Task 7): stub fetch, assert the five calls hit their routes with the right method and body, assert the stores update, assert `toWebTopology` drops `branch` and keeps `kind`, and assert a 409 on `copyBundled` returns `{ ok: false, conflicts: [...] }`.

- [ ] **Step 2: Run to verify it fails**, **Step 3: Implement** with two `useSyncExternalStore` stores (folders and loaded), **Step 4: Run, commit**.

---

### Task 10: The playbook segment (web)

**Files:**
- Modify: `spectro-web/src/components/navRows.ts:29, 114-163` (`NavSegmentId` gains `playbook`; a row `{ id: "playbook", labelKey: "nav.playbook", icon: "playbook", disabled: false, active, trailing: null }`; the icon is added where `NavIconId` and its SVGs live, read `navRows.ts:1 to 28` and the icon component)
- Modify: `spectro-web/src/state/surfaceChunks.ts:60` (`loadPlaybookPane`, `export const PlaybookPane = lazy(...)`)
- Modify: `spectro-web/src/App.tsx:348, 371, 2739` (`nav` state type gains `"playbook"`; the arm `nav === "playbook" ? <PlaybookPane workspace={...} /> :` before the stategraph arm; the workspace path is the session's resolved workspace the folder chip shows, read how `AppHeader.tsx:38 to 43` gets it and pass the same value)
- Create: `spectro-web/src/playbook/PlaybookPane.tsx`, `spectro-web/src/playbook/PlaybookGraph.tsx`, `spectro-web/src/playbook/StepTable.tsx`, `spectro-web/src/playbook/playbook.css`
- Modify: `spectro-web/src/i18n/i18n.ts` (`nav.playbook`, `pb.*`)
- Test: `spectro-web/src/playbook/playbookPane.test.tsx`, `spectro-web/src/playbook/playbookGraph.test.tsx`, `spectro-web/src/state/surfaces.guard.test.tsx` (the guard renders the App in developer and finds the segment; in learn and light it must not)

**Interfaces:**
- Consumes: Task 9's store; `layoutStateGraph` and `CanvasOverlay` from `stategraph` (`StateGraphView.tsx:500` exports `CanvasOverlay`); `PlacedNode`, `RoutedEdge` types.
- Produces: `PlaybookPane({ workspace }: { workspace: string | null })`; `PlaybookGraph({ loaded }: { loaded: LoadedPlaybook })` which calls `layoutStateGraph(toWebTopology(loaded), "horizontal")` with `sizes` stating `w: 180, h: 64` for steps and `w: 140, h: 64` for decisions, draws a `<rect>` per step (label, model choice, performer), a `<polygon>` diamond per decision (label, `max_rounds` as "up to N rounds"), the routed edges from the layout with outcome labels at the edge's label anchor, and marks every `conditional` edge whose target rank is lower than its source rank with the class `pb-edge--back`; `StepTable({ loaded })` renders the rows of the spec.

- [ ] **Step 1: Write the failing tests**:

`playbookGraph.test.tsx` (static render with a seeded loaded playbook: the spec's MINIMAL shape as JSON): asserts one `<rect class="pb-step">` for `write`, one `<polygon class="pb-decision">` for `ok`, an edge with class `pb-edge--back` for `ok -> write`, and the label `fail` on it.

`playbookPane.test.tsx`: with no folders, the pane renders the picker, the path field, the copy button (`pb-copy`) and the sentence `pb.noRuns`; with a loaded playbook it renders `PlaybookGraph` and `StepTable` and the findings list when findings exist.

`surfaces.guard.test.tsx`: extend the mode loop to `VIEW_MODES` and add: in developer the rendered App contains `data-nav="playbook"`; in learn and light it does not.

- [ ] **Step 2: Run to verify they fail**, **Step 3: Implement** the three components, the nav row, the chunk and the App arm; strings:

```ts
  "nav.playbook": { de: "Playbook", en: "Playbook" },
  "pb.title": { de: "Playbook", en: "Playbook" },
  "pb.folders": { de: "Playbook-Ordner", en: "Playbook folders" },
  "pb.addFolder": { de: "Ordner hinzufügen (absoluter Pfad)", en: "Add a folder (absolute path)" },
  "pb.add": { de: "Hinzufügen", en: "Add" },
  "pb.useHere": { de: "Für diesen Arbeitsbereich verwenden", en: "Use for this workspace" },
  "pb.copyBundled": { de: "Das spectro-Playbook in einen Ordner kopieren", en: "Copy the spectro playbook into a folder" },
  "pb.copyConflicts": { de: "Nichts geschrieben, diese Dateien gibt es schon: {files}", en: "Nothing written, these files already exist: {files}" },
  "pb.noRuns": { de: "Läufe folgen dem Playbook noch nicht. Diese Version zeichnet es und prüft die Datei.", en: "Runs do not follow the playbook yet. This version draws it and checks the file." },
  "pb.findings": { de: "Befunde", en: "Findings" },
  "pb.steps": { de: "Schritte", en: "Steps" },
  "pb.col.step": { de: "Schritt", en: "Step" },
  "pb.col.performer": { de: "Wer", en: "Who" },
  "pb.col.skills": { de: "Skills", en: "Skills" },
  "pb.col.model": { de: "Modell", en: "Model" },
  "pb.col.privacy": { de: "Privat", en: "Private" },
  "pb.col.consumes": { de: "Nimmt", en: "Consumes" },
  "pb.col.produces": { de: "Liefert", en: "Produces" },
  "pb.col.nod": { de: "Freigabe", en: "Nod" },
  "pb.installed": { de: "installiert", en: "installed" },
  "pb.notInstalled": { de: "nicht installiert", en: "not installed" },
  "pb.chat": { de: "im Chat", en: "in the chat" },
  "pb.child": { de: "Kind-Agent", en: "child agent" },
  "pb.rounds": { de: "bis zu {n} Runden", en: "up to {n} rounds" },
```

CSS tokens only (`playbook.css` imported by the pane; `stategraph.css` is the precedent with 149 `var(--` uses and no hex).

- [ ] **Step 4: Run the tests and `npm run gate`; verify live**: build the jar, start with a temp home, switch to developer, copy the bundled playbook into a temp folder, pin it, screenshot the segment in both themes at 1280 and 390 px into `kanban/evidence/<card>/`, read the console for errors; confirm with the network panel that `playbook/PlaybookPane` chunk is not requested in learn or light (switch modes and list the requests).

- [ ] **Step 5: Commit** with explicit paths.

---

### Task 11: Documentation, gates, release note

- [ ] **Step 1**: user guide chapter "Playbooks" (what a playbook is, the folder layout, the developer mode, the copy button, what version 1 does not do), rebuild the guide (`docs/guide-assets/build_user_guide.py`), `ConfigDocDriftTest` green. README: the mode list gains developer where learn and light are named (`grep -n "light" README.md`).
- [ ] **Step 2**: full gates alone (`./gradlew test --rerun-tasks --no-build-cache`, `./gradlew javadoc --rerun-tasks --no-build-cache`, `npm run gate`), outputs redirected into `kanban/evidence/<card>/`, exit codes read from the shell.
- [ ] **Step 3**: `tools/prepush-scan.sh` over the branch range (the bundle must carry no private address, hostname or employer word; the spectropowers text was written by an upstream author and carries none, but the scan runs anyway).
- [ ] **Step 4**: commit; release note line: "A third mode, developer, with a playbook: a folder that pins how you build, drawn as a graph with a model per step; the spectro playbook ships and copies into a folder with one button. Runs do not follow it yet."

---

## Self-review

Spec coverage: requirement 1 (Tasks 1, 2, 5, 6), 2 (Task 3, 10), 3 (Task 8), 4 (Task 8 and 10's guard), 5 (Task 10), 6 (Task 5), 7 (Task 6), 8 (Task 7), 9 (Task 1, rule 6; Task 5 for paths), 10 (Task 10 Step 4).

Type consistency: `Finding(path, message)` everywhere; `Playbook.Step` has twelve components in the order the reader builds them; `Topology.Edge(from, to, kind, branch)` is asserted by equality in Task 3 and consumed by Task 9's `toWebTopology`; the web `LoadedPlaybook.steps[].model.state` carries P1's state words or the presence words, both strings.

Known uncertainty, stated: the `Topology.Edge` component order and the `StateGraph.START`/`END` spellings are read from the code before the Task 3 test is written; `NavIconId` and its SVG registry are read before Task 10 adds the icon; the P1 dependency in Task 5 is behind one interface so P2 can build before P1 merges.
