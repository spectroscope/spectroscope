package dev.spectroscope.cli;

import dev.spectroscope.core.Asker;
import dev.spectroscope.core.events.RunEvent.AskedQuestion;
import dev.spectroscope.core.events.RunEvent.QuestionAsked;
import dev.spectroscope.core.events.RunEvent.QuestionOption;

import java.io.BufferedReader;
import java.util.ArrayList;
import java.util.List;

/**
 * The interactive terminal's asker (card 265): reads one line off the REPL's own
 * stdin and turns it into the answer.
 *
 * <p>It never prints, and that split is the gate's, verbatim:
 * {@link EventRenderer} draws the question when the {@code question_asked} event
 * reaches it — the same place it draws {@code run X? [y/N]} — and this only
 * reads. One writer, so the terminal can never show a different question from
 * the one that was asked.</p>
 *
 * <p><b>Absence is spelled null, three ways.</b> End of input (a closed pipe, a
 * {@code spectro} driven from a here-doc), an empty line (the person pressed
 * enter to skip), and a read that threw all come back as "nobody answered". In
 * the permission broker each of those is a DENIAL, which is a legitimate verdict
 * a gate can report; a question has no such verdict, and answering with
 * {@code ""} would put a person's silence on the record as their words.</p>
 */
final class ConsoleAsker implements Asker {

    /** The shared stdin reader — the same one the REPL and the gate read. */
    private final BufferedReader console;

    /**
     * @param console the REPL's stdin reader; nothing here ever closes it
     */
    ConsoleAsker(BufferedReader console) {
        this.console = console;
    }

    @Override
    public Answer ask(QuestionAsked question) {
        AskedQuestion asked = question.questions().isEmpty() ? null : question.questions().get(0);
        if (asked == null) {
            return null;
        }
        String typed;
        try {
            typed = console.readLine();
        } catch (Exception unreadable) {
            return null;
        }
        if (typed == null || typed.isBlank()) {
            return null;
        }
        return new Answer(List.of(resolve(typed.strip(), asked)));
    }

    /**
     * What the person meant: option numbers where they typed them, their own
     * words otherwise.
     *
     * <p>A number that names no offered option stays text. "9" against two
     * options is not option nine — there is no option nine — and recording it as
     * a choice would put an answer on the record that was never on offer.</p>
     *
     * @param typed what they typed, stripped and non-empty
     * @param asked the question, for its options and whether several may be picked
     * @return the answer, worded as the transcript renderer reads it back
     */
    private static String resolve(String typed, AskedQuestion asked) {
        List<QuestionOption> options = asked.options();
        List<String> picked = new ArrayList<>();
        for (String part : typed.split(",")) {
            int index = indexOf(part.strip(), options.size());
            if (index < 0) {
                return typed; // not a list of offered numbers: their own words
            }
            picked.add(options.get(index).label());
        }
        if (picked.size() > 1 && !asked.multiSelect()) {
            return typed; // it was not offering a pair, so this is not a choice
        }
        // Joined with ", ", which is the wording the answer reader already parses
        // back into the chosen labels.
        return String.join(", ", picked);
    }

    /**
     * The zero-based option a typed token names.
     *
     * @param token  one comma-separated token, stripped
     * @param offered how many options the question carried
     * @return the option's index, or -1 when the token is not one of its numbers
     */
    private static int indexOf(String token, int offered) {
        if (token.isEmpty() || !token.chars().allMatch(Character::isDigit)) {
            return -1;
        }
        try {
            int number = Integer.parseInt(token);
            return number >= 1 && number <= offered ? number - 1 : -1;
        } catch (NumberFormatException notANumber) {
            return -1;
        }
    }
}
