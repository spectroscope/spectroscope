package dev.spectroscope.core.commands;

import org.junit.jupiter.api.Test;

import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Set;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

/** Card 554: the one command list the REPL prints and the server serves. */
class CommandListTest {

    private static CommandList.Command byId(String id) {
        return CommandList.all().stream().filter(c -> c.id().equals(id)).findFirst()
                .orElseThrow(() -> new AssertionError("no row " + id));
    }

    @Test
    void theRowsTheCardNamesAreThere() {
        List<String> ids = CommandList.all().stream().map(CommandList.Command::id).toList();
        assertTrue(ids.containsAll(List.of("help", "compact", "clear", "loop", "run-with-playbook",
                "playbook-current", "playbook-list", "playbook-show", "playbook-use", "playbook-workflow",
                "codegraph", "codegraph-show", "skills", "think", "peer")), ids.toString());
        assertEquals(List.of("commands"), byId("help").aliases());
        assertEquals(List.of("playbook run"), byId("run-with-playbook").aliases());
        assertEquals(List.of("run-workflow"), byId("playbook-workflow").aliases());
        assertEquals(List.of("graphify"), byId("codegraph").aliases());
    }

    @Test
    void idsAreUniqueAndEverySpellingNamesOneRow() {
        Set<String> ids = new HashSet<>();
        Set<String> spellings = new HashSet<>();
        List<String> twice = new ArrayList<>();
        for (CommandList.Command c : CommandList.all()) {
            if (!ids.add(c.id())) {
                twice.add("id " + c.id());
            }
            List<String> all = new ArrayList<>(c.aliases());
            all.add(c.spelling());
            for (String s : all) {
                if (!spellings.add(s)) {
                    twice.add("spelling " + s);
                }
            }
        }
        assertFalse(ids.isEmpty(), "the list is not empty");
        assertEquals(List.of(), twice);
    }

    @Test
    void everyRowHasAGroupASurfaceAndAHelpLine() {
        List<String> broken = new ArrayList<>();
        for (CommandList.Command c : CommandList.all()) {
            if (!CommandList.GROUPS.contains(c.group())) {
                broken.add(c.id() + ": group " + c.group());
            }
            if (!CommandList.SURFACES.contains(c.surfaces())) {
                broken.add(c.id() + ": surfaces " + c.surfaces());
            }
            if (c.help() == null || c.help().en() == null || c.help().en().isBlank()) {
                broken.add(c.id() + ": no help");
            } else if (c.help().en().matches(".*[\\u2013\\u2014].*")) {
                broken.add(c.id() + ": a dash in the help");
            }
            if (c.name() == null || !c.name().matches("[a-z][a-z-]*")) {
                broken.add(c.id() + ": name " + c.name());
            }
            if (c.developerOnly() && c.onRepl()) {
                broken.add(c.id() + ": the terminal has no modes, a developer row is web only");
            }
        }
        assertFalse(CommandList.all().isEmpty(), "the list is not empty");
        assertEquals(List.of(), broken);
    }

    @Test
    void thePlaybookRowsAreWebAndDeveloperOnlyAndTheCodeGraphRowsAreNotWiredYet() {
        for (String id : List.of("run-with-playbook", "playbook-current", "playbook-list", "playbook-show",
                "playbook-use", "playbook-workflow")) {
            CommandList.Command c = byId(id);
            assertEquals("web", c.surfaces(), id);
            assertTrue(c.developerOnly(), id);
            assertEquals("playbook", c.group(), id);
            assertTrue(c.wired(), id);
        }
        assertTrue(byId("run-with-playbook").takesArgs());
        assertTrue(byId("playbook-use").takesArgs());
        assertTrue(byId("playbook-workflow").takesArgs());
        assertFalse(byId("playbook-current").takesArgs(), "/playbook runs on Enter");
        assertFalse(byId("playbook-list").takesArgs());
        assertFalse(byId("playbook-show").takesArgs(), "/playbook show runs on Enter; a name is optional");
        assertFalse(byId("codegraph").wired());
        assertFalse(byId("codegraph-show").wired());
        assertTrue(byId("compact").wired(), "absent reads as wired");
        assertEquals("both", byId("clear").surfaces());
        assertTrue(byId("loop").help().en().contains("/loop stop ends it"),
                "the terminal's /help named how a loop ends, and the list keeps it: " + byId("loop").help().en());
        assertEquals("repl", byId("peer").surfaces());
    }

    @Test
    void aLineIsReadAsItsLongestSpellingAndTheRest() {
        CommandList.Match run = CommandList.match("/playbook run add a CSV export").orElseThrow();
        assertEquals("run-with-playbook", run.command().id());
        assertEquals("add a CSV export", run.rest());
        assertEquals("run-with-playbook", CommandList.match("/run-with-playbook add a CSV export")
                .orElseThrow().command().id());
        assertEquals("", CommandList.match("/run-with-playbook").orElseThrow().rest());
        assertEquals("playbook-current", CommandList.match("/playbook").orElseThrow().command().id());
        assertEquals("playbook-list", CommandList.match("  /playbook list ").orElseThrow().command().id());
        CommandList.Match workflow = CommandList.match("/run-workflow fanout-review the auth module").orElseThrow();
        assertEquals("playbook-workflow", workflow.command().id());
        assertEquals("fanout-review the auth module", workflow.rest());
        assertEquals("help", CommandList.match("/commands").orElseThrow().command().id());
        assertTrue(CommandList.match("/playbooks").isEmpty(), "a longer word is not the command");
        assertTrue(CommandList.match("playbook").isEmpty(), "no slash, no command");
        assertTrue(CommandList.match("/nope").isEmpty());
    }

    /**
     * Card 558, owner answer of 2026-10-13: the words a session item may not
     * take as its plain name are the first words of the commands the web chat
     * runs, derived from the list. A command only the terminal runs reserves
     * nothing.
     */
    @Test
    void theWebFirstWordsAreEveryNameAndAliasOfARowTheWebRuns() {
        Set<String> words = CommandList.webFirstWords();
        Set<String> web = new HashSet<>();
        for (CommandList.Command c : CommandList.all()) {
            if (c.onWeb()) {
                web.add(c.name());
                for (String alias : c.aliases()) {
                    web.add(alias.split(" ")[0]);
                }
            }
        }
        assertEquals(web, words);
        List<String> terminalOnly = CommandList.all().stream().filter(c -> !c.onWeb())
                .map(CommandList.Command::name).filter(n -> !web.contains(n)).toList();
        assertFalse(terminalOnly.isEmpty(), "the list has terminal-only commands, so the next check bites");
        for (String name : terminalOnly) {
            assertFalse(words.contains(name), "a terminal-only command reserves its word: " + name);
        }
        assertTrue(words.containsAll(Set.of("clear", "compact", "loop", "help", "commands", "playbook",
                "run-with-playbook", "run-workflow", "skills")), words.toString());
        for (String word : List.of("model", "goal", "cost", "think", "peer", "exit", "voice", "speak", "sessions",
                "mcp")) {
            assertFalse(words.contains(word), word + " is a terminal-only command: " + words);
        }
        assertFalse(words.contains("run"), "a second word is not a first word");
    }
}
