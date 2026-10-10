package dev.spectroscope.core.playbook.run;

import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.attribute.FileTime;
import java.util.List;
import java.util.Map;

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
}
