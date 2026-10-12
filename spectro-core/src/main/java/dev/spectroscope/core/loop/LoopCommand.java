package dev.spectroscope.core.loop;

import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Card 504, criterion 6: {@code /loop [interval] <prompt>}, as the REPL reads
 * it. The web chat reads the same rule in {@code chatCommands.ts}.
 *
 * <p>A leading token of digits and one of {@code s}, {@code m}, {@code h} or
 * {@code d} is the interval; everything after it is the prompt. Without such
 * a token the whole rest is the prompt and the loop is self paced. The range
 * of 60 to 3600 seconds is the loop's, not the parser's.</p>
 *
 * @param intervalSeconds the leading interval in seconds, or null for a self paced loop
 * @param prompt          the task, never blank
 */
public record LoopCommand(Integer intervalSeconds, String prompt) {

    /** What the command says when it has no prompt. */
    public static final String USAGE = "Usage: /loop [interval] <prompt>, for example /loop 5m check the build"
            + " or /loop watch the build";

    private static final Pattern COMMAND = Pattern.compile("^/loop(?:\\s+(.*))?$", Pattern.DOTALL);
    private static final Pattern INTERVAL = Pattern.compile("^(\\d{1,7})([smhd])(?:\\s+(.*))?$", Pattern.DOTALL);

    /**
     * @param text a draft, untrimmed
     * @return the command, or null when the draft is no {@code /loop} or has no prompt
     */
    public static LoopCommand parse(String text) {
        if (text == null) {
            return null;
        }
        Matcher command = COMMAND.matcher(text.strip());
        if (!command.matches()) {
            return null;
        }
        String rest = command.group(1) == null ? "" : command.group(1).strip();
        Matcher interval = INTERVAL.matcher(rest);
        if (interval.matches()) {
            String prompt = interval.group(3) == null ? "" : interval.group(3).strip();
            if (prompt.isEmpty()) {
                return null;
            }
            long amount = Long.parseLong(interval.group(1));
            long seconds = switch (interval.group(2)) {
                case "m" -> amount * 60;
                case "h" -> amount * 3_600;
                case "d" -> amount * 86_400;
                default -> amount;
            };
            return new LoopCommand((int) Math.min(Integer.MAX_VALUE, seconds), prompt);
        }
        return rest.isEmpty() ? null : new LoopCommand(null, rest);
    }

    /**
     * @param text a draft, untrimmed
     * @return true when the draft opens with the command, prompt or not
     */
    public static boolean isLoop(String text) {
        return text != null && COMMAND.matcher(text.strip()).matches();
    }
}
