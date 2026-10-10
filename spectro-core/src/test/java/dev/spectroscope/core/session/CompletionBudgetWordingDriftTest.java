package dev.spectroscope.core.session;

import org.junit.jupiter.api.Test;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * Card 488: every text that describes the window clamp of {@code maxTokens}
 * says what {@link CompactionThreshold#completionBudget(CompactionThreshold.Derived, int, int)}
 * does, and no more.
 *
 * <p>The budget is {@code max(512, window - inputEstimate - 256)}. The input
 * is an estimate that can be low on a first request, and the floor of
 * {@value CompactionThreshold#MIN_COMPLETION_TOKENS} can take a request past
 * the window by construction. So no text may promise that a request
 * "never" asks for more than the window has left ("nie" next to "Fenster" in
 * German). Each text names the floor instead, and every text but the
 * release notes names the estimated input.</p>
 *
 * <p>The texts: the settings note {@code set.maxTokensNote} in both
 * languages, the {@code maxTokens} row of the reference chapter, the
 * paragraph of the v0.15.0 release notes and the {@code maxTokens} parameter
 * of {@code AgentOptions}.</p>
 */
class CompletionBudgetWordingDriftTest {

    private static final String DICT = "spectro-web/src/i18n/i18n.ts";
    private static final String GUIDE = "docs/guide-assets/parts/18-ref-config-build.html";
    private static final String NOTES = "release-notes/v0.15.0-local-copilot.md";
    private static final String OPTIONS =
            "spectro-core/src/main/java/dev/spectroscope/core/AgentOptions.java";

    @Test
    void noTextPromisesThatARequestNeverExceedsTheWindow() throws IOException {
        List<String> offenders = new ArrayList<>();
        for (Map.Entry<String, String> text : english().entrySet()) {
            for (String sentence : sentences(text.getValue())) {
                String lower = sentence.toLowerCase(Locale.ROOT);
                if (Pattern.compile("\\bnever\\b").matcher(lower).find() && lower.contains("window")) {
                    offenders.add(text.getKey() + ": " + sentence);
                }
            }
        }
        for (String sentence : sentences(german())) {
            if (Pattern.compile("\\bnie\\b").matcher(sentence).find() && sentence.contains("Fenster")) {
                offenders.add("set.maxTokensNote (de): " + sentence);
            }
        }
        assertTrue(offenders.isEmpty(),
                "These sentences promise more than completionBudget does. The input is an"
                        + " estimate and the floor is " + CompactionThreshold.MIN_COMPLETION_TOKENS
                        + " tokens; say that instead:\n" + String.join("\n", offenders));
    }

    @Test
    void everyTextNamesTheEstimatedInputAndTheFloor() throws IOException {
        String floor = Integer.toString(CompactionThreshold.MIN_COMPLETION_TOKENS);
        List<String> missing = new ArrayList<>();
        for (Map.Entry<String, String> text : english().entrySet()) {
            String lower = text.getValue().toLowerCase(Locale.ROOT);
            // The release notes keep the plain wording for a public reader:
            // the floor, not the estimate.
            if (!text.getKey().startsWith(NOTES) && !lower.contains("estimated input")) {
                missing.add(text.getKey() + " does not say the input is estimated");
            }
            if (!text.getValue().contains(floor)) {
                missing.add(text.getKey() + " does not name the floor of " + floor);
            }
        }
        String de = german();
        if (!de.contains("geschätzten Eingabe")) {
            missing.add("set.maxTokensNote (de) does not say the input is estimated");
        }
        if (!de.contains(floor)) {
            missing.add("set.maxTokensNote (de) does not name the floor of " + floor);
        }
        assertTrue(missing.isEmpty(), String.join("\n", missing));
    }

    private static Map<String, String> english() throws IOException {
        Map<String, String> texts = new LinkedHashMap<>();
        texts.put("set.maxTokensNote (en)", dictEntry("en"));
        texts.put(GUIDE + " maxTokens row", guideRow());
        texts.put(NOTES + " window paragraph", notesParagraph());
        texts.put(OPTIONS + " @param maxTokens", optionsParam());
        return texts;
    }

    private static String german() throws IOException {
        return dictEntry("de");
    }

    private static String dictEntry(String language) throws IOException {
        String dict = read(DICT);
        int key = dict.indexOf("\"set.maxTokensNote\": {");
        assertTrue(key >= 0, "premise: " + DICT + " has set.maxTokensNote");
        Matcher m = Pattern.compile("\\n\\s*" + language + ": \"((?:[^\"\\\\]|\\\\.)*)\"")
                .matcher(dict);
        assertTrue(m.find(key), "premise: set.maxTokensNote has a " + language + " entry");
        return m.group(1);
    }

    private static String guideRow() throws IOException {
        for (String line : read(GUIDE).split("\n")) {
            if (line.contains("<td><code>maxTokens</code></td>")) {
                return line.replaceAll("<[^>]+>", "").replace("&thinsp;", "")
                        .replace("&rsquo;", "'").replace("&nbsp;", " ");
            }
        }
        throw new AssertionError("premise: " + GUIDE + " has a maxTokens row");
    }

    private static String notesParagraph() throws IOException {
        String notes = read(NOTES);
        int start = notes.indexOf("**Two limits follow the window.**");
        assertTrue(start >= 0, "premise: " + NOTES + " has the window paragraph");
        int end = notes.indexOf("\n\n", start);
        return notes.substring(start, end < 0 ? notes.length() : end).replace('\n', ' ');
    }

    private static String optionsParam() throws IOException {
        String source = read(OPTIONS);
        int start = source.indexOf("@param maxTokens");
        assertTrue(start >= 0, "premise: " + OPTIONS + " documents maxTokens");
        int end = source.indexOf("@param", start + 1);
        return source.substring(start, end).replaceAll("\\s*\\*\\s*", " ");
    }

    private static List<String> sentences(String text) {
        return List.of(text.split("(?<=[.!?])\\s+"));
    }

    private static String read(String relative) throws IOException {
        return Files.readString(repoRoot().resolve(relative), StandardCharsets.UTF_8);
    }

    private static Path repoRoot() {
        Path dir = Path.of(System.getProperty("user.dir")).toAbsolutePath();
        while (dir != null && !Files.isRegularFile(dir.resolve("settings.gradle.kts"))) {
            dir = dir.getParent();
        }
        if (dir == null) {
            throw new IllegalStateException("no settings.gradle.kts above "
                    + System.getProperty("user.dir"));
        }
        return dir;
    }
}
