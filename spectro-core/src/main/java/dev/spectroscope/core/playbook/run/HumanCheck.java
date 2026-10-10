package dev.spectroscope.core.playbook.run;

import dev.spectroscope.core.Asker;
import dev.spectroscope.core.events.RunEvent;

import java.util.List;
import java.util.function.Consumer;

/** A human check: one question with the labels as options, through the session's asker. */
public final class HumanCheck {

    /**
     * @param label  the label the person picked, or null for no answer or one outside the labels
     * @param answer the raw answer, or null
     * @param waitMs how long the run stood parked
     */
    public record Asked(String label, String answer, long waitMs) {
    }

    private HumanCheck() {
    }

    /** @return what the person answered; blocks until then */
    public static Asked ask(String callId, String question, List<String> labels, Asker asker, Consumer<RunEvent> emit) {
        List<RunEvent.QuestionOption> options = labels.stream().map(l -> new RunEvent.QuestionOption(l, null)).toList();
        RunEvent.QuestionAsked asked = new RunEvent.QuestionAsked("main", callId,
                List.of(new RunEvent.AskedQuestion(question, "playbook", false, options)), System.currentTimeMillis());
        emit.accept(asked);
        long parkedAt = System.currentTimeMillis();
        Asker.Answer answer = asker == null ? null : asker.ask(asked);
        long wait = System.currentTimeMillis() - parkedAt;
        if (answer == null || answer.answers().isEmpty()) {
            emit.accept(new RunEvent.QuestionAnswered(callId, List.of(), true, wait, System.currentTimeMillis()));
            return new Asked(null, null, wait);
        }
        emit.accept(new RunEvent.QuestionAnswered(callId, answer.answers(), false, wait, System.currentTimeMillis()));
        String text = answer.answers().get(0).strip();
        String label = labels.stream().filter(l -> l.equalsIgnoreCase(text)).findFirst().orElse(null);
        return new Asked(label, text, wait);
    }
}
