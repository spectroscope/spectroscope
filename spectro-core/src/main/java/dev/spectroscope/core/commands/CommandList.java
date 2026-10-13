package dev.spectroscope.core.commands;

import com.fasterxml.jackson.annotation.JsonIgnoreProperties;
import com.fasterxml.jackson.core.type.TypeReference;
import com.fasterxml.jackson.databind.ObjectMapper;

import java.io.IOException;
import java.io.InputStream;
import java.io.UncheckedIOException;
import java.util.ArrayList;
import java.util.List;
import java.util.Optional;

/**
 * The one list of chat commands, for the terminal REPL and the web chat
 * (card 554). The REPL's {@code /help} prints it, the server serves it on
 * {@code GET /api/commands}, and the web builds its {@code /help}, its slash
 * picker and its Skills and Commands page from what that route returns.
 *
 * <p>A row says how a command is typed ({@code name}, an optional
 * {@code sub}, {@code aliases}), where it works ({@code surfaces}), how the
 * picker treats it ({@code takesArgs}: written into the draft instead of
 * run), where it is listed ({@code group}, {@code developerOnly}), its
 * one-line help and, for a command that takes words, its template
 * ({@code usage}), both in English and German (card 588). A row whose
 * {@code wired} is false reserves its name for another card: no face
 * dispatches it yet, and none lists it.</p>
 */
public final class CommandList {

    /** Where the list sits on the classpath. */
    public static final String RESOURCE = "/commands/commands.json";
    /** The groups a row may name, in the order the lists show them. */
    public static final List<String> GROUPS = List.of("chat", "playbook", "codegraph", "skills");
    /** The surfaces a row may name. */
    public static final List<String> SURFACES = List.of("web", "repl", "both");

    /**
     * One command.
     *
     * @param id            a stable key, unique in the list
     * @param name          the first word after the slash
     * @param aliases       other whole spellings without the slash, each one or two words
     * @param sub           the second word, or null for a command of one word
     * @param takesArgs     true when the command needs words after it; the picker writes it into the draft
     * @param group         one of {@link #GROUPS}
     * @param surfaces      one of {@link #SURFACES}
     * @param developerOnly true when the web picker offers it in developer mode only; typing works everywhere
     * @param wired         false for a row another card will build; no face dispatches or lists it
     * @param help          the one-line help
     * @param usage         card 588: how the command is written, such as {@code /graph ask <question>},
     *                      or null for a command that takes no words
     */
    @JsonIgnoreProperties(ignoreUnknown = true)
    public record Command(String id, String name, List<String> aliases, String sub, boolean takesArgs,
                          String group, String surfaces, boolean developerOnly, Boolean wired, Text help,
                          Text usage) {

        /** @param aliases null reads as none; @param wired null reads as true */
        public Command {
            aliases = aliases == null ? List.of() : List.copyOf(aliases);
            wired = wired == null || wired;
        }

        /** @return how the command is typed, without the slash: the name, then the sub when there is one */
        public String spelling() {
            return sub == null ? name : name + " " + sub;
        }

        /** @return true when the terminal REPL runs it */
        public boolean onRepl() {
            return "repl".equals(surfaces) || "both".equals(surfaces);
        }

        /** @return true when the web chat runs it */
        public boolean onWeb() {
            return "web".equals(surfaces) || "both".equals(surfaces);
        }
    }

    /**
     * A text in both languages: a row's help or its template (card 588).
     *
     * @param en the English text
     * @param de the German text
     */
    @JsonIgnoreProperties(ignoreUnknown = true)
    public record Text(String en, String de) {
    }

    /**
     * A typed line read against the list.
     *
     * @param command the row it names
     * @param rest    the words after the command's spelling, trimmed; empty when none
     */
    public record Match(Command command, String rest) {
    }

    private static final List<Command> ALL = load();

    private CommandList() {
    }

    /** @return every row, in the order of the resource */
    public static List<Command> all() {
        return ALL;
    }

    /**
     * Card 558: the first word of every name and alias of the rows the web chat
     * runs ({@link Command#onWeb()}), unwired rows included because they hold
     * their name. A session item with one of these as its plain name is always
     * namespaced, so it never shadows a web chat command. A command only the
     * terminal runs reserves nothing (owner, 2026-10-13).
     *
     * @return the words, without the slash
     */
    public static java.util.Set<String> webFirstWords() {
        java.util.Set<String> out = new java.util.TreeSet<>();
        for (Command c : ALL) {
            if (!c.onWeb()) {
                continue;
            }
            out.add(c.name());
            for (String alias : c.aliases()) {
                out.add(alias.strip().split("\\s+")[0]);
            }
        }
        return java.util.Collections.unmodifiableSet(out);
    }

    /**
     * Reads a typed line as a command: the longest spelling or alias the line
     * starts with, followed by the end of the line or a space. {@code /playbook
     * run add a CSV export} names {@code run-with-playbook} with the rest
     * {@code add a CSV export}; {@code /playbook} alone names the current
     * playbook row.
     *
     * @param line the whole input, with its leading slash
     * @return the row and the rest, or empty when the line names no row
     */
    public static Optional<Match> match(String line) {
        if (line == null) {
            return Optional.empty();
        }
        String text = line.strip();
        if (!text.startsWith("/")) {
            return Optional.empty();
        }
        text = text.substring(1);
        Match best = null;
        int bestLength = -1;
        for (Command c : ALL) {
            List<String> spellings = new ArrayList<>();
            spellings.add(c.spelling());
            spellings.addAll(c.aliases());
            for (String s : spellings) {
                boolean hit = text.equals(s) || text.startsWith(s + " ") || text.startsWith(s + "\n");
                if (hit && s.length() > bestLength) {
                    best = new Match(c, text.substring(s.length()).strip());
                    bestLength = s.length();
                }
            }
        }
        return Optional.ofNullable(best);
    }

    private static List<Command> load() {
        try (InputStream in = CommandList.class.getResourceAsStream(RESOURCE)) {
            if (in == null) {
                throw new IllegalStateException(RESOURCE + " is missing from the jar");
            }
            return List.copyOf(new ObjectMapper().readValue(in, new TypeReference<List<Command>>() { }));
        } catch (IOException e) {
            throw new UncheckedIOException("cannot read " + RESOURCE, e);
        }
    }
}
