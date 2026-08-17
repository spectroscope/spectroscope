package dev.spectroscope.core;

import dev.spectroscope.core.events.RunEvent.QuestionAsked;

import java.util.List;

/**
 * The question callback the frontend injects — {@link PermissionBroker}'s twin,
 * and deliberately not the same interface.
 *
 * <p>Blocking by design, for the same reason as the broker: the agent loop runs
 * on a virtual thread, so waiting for a human is a plain blocking call. The
 * asker lives in the core, the person in the frontend.</p>
 *
 * <p><b>Why this is not just a wider PermissionBroker.</b> {@code decide}
 * returns {@code boolean} — there is no text channel in it, and a question's
 * answer is text. The gate also carries machinery a question must not inherit:
 * an allowlist that can pre-answer, a "remember this decision" rule, and a
 * denial that is a legitimate outcome. A question has exactly one non-answer,
 * and it is not "no".</p>
 *
 * <p><b>Null is the whole contract for absence.</b> Where nobody can be asked —
 * a cancelled run, a socket that went away, a permission mode that declared
 * "do not bother me" — implementations return {@code null} rather than
 * something that looks like a reply. An invented answer in a session file
 * cannot be told from a real one afterwards.</p>
 */
@FunctionalInterface
public interface Asker {

    /**
     * Blocks until a person answers.
     *
     * @param question exactly what is being asked, as it also went on the wire
     * @return the answer, or {@code null} when nobody could be asked
     */
    Answer ask(QuestionAsked question);

    /**
     * What came back: one entry per question, in the order they were asked. A
     * multi-select answer is its chosen labels joined with {@code ", "}, which
     * is the wording the transcript renderer already reads.
     *
     * @param answers one answer per question asked
     */
    record Answer(List<String> answers) {
        /** Defensive copy — an answer is a record of what a person said. */
        public Answer {
            answers = List.copyOf(answers);
        }
    }

    /**
     * The asker for a face where nobody is attached: it never parks and never
     * answers. Registration is the real fence (a face with no person does not
     * carry the tool at all); this exists so a caller that builds the tool
     * anyway — the stateless context description, a test — cannot accidentally
     * hang or fabricate.
     *
     * @return an asker that always answers {@code null}
     */
    static Asker none() {
        return question -> null;
    }
}
