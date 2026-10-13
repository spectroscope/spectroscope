package dev.spectroscope.core.codegraph;

import dev.spectroscope.core.tools.CodeGraphTool;

/**
 * Card 587, criterion 3: the words of {@code /graph ask <question>}. The record
 * keeps the command as typed; the model reads the question and one line that
 * asks it to answer through the graph tool. A folder the tool would not be
 * offered in is refused with the reason and the way on.
 */
public final class CodeGraphAsk {

    /** The line the model reads under the question. */
    public static final String LINE = "Answer this through the `" + CodeGraphTool.NAME + "` tool: ask the code graph "
            + "about the structure first, and read files only to confirm what it says.";

    /** The answer to {@code /graph ask} without a question. */
    public static final String USAGE = "/graph ask needs a question: /graph ask <question>";

    private CodeGraphAsk() {
    }

    /**
     * @param question the words after {@code /graph ask}
     * @return what the model reads
     */
    public static String modelText(String question) {
        return question.strip() + "\n\n" + LINE;
    }

    /**
     * @param question the words after {@code /graph ask}
     * @return what the record and the chat show
     */
    public static String recordText(String question) {
        return "/graph ask " + question.strip();
    }

    /**
     * @param availability what the tool says about the session's folder
     * @param backend      the backend the setting names
     * @return the refusal, or null when the folder can be asked
     */
    public static String refusal(CodeGraphTool.Availability availability, CodeGraphBackend backend) {
        return switch (availability) {
            case READY -> null;
            case NO_FOLDER -> "This session has no folder yet, so there is no code graph to ask. Pick a folder in "
                    + "the header or send a first message, then type /graph build.";
            case NOT_INSTALLED -> backend.name() + " is not installed, so there is no code graph to ask. Install it "
                    + "in a terminal with `" + backend.install() + "`, then type /graph build.";
            case NO_GRAPH -> "This folder has no code graph yet. Type /graph build to build it, then ask again.";
            case OUTSIDE -> "The code graph of this folder resolves to a file outside it, so it is not read. Type "
                    + "/graph build to build it inside the folder.";
        };
    }
}
