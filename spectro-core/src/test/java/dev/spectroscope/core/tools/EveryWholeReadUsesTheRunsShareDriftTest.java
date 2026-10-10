package dev.spectroscope.core.tools;

import org.junit.jupiter.api.Test;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import java.util.stream.Stream;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * Review of card 493: a read path that judges a whole read against the
 * shipped share while the run reads with another one. {@code read_skill_file}
 * did that after {@code read_file} moved to the run's share. This walks the
 * main sources of every module and demands that each call of
 * {@link ReadBudget#refusal} passes a share, and that each source whose text
 * tells the model a share of its window also describes itself per run.
 */
class EveryWholeReadUsesTheRunsShareDriftTest {

    private static final Pattern CALL = Pattern.compile("ReadBudget\\.refusal\\(");

    /** The main Java sources of every module of the repository. */
    private static List<Path> mainSources() throws IOException {
        List<Path> out = new ArrayList<>();
        try (Stream<Path> modules = Files.list(Path.of("..").toAbsolutePath().normalize())) {
            for (Path module : modules.filter(Files::isDirectory).toList()) {
                Path main = module.resolve("src/main/java");
                if (!Files.isDirectory(main)) {
                    continue;
                }
                try (Stream<Path> files = Files.walk(main)) {
                    files.filter(file -> file.toString().endsWith(".java")).forEach(out::add);
                }
            }
        }
        return out;
    }

    /** The arguments of the call that opens at {@code open}, counted at the top level. */
    static int arguments(String source, int open) {
        int depth = 0;
        int commas = 0;
        boolean quoted = false;
        for (int i = open; i < source.length(); i++) {
            char c = source.charAt(i);
            if (quoted) {
                if (c == '\\') {
                    i++;
                } else if (c == '"') {
                    quoted = false;
                }
                continue;
            }
            if (c == '"') {
                quoted = true;
            } else if (c == '(') {
                depth++;
            } else if (c == ')') {
                depth--;
                if (depth == 0) {
                    return commas + 1;
                }
            } else if (c == ',' && depth == 1) {
                commas++;
            }
        }
        throw new AssertionError("an unclosed call at " + open);
    }

    @Test
    void theArgumentCounterReadsNestedCallsAndStrings() {
        String source = "ReadBudget.refusal(\"a, b\", size(x, y), window)";
        assertEquals(3, arguments(source, source.indexOf('(')));
        String four = "ReadBudget.refusal(\"file\", size, window, share(\")\"))";
        assertEquals(4, arguments(four, four.indexOf('(')));
    }

    @Test
    void everyWholeReadCheckPassesTheRunsShare() throws IOException {
        int calls = 0;
        List<String> shipped = new ArrayList<>();
        for (Path file : mainSources()) {
            if (file.endsWith("ReadBudget.java")) {
                continue;
            }
            String source = Files.readString(file);
            Matcher call = CALL.matcher(source);
            while (call.find()) {
                calls++;
                if (arguments(source, call.end() - 1) != 4) {
                    shipped.add(file.getFileName() + " at offset " + call.start());
                }
            }
        }
        assertTrue(calls >= 2, "premise: read_file and read_skill_file both check a whole read, found " + calls);
        assertTrue(shipped.isEmpty(), "a whole read judged at the shipped share: " + shipped);
    }

    @Test
    void everyToolThatNamesAShareOfTheWindowDescribesItselfPerRun() throws IOException {
        List<String> found = new ArrayList<>();
        List<String> missing = new ArrayList<>();
        for (Path file : mainSources()) {
            String source = Files.readString(file);
            if (source.contains("% of your context")) {
                found.add(file.getFileName().toString());
                if (!source.contains("descriptionForRun(RunFacts") && !source.contains("descriptionForRun(Tool.RunFacts")) {
                    missing.add(file.getFileName().toString());
                }
            }
        }
        assertTrue(found.contains("StandardTools.java") && found.contains("SkillLibrary.java"),
                "premise: both read tools name a share of the window: " + found);
        assertTrue(missing.isEmpty(), "a tool tells the model the shipped share in every run: " + missing);
    }
}
