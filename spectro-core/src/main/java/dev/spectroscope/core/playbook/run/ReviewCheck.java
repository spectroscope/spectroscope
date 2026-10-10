package dev.spectroscope.core.playbook.run;

import dev.spectroscope.core.CancelSignal;
import dev.spectroscope.core.events.RunEvent;
import dev.spectroscope.core.playbook.Playbook;
import dev.spectroscope.core.provider.LlmProvider;
import dev.spectroscope.core.subagents.AgentType;
import dev.spectroscope.core.subagents.SubagentManager;

import java.nio.file.Path;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.function.Consumer;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/** A review check: an explore child on the check's model reads the documents and answers one label. */
public final class ReviewCheck {

    private ReviewCheck() {
    }

    /** @return the task text the reviewing child runs on */
    public static String task(String question, List<String> labels, Map<String, Path> documents) {
        StringBuilder b = new StringBuilder("You review documents for a playbook step. Read them, then judge.\n");
        documents.forEach((id, path) -> b.append("- ").append(id).append(": ")
                .append(path == null ? "not written yet" : path.toString()).append('\n'));
        if (question != null && !question.isBlank()) {
            b.append("Question: ").append(question).append('\n');
        }
        b.append("Give your reasons. End with one line that holds exactly one of these words: ")
                .append(String.join(", ", labels)).append('.');
        return b.toString();
    }

    /**
     * The privacy a reviewer resolves its model under: the stricter privacy of
     * the steps that produce the documents it reads, so a private step's
     * documents never reach a cloud reviewer (owner decision 2026-10-09, item 1).
     *
     * @param playbook the playbook the check belongs to
     * @param reads    the document ids the reviewer reads
     * @return private when any step producing one of them is private, else cheap
     */
    public static String privacy(Playbook playbook, List<String> reads) {
        for (Playbook.Node node : playbook.nodes()) {
            if (node instanceof Playbook.Step s && "private".equals(s.privacy())
                    && s.produces().stream().anyMatch(reads::contains)) {
                return "private";
            }
        }
        return "cheap";
    }

    /**
     * @param text   the child's final text
     * @param labels the labels the check allows
     * @return the label on the last non blank line, else the label whose last whole word occurrence is latest, else null
     */
    public static String labelOf(String text, List<String> labels) {
        String[] lines = text.strip().split("\\R");
        for (int i = lines.length - 1; i >= 0; i--) {
            String line = lines[i].strip();
            if (line.isEmpty()) {
                continue;
            }
            String word = line.replaceAll("^[^A-Za-z0-9_]+|[^A-Za-z0-9_]+$", "").toLowerCase(Locale.ROOT);
            for (String label : labels) {
                if (label.toLowerCase(Locale.ROOT).equals(word)) {
                    return label;
                }
            }
            break;
        }
        String lower = text.toLowerCase(Locale.ROOT);
        String best = null;
        int bestAt = -1;
        for (String label : labels) {
            Matcher m = Pattern.compile("\\b" + Pattern.quote(label.toLowerCase(Locale.ROOT)) + "\\b").matcher(lower);
            while (m.find()) {
                if (m.start() > bestAt) {
                    bestAt = m.start();
                    best = label;
                }
            }
        }
        return best;
    }

    /** @return the label the child named, or a null label with the reason */
    public static CheckResult run(String task, List<String> labels, LlmProvider provider, SubagentManager manager,
                                  Consumer<RunEvent> out, CancelSignal signal, String stepLabel) {
        SubagentManager.StepResult r = manager.runStep(
                new SubagentManager.StepChild(AgentType.EXPLORE, task, task, stepLabel, provider), out, signal);
        if (r.failed()) {
            return new CheckResult(null, r.outcome());
        }
        String label = labelOf(r.answer(), labels);
        return new CheckResult(label, "[" + r.childId() + "] " + (label == null ? "named no label" : "answered " + label));
    }
}
