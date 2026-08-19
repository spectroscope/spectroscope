package dev.spectroscope.core.goal;

/**
 * What a run is for, and the command that decides whether it got there
 * (card 267).
 *
 * <p>Two fields and nothing else. The outcome is the operator's own sentence;
 * the check is a shell command whose <b>exit code is the verdict</b>. A goal
 * without a machine-checkable test is a wish, and this record is the smallest
 * shape that carries both halves.</p>
 *
 * <p><b>Why the operator states it and never the model.</b>
 * {@code konzept/PROMPT-ORCHESTRATION.md} §3 rule 2 already refuses a
 * model-written definition that out-grants its author's session, and a
 * model-written goal is exactly that: a run defining its own success. So there
 * is no {@code state_goal} tool anywhere in this package, and there never
 * should be.</p>
 *
 * <p><b>Why the prose is allowed here at all.</b>
 * {@code konzept/ORCHESTRATION.md} §A1 refuses prompt text as a mechanism —
 * "the failure mode is silent. A prompt that does not work looks exactly like a
 * model that cannot comply, and nothing in the record separates them". That
 * refusal is about prose being asked to CAUSE a behaviour. Here the prose is
 * DATA: it tells the model what it is for, and what actually decides the run is
 * {@link CommandGoalCheck}'s exit code. The two are separable in the record by
 * construction, because the verdict names the command that produced it.</p>
 *
 * <p>The record grants nothing. It is text plus a command; it adds no tool, no
 * role and no permission, and the command itself passes the same gate as any
 * other command before it runs (card 267, criterion 5).</p>
 *
 * @param outcome the stated outcome, in the operator's own words; never null or
 *                blank in a stated goal
 * @param check   the command whose exit code decides it, or null/blank for a
 *                goal that carries no teeth — accepted, and reported
 *                {@link GoalVerdict.Outcome#UNTESTED}, never met
 */
public record RunGoal(String outcome, String check) {

    /** The heading the goal travels under in the system prompt. Verbatim in the
     *  {@code loadAgentsMd} shape: a level-2 heading, a blank line, the content
     *  the operator wrote, untouched. */
    public static final String PROMPT_HEADING = "\n\n## The goal of this run\n\n";

    /** Whether this goal carries teeth — a check that could be run at all.
     *  @return true when a non-blank command was stated */
    public boolean hasCheck() {
        return check != null && !check.isBlank();
    }

    /** Whether anything was stated at all.
     *  @return true when the outcome is non-blank */
    public boolean stated() {
        return outcome != null && !outcome.isBlank();
    }

    /**
     * The block appended to the system prompt on <b>every</b> turn.
     *
     * <p>The operator's outcome travels byte for byte — no summary, no
     * rewording, no truncation. Card 267 criterion 2 is a byte comparison on a
     * run driven past the compaction threshold, and a section that "helpfully"
     * normalised its input would pass a contains-check while failing the
     * property.</p>
     *
     * <p>It states two facts and gives one instruction, and the instruction is
     * about honesty rather than about finishing: a run is ended by the check,
     * not by the model agreeing to keep going, so an instruction to "not stop"
     * would be exactly the prompt tax §A1 refuses.</p>
     *
     * <p><b>What it costs, measured rather than felt</b> (the card's
     * non-functional criterion 2). On the house backend — LM Studio on the
     * tailnet node, {@code deepseek-v4-flash-0731@iq1_m} — this section is
     * <b>77 prompt tokens per turn</b> for a 326-character goal, measured
     * 2026-08-19 by posting the same system prompt with and without it and
     * reading {@code usage.prompt_tokens}:</p>
     *
     * <pre>
     * curl -s $LMS/v1/chat/completions -H 'Content-Type: application/json' \
     *   -d '{"model":"&lt;model&gt;","max_tokens":1,"messages":[
     *        {"role":"system","content":"&lt;base&gt;"},{"role":"user","content":"hi"}]}' \
     *   | jq .usage.prompt_tokens        # 26 bare, 103 with the section
     * </pre>
     *
     * <p>Per turn and not per run, which is the whole trade: a fifteen-turn run
     * pays it fifteen times, and that is the price of surviving compaction.</p>
     *
     * @return the ready-to-append section, or "" when nothing was stated
     */
    public String promptSection() {
        if (!stated()) {
            return "";
        }
        StringBuilder out = new StringBuilder(PROMPT_HEADING).append(outcome.strip());
        if (hasCheck()) {
            out.append("\n\nThis run is finished when the following command exits 0, and the"
                    + " harness — not you — runs it and reads the exit code:\n\n    ")
                    .append(check.strip())
                    .append("\n\nDo not report the goal as met. Say what you did and what you"
                            + " observed; the check decides.");
        } else {
            out.append("\n\nNo check was stated for this goal, so nothing can confirm it. The"
                    + " run will be recorded as untested.");
        }
        return out.toString();
    }
}
