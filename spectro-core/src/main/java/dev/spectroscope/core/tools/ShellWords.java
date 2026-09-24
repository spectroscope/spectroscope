package dev.spectroscope.core.tools;

import java.util.ArrayList;
import java.util.List;

/**
 * Card 396: a shell line cut into what {@link HostGuard} reads, which is
 * pipelines of simple commands of words.
 *
 * <p>This is not a shell. Nothing is expanded and nothing runs. Quotes are
 * removed the way {@code sh} removes them, a redirection and its target are
 * dropped, a here-document body is skipped, a comment ends at the line break,
 * and the text inside each {@code $(...)} and backquote pair is kept beside
 * its word, so the guard can read it as a line of its own.</p>
 */
final class ShellWords {

    /**
     * One word after quote removal.
     *
     * @param text          the word as {@code sh} would pass it, any {@code $(...)} left as written
     * @param substitutions the inner text of each {@code $(...)} or backquote pair in the word
     * @param expands       true when the word holds a {@code $} expansion whose value is unknown here
     */
    record Word(String text, List<String> substitutions, boolean expands) {
    }

    /**
     * One simple command.
     *
     * @param words its words in order, redirections removed
     */
    record Command(List<Word> words) {
    }

    /**
     * Commands joined by {@code |}.
     *
     * @param stages the commands, left to right
     */
    record Pipeline(List<Command> stages) {
    }

    private ShellWords() {
    }

    /**
     * Cuts one line.
     *
     * @param line the shell line
     * @return its pipelines in order; unbalanced quotes end at the end of the line
     */
    static List<Pipeline> parse(String line) {
        return new Lexer(line == null ? "" : line).run();
    }

    /** One pass over one line. */
    private static final class Lexer {
        private final String s;
        private final int n;
        private int i;
        private final StringBuilder text = new StringBuilder();
        private List<String> subs = new ArrayList<>();
        private boolean inWord;
        private boolean expands;
        private boolean quoted;
        private List<ShellWords.Word> words = new ArrayList<>();
        private List<Command> stages = new ArrayList<>();
        private final List<Pipeline> out = new ArrayList<>();
        /** The next word is the target of a redirection and is dropped. */
        private boolean dropNext;
        /** The next word is a here-document delimiter. */
        private boolean delimiterNext;
        private boolean stripTabs;
        /** Delimiters waiting for the next line break, with their tab rule. */
        private final List<String> heredocs = new ArrayList<>();
        private final List<Boolean> heredocStrips = new ArrayList<>();

        Lexer(String s) {
            this.s = s;
            this.n = s.length();
        }

        List<Pipeline> run() {
            while (i < n) {
                char c = s.charAt(i);
                switch (c) {
                    case ' ', '\t', '\r' -> {
                        endWord();
                        i++;
                    }
                    case '\n' -> {
                        endPipeline();
                        i++;
                        skipHeredocBodies();
                    }
                    case '#' -> {
                        if (inWord) {
                            append(c);
                            i++;
                        } else {
                            while (i < n && s.charAt(i) != '\n') {
                                i++;
                            }
                        }
                    }
                    case '\\' -> backslash();
                    case '\'' -> singleQuoted();
                    case '"' -> doubleQuoted();
                    case '`' -> backquoted();
                    case '$' -> dollar();
                    case ';' -> {
                        endPipeline();
                        i++;
                    }
                    case '&' -> ampersand();
                    case '|' -> bar();
                    case '>', '<' -> redirection();
                    case '(', ')' -> {
                        endPipeline();
                        i++;
                    }
                    default -> {
                        append(c);
                        i++;
                    }
                }
            }
            endPipeline();
            return out;
        }

        private void append(char c) {
            text.append(c);
            inWord = true;
        }

        private void backslash() {
            if (i + 1 >= n) {
                i++;
                return;
            }
            char next = s.charAt(i + 1);
            i += 2;
            if (next == '\n') {
                return; // a line continuation joins the two lines
            }
            append(next);
            quoted = true;
        }

        private void singleQuoted() {
            int end = s.indexOf('\'', i + 1);
            if (end < 0) {
                end = n;
            }
            text.append(s, i + 1, end);
            inWord = true;
            quoted = true;
            i = Math.min(n, end + 1);
        }

        private void doubleQuoted() {
            inWord = true;
            quoted = true;
            i++;
            while (i < n && s.charAt(i) != '"') {
                char c = s.charAt(i);
                if (c == '\\' && i + 1 < n) {
                    char next = s.charAt(i + 1);
                    if (next == '$' || next == '`' || next == '"' || next == '\\') {
                        text.append(next);
                        i += 2;
                    } else if (next == '\n') {
                        i += 2;
                    } else {
                        text.append('\\');
                        i++;
                    }
                } else if (c == '$') {
                    dollar();
                } else if (c == '`') {
                    backquoted();
                } else {
                    text.append(c);
                    i++;
                }
            }
            i = Math.min(n, i + 1);
        }

        private void dollar() {
            inWord = true;
            if (s.startsWith("$((", i)) {
                int end = closeParen(i + 1);
                text.append(s, i, Math.min(n, end + 1));
                expands = true;
                i = Math.min(n, end + 1);
                return;
            }
            if (s.startsWith("$(", i)) {
                int end = closeParen(i + 1);
                String inner = s.substring(i + 2, Math.min(n, end));
                subs.add(inner);
                text.append("$(").append(inner).append(')');
                i = Math.min(n, end + 1);
                return;
            }
            if (s.startsWith("${", i)) {
                int end = s.indexOf('}', i);
                int stop = end < 0 ? n : end + 1;
                text.append(s, i, stop);
                expands = true;
                i = stop;
                return;
            }
            if (i + 1 < n) {
                char next = s.charAt(i + 1);
                if (Character.isLetter(next) || next == '_') {
                    int j = i + 1;
                    while (j < n && (Character.isLetterOrDigit(s.charAt(j)) || s.charAt(j) == '_')) {
                        j++;
                    }
                    text.append(s, i, j);
                    expands = true;
                    i = j;
                    return;
                }
                if (Character.isDigit(next) || "$!?#@*-".indexOf(next) >= 0) {
                    text.append(s, i, i + 2);
                    expands = true;
                    i += 2;
                    return;
                }
            }
            text.append('$');
            i++;
        }

        private void backquoted() {
            int j = i + 1;
            StringBuilder inner = new StringBuilder();
            while (j < n && s.charAt(j) != '`') {
                char c = s.charAt(j);
                if (c == '\\' && j + 1 < n && "`\\$".indexOf(s.charAt(j + 1)) >= 0) {
                    inner.append(s.charAt(j + 1));
                    j += 2;
                } else {
                    inner.append(c);
                    j++;
                }
            }
            subs.add(inner.toString());
            text.append('`').append(inner).append('`');
            inWord = true;
            i = Math.min(n, j + 1);
        }

        /** @param open the index of an opening parenthesis
         *  @return the index of its partner, or the line's length when there is none */
        private int closeParen(int open) {
            int depth = 0;
            for (int j = open; j < n; j++) {
                char c = s.charAt(j);
                if (c == '\\') {
                    j++;
                } else if (c == '\'') {
                    int end = s.indexOf('\'', j + 1);
                    if (end < 0) {
                        return n;
                    }
                    j = end;
                } else if (c == '"') {
                    j = closeDouble(j);
                } else if (c == '(') {
                    depth++;
                } else if (c == ')') {
                    depth--;
                    if (depth == 0) {
                        return j;
                    }
                }
            }
            return n;
        }

        /** @param open the index of an opening double quote
         *  @return the index of its partner, or the line's length when there is none */
        private int closeDouble(int open) {
            for (int j = open + 1; j < n; j++) {
                char c = s.charAt(j);
                if (c == '\\') {
                    j++;
                } else if (c == '"') {
                    return j;
                } else if (c == '$' && j + 1 < n && s.charAt(j + 1) == '(') {
                    j = closeParen(j + 1);
                }
            }
            return n;
        }

        private void ampersand() {
            if (i + 1 < n && s.charAt(i + 1) == '&') {
                endPipeline();
                i += 2;
            } else if (i + 1 < n && s.charAt(i + 1) == '>') {
                endWord();
                i++;
                redirection();
            } else {
                endPipeline();
                i++;
            }
        }

        private void bar() {
            if (i + 1 < n && s.charAt(i + 1) == '|') {
                endPipeline();
                i += 2;
                return;
            }
            endCommand();
            i += (i + 1 < n && s.charAt(i + 1) == '&') ? 2 : 1;
        }

        private void redirection() {
            // Digits written right before the operator are the file descriptor.
            boolean fd = inWord && !quoted && subs.isEmpty() && text.length() > 0
                    && text.chars().allMatch(Character::isDigit);
            if (fd) {
                resetWord();
            } else {
                endWord();
            }
            if (s.startsWith("<<<", i)) {
                i += 3;
                dropNext = true;
                return;
            }
            if (s.startsWith("<<", i)) {
                i += 2;
                stripTabs = i < n && s.charAt(i) == '-';
                if (stripTabs) {
                    i++;
                }
                delimiterNext = true;
                return;
            }
            i++;
            if (i < n && (s.charAt(i) == '>' || s.charAt(i) == '&' || s.charAt(i) == '|')) {
                i++;
            }
            dropNext = true;
        }

        private void skipHeredocBodies() {
            for (int h = 0; h < heredocs.size(); h++) {
                String delimiter = heredocs.get(h);
                boolean strip = heredocStrips.get(h);
                while (i < n) {
                    int eol = s.indexOf('\n', i);
                    int end = eol < 0 ? n : eol;
                    String bodyLine = s.substring(i, end);
                    i = eol < 0 ? n : eol + 1;
                    String compared = strip ? bodyLine.replaceFirst("^\t+", "") : bodyLine;
                    if (compared.equals(delimiter)) {
                        break;
                    }
                }
            }
            heredocs.clear();
            heredocStrips.clear();
        }

        private void endWord() {
            if (!inWord) {
                return;
            }
            ShellWords.Word word = new ShellWords.Word(text.toString(), List.copyOf(subs), expands);
            if (delimiterNext) {
                heredocs.add(word.text());
                heredocStrips.add(stripTabs);
                delimiterNext = false;
            } else if (dropNext) {
                dropNext = false;
            } else {
                words.add(word);
            }
            resetWord();
        }

        private void resetWord() {
            text.setLength(0);
            subs = new ArrayList<>();
            inWord = false;
            expands = false;
            quoted = false;
        }

        private void endCommand() {
            endWord();
            dropNext = false;
            delimiterNext = false;
            if (!words.isEmpty()) {
                stages.add(new Command(List.copyOf(words)));
            }
            words = new ArrayList<>();
        }

        private void endPipeline() {
            endCommand();
            if (!stages.isEmpty()) {
                out.add(new Pipeline(List.copyOf(stages)));
            }
            stages = new ArrayList<>();
        }
    }
}
