package dev.spectroscope.core.playbook.run;

import dev.spectroscope.core.playbook.Playbook;
import dev.spectroscope.core.playbook.PlaybookReader;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.attribute.FileTime;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

class DocumentChecksTest {

    @TempDir Path ws;

    private Path write(String rel, String text, long mtime) throws IOException {
        Path f = ws.resolve(rel);
        Files.createDirectories(f.getParent());
        Files.writeString(f, text);
        Files.setLastModifiedTime(f, FileTime.fromMillis(mtime));
        return f;
    }

    @Test
    void aLocationBecomesAGlobWithDeclaredVarsFilledIn() {
        assertEquals("docs/specs/*-*-design.md", DocumentLocator.glob("docs/specs/{date}-{slug}-design.md", Map.of()));
        assertEquals("kanban/482-*.md", DocumentLocator.glob("kanban/{n}-{slug}.md", Map.of("n", "482")));
    }

    @Test
    void theDocumentAStepWroteIsTheNewestChangedMatch() throws IOException {
        write("docs/specs/2026-01-01-old-design.md", "# Goal\nx\n", 1_000L);
        String glob = DocumentLocator.glob("docs/specs/{date}-{slug}-design.md", Map.of());
        Map<Path, Long> before = DocumentLocator.snapshot(ws, glob);
        Path fresh = write("docs/specs/2026-10-09-run-design.md", "# Goal\nx\n", 5_000L);
        write("docs/specs/notes.md", "not a match", 6_000L);
        Map<Path, Long> after = DocumentLocator.snapshot(ws, glob);
        assertEquals(fresh, DocumentLocator.changed(before, after));
        assertNull(DocumentLocator.changed(after, after), "nothing changed, nothing found");
        assertEquals(fresh, DocumentLocator.newest(after));
    }

    @Test
    void aPlainLocationIsOneFile() throws IOException {
        Path plan = write("plan.md", "# Tasks\n- [x] one\n", 10L);
        assertEquals(Map.of(plan, 10L), DocumentLocator.snapshot(ws, "plan.md"));
        assertEquals(Map.of(), DocumentLocator.snapshot(ws, "missing.md"));
    }

    @Test
    void sectionsMustExistAndHoldText() throws IOException {
        Path spec = write("spec.md", "# Goal\nship it\n## Design\n\n# Requirements\n1. one\n", 1L);
        CheckResult r = DocumentChecks.sections("spec", spec, List.of("Goal", "Design", "Requirements", "Scenarios"), List.of());
        assertEquals("fail", r.label());
        assertTrue(r.detail().contains("empty section Design"), r.detail());
        assertTrue(r.detail().contains("missing section Scenarios"), r.detail());
        assertEquals("pass", DocumentChecks.sections("spec", spec, List.of("Goal", "Requirements"), List.of()).label());
        Path nested = write("nested.md", "# Design\n### Note\ntext\n", 1L);
        assertEquals("pass", DocumentChecks.sections("nested", nested, List.of("Design"), List.of()).label(),
                "a deeper heading inside a section does not end it");
    }

    @Test
    void aForbiddenStringFailsAndAMissingFileFails() throws IOException {
        Path spec = write("spec.md", "# Goal\nTBD\n", 1L);
        assertTrue(DocumentChecks.sections("spec", spec, List.of("Goal"), List.of("TBD")).detail().contains("forbidden TBD"));
        CheckResult missing = DocumentChecks.sections("spec", null, List.of("Goal"), List.of());
        assertEquals("fail", missing.label());
        assertEquals("spec: not written", missing.detail());
    }

    @Test
    void openItemsAreUncheckedBoxes() throws IOException {
        Path plan = write("plan.md", "# Tasks\n- [x] one\n- [ ] two\n  * [ ] three\n", 1L);
        CheckResult r = DocumentChecks.openItems("plan", plan);
        assertEquals("fail", r.label());
        assertEquals("plan: 2 open items", r.detail());
        Path done = write("done.md", "- [x] all\n", 1L);
        assertEquals("pass", DocumentChecks.openItems("done", done).label());
    }

    @Test
    void allPassesOnlyWhenEveryPartPasses() {
        assertEquals("pass", CheckResult.all(List.of(CheckResult.pass("a"), CheckResult.pass("b"))).label());
        CheckResult mixed = CheckResult.all(List.of(CheckResult.pass("a"), CheckResult.fail("b")));
        assertEquals("fail", mixed.label());
        assertEquals("a; b", mixed.detail());
    }

    // Card 596: the bundled planning skill writes its header as bold fields (**Goal:** and so on),
    // so a line that starts with a bold field counts as a section as well as a heading does.

    @Test
    void aLineThatStartsWithABoldFieldIsASection() throws IOException {
        Path plan = write("plan.md", """
                # Ship it Implementation Plan

                **Goal:** ship the release

                **Tech Stack:** Java 21
                """, 1L);
        CheckResult r = DocumentChecks.sections("plan", plan, List.of("Goal", "Tech Stack"), List.of());
        assertEquals("pass", r.label(), r.detail());
        assertEquals("plan: sections present", r.detail());
    }

    @Test
    void aBoldFieldMatchesItsSectionAsCaseInsensitivelyAsAHeadingDoes() throws IOException {
        Path heading = write("heading.md", "# tech STACK\nJava 21\n", 1L);
        Path field = write("field.md", "**tech STACK:** Java 21\n", 1L);
        assertEquals("pass", DocumentChecks.sections("heading", heading, List.of("Tech Stack"), List.of()).label());
        assertEquals("pass", DocumentChecks.sections("field", field, List.of("Tech Stack"), List.of()).label());
    }

    @Test
    void aBoldFieldSectionRunsToTheNextBoldFieldLineOrAHeadingOfLevelOneOrTwo() throws IOException {
        Path below = write("below.md", "**Goal:**\nship the release\nin two lines\n**Spec:** docs/spec.md\n", 1L);
        assertEquals("pass", DocumentChecks.sections("below", below, List.of("Goal", "Spec"), List.of()).label(),
                "text on the lines below the field belongs to the field");
        Path nextField = write("next-field.md", "**Goal:**\n\n**Notes:** not the goal\n", 1L);
        assertEquals("next-field: empty section Goal",
                DocumentChecks.sections("next-field", nextField, List.of("Goal"), List.of()).detail(),
                "any bold field line ends the field before it, a declared section or not");
        for (int level = 1; level <= 2; level++) {
            Path nextHeading = write("next-heading.md", "**Goal:**\n" + "#".repeat(level) + " Notes\nnot the goal\n", 1L);
            assertEquals("next-heading: empty section Goal",
                    DocumentChecks.sections("next-heading", nextHeading, List.of("Goal"), List.of()).detail(),
                    "a heading of level " + level + " ends a bold field");
        }
        for (int level = 3; level <= 6; level++) {
            Path deeper = write("deeper.md", "**Goal:**\n" + "#".repeat(level) + " Detail\nship it\n", 1L);
            assertEquals("pass", DocumentChecks.sections("deeper", deeper, List.of("Goal"), List.of()).label(),
                    "a heading of level " + level + " belongs to the bold field above it");
        }
        Path tasks = write("tasks.md", "**Tasks:**\n\n### Task 1: Parser\n\n**Files:**\n- Create: src/Parser.java\n", 1L);
        assertEquals("pass", DocumentChecks.sections("tasks", tasks, List.of("Tasks"), List.of()).label(),
                "the skill's task blocks under a Tasks field fill it");
    }

    @Test
    void aBoldFieldMayCloseItsBoldBeforeTheColon() throws IOException {
        Path outside = write("outside.md", "**Goal**: ship the release\n**Notes**: not the goal\n", 1L);
        assertEquals("pass", DocumentChecks.sections("outside", outside, List.of("Goal", "Notes"), List.of()).label());
        Path ends = write("ends.md", "**Goal:**\n**Notes**: not the goal\n", 1L);
        assertEquals("ends: empty section Goal", DocumentChecks.sections("ends", ends, List.of("Goal"), List.of()).detail(),
                "a field with the colon outside the bold ends the field before it");
    }

    @Test
    void aBoldFieldNameIsStrippedAndTheFirstFieldOfANameIsTheSection() throws IOException {
        Path spaced = write("spaced.md", "** Goal :** ship the release\n", 1L);
        assertEquals("pass", DocumentChecks.sections("spaced", spaced, List.of("Goal"), List.of()).label(),
                "spaces inside the bold around the name do not matter, as around a heading's name");
        Path twice = write("twice.md", "**Goal:**\n\n**Goal:** ship the release\n", 1L);
        assertEquals("twice: empty section Goal", DocumentChecks.sections("twice", twice, List.of("Goal"), List.of()).detail(),
                "the first field of a name is the section, as the first heading of a name is");
    }

    @Test
    void anIndentedQuotedOrFencedBoldFieldIsNoSection() throws IOException {
        Path elsewhere = write("elsewhere.md", "  **Goal:** indented\n> **Spec:** quoted\n```\n**Ticket:** fenced\n```\n", 1L);
        CheckResult r = DocumentChecks.sections("elsewhere", elsewhere, List.of("Goal", "Spec", "Ticket"), List.of());
        assertTrue(r.detail().startsWith("elsewhere: missing section Goal, missing section Spec, missing section Ticket ("),
                r.detail());
        Path plain = write("plain.md", "**Goal:** indented\n**Spec:** quoted\n```\ncode\n```\n**Ticket:** fenced\n", 1L);
        assertEquals("pass", DocumentChecks.sections("plain", plain, List.of("Goal", "Spec", "Ticket"), List.of()).label(),
                "the same fields at column 0 and outside the fence are sections");
    }

    @Test
    void aMissingSectionFailsAndTheFailureNamesBothForms() throws IOException {
        Path plan = write("plan.md", "**Goal:** ship the release\n", 1L);
        CheckResult r = DocumentChecks.sections("plan", plan, List.of("Goal", "Architecture", "Tasks"), List.of());
        assertEquals("fail", r.label());
        assertEquals("plan: missing section Architecture, missing section Tasks"
                + " (a section is a heading such as \"## Architecture\" or a line that starts with \"**Architecture:**\";"
                + " such a line's text runs up to the next bold field line or the next # or ## heading)",
                r.detail());
    }

    @Test
    void theFormsClauseFollowsTheSectionProblemsAndPrecedesTheForbiddenOnes() throws IOException {
        Path plan = write("plan.md", "**Goal:** TBD\n", 1L);
        CheckResult r = DocumentChecks.sections("plan", plan, List.of("Goal", "Tasks"), List.of("TBD"));
        assertTrue(r.detail().startsWith("plan: missing section Tasks (a section is a heading such as \"## Tasks\""), r.detail());
        assertTrue(r.detail().endsWith(" heading), forbidden TBD"), r.detail());
    }

    @Test
    void aBoldFieldInsideASentenceOrAListItemIsNoSection() throws IOException {
        Path prose = write("prose.md", "The **Goal:** is to ship the release.\n- **Architecture:** two layers\n", 1L);
        CheckResult r = DocumentChecks.sections("prose", prose, List.of("Goal", "Architecture"), List.of());
        assertEquals("fail", r.label());
        assertTrue(r.detail().startsWith("prose: missing section Goal, missing section Architecture ("), r.detail());
        Path lines = write("lines.md", "**Goal:** is to ship the release.\n**Architecture:** two layers\n", 1L);
        assertEquals("pass", DocumentChecks.sections("lines", lines, List.of("Goal", "Architecture"), List.of()).label(),
                "the same words at the start of their lines are sections");
    }

    @Test
    void aHeadingWithTheNameIsTheSectionAsBeforeAndABoldFieldOnlyStandsInWithoutOne() throws IOException {
        Path both = write("both.md", "**Goal:** ship the release\n## Goal\n", 1L);
        assertEquals("both: empty section Goal",
                DocumentChecks.sections("both", both, List.of("Goal"), List.of()).detail(),
                "the empty heading is the section, as before; a bold field of the same name does not replace it");
        Path tasks = write("tasks.md", "## Tasks\n**Files:**\n- src/Main.java\n", 1L);
        assertEquals("pass", DocumentChecks.sections("tasks", tasks, List.of("Tasks"), List.of()).label(),
                "a bold field line under a heading is text of that heading's section, as before");
    }

    /** A sections check over one document type with the given sections, written as JSON. */
    static Playbook sectionsPlaybook(String sections) {
        PlaybookReader.Read read = PlaybookReader.read("""
            { "schema_version": 1, "id": "s", "name": "S", "description": "d",
              "models": { "fast": { "primary": { "provider": "ollama", "model": "qwen3:8b" } } },
              "documents": { "plan": { "name": "Plan", "purpose": "p", "location": "plan.md", "sections": %s } },
              "checks": { "plan_ok": { "kind": "sections", "documents": ["plan"] } },
              "start": "write_plan",
              "nodes": [
                { "kind": "step", "id": "write_plan", "name": "Write plan", "performer": "chat", "model": "fast", "produces": ["plan"] },
                { "kind": "decision", "id": "plan_ok", "name": "Plan ok", "check": "plan_ok", "max_rounds": 2 },
                { "kind": "end", "id": "done", "result": "done" }
              ],
              "arrows": [
                { "from": "write_plan", "to": "plan_ok" },
                { "from": "plan_ok", "to": "done", "on": "pass" },
                { "from": "plan_ok", "to": "write_plan", "on": "fail" },
                { "from": "plan_ok", "to": "done", "on": "exhausted" }
              ] }
            """.formatted(sections));
        assertEquals(List.of(), read.findings());
        return read.playbook();
    }

    static Playbook.Decision decision(Playbook p, String id) {
        return p.nodes().stream().filter(n -> n instanceof Playbook.Decision && n.id().equals(id))
                .map(Playbook.Decision.class::cast).findFirst().orElseThrow();
    }

    @Test
    void theCheckTextNamesBothFormsWithTheFirstSectionAsTheExample() {
        Playbook p = sectionsPlaybook("[\"Goal\", \"Tasks\"]");
        assertEquals("Plan ok: Plan has the sections Goal, Tasks, each with text"
                + " (a section is a heading such as \"## Goal\" or a line that starts with \"**Goal:**\";"
                + " such a line's text runs up to the next bold field line or the next # or ## heading)",
                CheckText.describe(p, decision(p, "plan_ok")));
    }

    @Test
    void aSectionsCheckOverADocumentWithoutSectionsKeepsItsTextAndNamesNoExample() {
        Playbook p = sectionsPlaybook("[]");
        assertEquals("Plan ok: Plan has the sections , each with text", CheckText.describe(p, decision(p, "plan_ok")));
    }

    private static final Pattern QUOTED = Pattern.compile("\"([^\"]+)\"");

    private static List<String> quoted(String text) {
        List<String> out = new ArrayList<>();
        Matcher m = QUOTED.matcher(text);
        while (m.find()) {
            out.add(m.group(1));
        }
        return out;
    }

    /** What the two texts call a section, written down as a document, is a section the check counts. */
    @Test
    void theFormsBothTextsNameAreFormsTheCheckCounts() throws IOException {
        Playbook p = sectionsPlaybook("[\"Global Constraints\"]");
        String checkText = CheckText.describe(p, decision(p, "plan_ok"));
        Path none = write("none.md", "nothing here yet\n", 1L);
        String failure = DocumentChecks.sections("none", none, List.of("Global Constraints"), List.of()).detail();
        for (String text : List.of(checkText, failure)) {
            List<String> forms = quoted(text);
            assertEquals(List.of("## Global Constraints", "**Global Constraints:**"), forms, text);
            for (String form : forms) {
                Path doc = write("form.md", form + "\nJava 21 or newer\n", 1L);
                assertEquals("pass", DocumentChecks.sections("form", doc, List.of("Global Constraints"), List.of()).label(),
                        form + " is named as a section form but does not count");
                Path deep = write("deep.md", form + "\n### Versions\nJava 21 or newer\n## Next\n", 1L);
                assertEquals("pass", DocumentChecks.sections("deep", deep, List.of("Global Constraints"), List.of()).label(),
                        form + " with a level 3 sub-heading is named as a section form but does not count");
            }
        }
    }
}
