package dev.spectroscope.server.playbooks;

import dev.spectroscope.server.playbooks.InstallLedger.Install;
import dev.spectroscope.server.playbooks.InstallLedger.Item;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.Map;
import java.util.stream.Stream;

import static org.junit.jupiter.api.Assertions.assertArrayEquals;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

class InstallLedgerTest {

    @TempDir Path tmp;

    private Path ledgerFile() {
        return tmp.resolve(".spectro").resolve("playbook-installs.json");
    }

    private static Install install(String playbook, String hash) {
        Item skill = new Item("skill", "plan", "skills/plan", "aa11", "/home/u/.spectro/skills/" + playbook + "/plan",
                List.of("LICENSE", ".provenance.json"), null);
        Item hook = new Item("hook", "guard", "hooks/guard.json", "bb22", "/home/u/.spectro/playbook-hooks/" + playbook,
                List.of(), Map.of("event", "PreToolUse", "command", "/home/u/.spectro/playbook-hooks/" + playbook + "/guard.sh"));
        return new Install(playbook, "/work/" + playbook, hash, "2026-10-10", List.of(skill, hook));
    }

    @Test
    void itemHashAnswersTheRecordedHashByPlaybookKindAndSource() {
        InstallLedger ledger = new InstallLedger(ledgerFile());
        assertNull(ledger.itemHash("spectropowers", "agent", "agents/reviewer.md"), "a missing file holds nothing");
        Item agent = new Item("agent", "reviewer", "agents/reviewer.md", "cc33", null, List.of(), null);
        ledger.put(new Install("spectropowers", "/work/spectropowers", "h1", "2026-10-10", List.of(agent)));

        assertEquals("cc33", ledger.itemHash("spectropowers", "agent", "agents/reviewer.md"));
        assertNull(ledger.itemHash("other", "agent", "agents/reviewer.md"), "another playbook id");
        assertNull(ledger.itemHash("spectropowers", "skill", "agents/reviewer.md"), "another kind");
        assertNull(ledger.itemHash("spectropowers", "agent", "agents/planner.md"), "another source");
    }

    @Test
    void aMissingFileReadsAsEmpty() {
        InstallLedger ledger = new InstallLedger(ledgerFile());
        assertEquals(List.of(), ledger.all());
        assertTrue(ledger.find("spectropowers").isEmpty());
    }

    @Test
    void putIsReadBackThroughAFreshInstanceWithEveryField() {
        new InstallLedger(ledgerFile()).put(install("spectropowers", "h1"));
        InstallLedger fresh = new InstallLedger(ledgerFile());
        assertEquals(1, fresh.all().size());
        Install back = fresh.find("spectropowers").orElseThrow();
        assertEquals(install("spectropowers", "h1"), back);
        assertEquals("h1", back.contentsHash());
        assertEquals(List.of("LICENSE", ".provenance.json"), back.items().get(0).generated());
        assertNull(back.items().get(0).entry());
        assertEquals("PreToolUse", back.items().get(1).entry().get("event"));
    }

    @Test
    void putReplacesTheEntryOfTheSamePlaybookIdAndKeepsTheOthers() {
        InstallLedger ledger = new InstallLedger(ledgerFile());
        ledger.put(install("alpha", "h1"));
        ledger.put(install("beta", "h2"));
        ledger.put(install("alpha", "h3"));
        InstallLedger fresh = new InstallLedger(ledgerFile());
        assertEquals(2, fresh.all().size());
        assertEquals("h3", fresh.find("alpha").orElseThrow().contentsHash());
        assertEquals("h2", fresh.find("beta").orElseThrow().contentsHash());
    }

    @Test
    void dropRemovesOnlyThatPlaybookAndAnUnknownIdChangesNothing() {
        InstallLedger ledger = new InstallLedger(ledgerFile());
        ledger.put(install("alpha", "h1"));
        ledger.put(install("beta", "h2"));
        ledger.drop("alpha");
        ledger.drop("never-installed");
        InstallLedger fresh = new InstallLedger(ledgerFile());
        assertTrue(fresh.find("alpha").isEmpty());
        assertEquals("h2", fresh.find("beta").orElseThrow().contentsHash());
        assertEquals(1, fresh.all().size());
    }

    @Test
    void aWriteLeavesNoTempFileBesideTheLedger() throws IOException {
        new InstallLedger(ledgerFile()).put(install("alpha", "h1"));
        try (Stream<Path> siblings = Files.list(ledgerFile().getParent())) {
            assertEquals(List.of("playbook-installs.json"), siblings.map(p -> p.getFileName().toString()).toList());
        }
    }

    @Test
    void aMalformedFileThrowsOnEveryOperationAndKeepsItsBytes() throws IOException {
        Files.createDirectories(ledgerFile().getParent());
        byte[] garbage = "{ this is not json".getBytes(StandardCharsets.UTF_8);
        Files.write(ledgerFile(), garbage);
        InstallLedger ledger = new InstallLedger(ledgerFile());

        IllegalStateException onRead = assertThrows(IllegalStateException.class, ledger::all);
        assertTrue(onRead.getMessage().contains("playbook-installs.json"), onRead.getMessage());
        assertThrows(IllegalStateException.class, () -> ledger.find("alpha"));
        assertThrows(IllegalStateException.class, () -> ledger.put(install("alpha", "h1")));
        assertThrows(IllegalStateException.class, () -> ledger.drop("alpha"));

        assertArrayEquals(garbage, Files.readAllBytes(ledgerFile()));
    }

    @Test
    void aFileWithTheWrongShapeIsMalformedToo() throws IOException {
        Files.createDirectories(ledgerFile().getParent());
        byte[] wrong = "{\"installs\":\"not a list\"}".getBytes(StandardCharsets.UTF_8);
        Files.write(ledgerFile(), wrong);
        InstallLedger ledger = new InstallLedger(ledgerFile());
        assertThrows(IllegalStateException.class, ledger::all);
        assertThrows(IllegalStateException.class, () -> ledger.put(install("alpha", "h1")));
        assertArrayEquals(wrong, Files.readAllBytes(ledgerFile()));
    }

    @Test
    void inHomeResolvesUnderUserHome() throws IOException {
        String before = System.getProperty("user.home");
        System.setProperty("user.home", tmp.toString());
        try {
            InstallLedger.inHome().put(install("alpha", "h1"));
        } finally {
            System.setProperty("user.home", before);
        }
        assertTrue(Files.isRegularFile(tmp.resolve(".spectro").resolve("playbook-installs.json")));
    }
}
