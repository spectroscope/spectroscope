package dev.spectroscope.core.peer;

import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

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
 * Card 504, hub and spoke review round 1: a text cut at a fixed number of
 * characters can end in half of a surrogate pair, and the chat then shows a
 * broken character. In the loop, messaging, peer, playbook.run and subagents
 * packages a head cut goes through {@link PeerNotices#cut} or
 * {@code ToolOutput.clip}, or backs off one character itself. Card 586 added
 * playbook.run, because a lone high surrogate in a run_step line makes
 * {@code SessionStore.append} throw.
 *
 * <p>What the scan reads: every {@code r.substring(0, end)} in these
 * packages. It passes only these ends. An end made only of {@code .length()}
 * reads (a known suffix taken off). An end that is one bare
 * {@code x.indexOf(...)} or {@code x.lastIndexOf(...)} call. A local whose
 * declaration, the last {@code int end = ...;} between the opening brace of
 * the enclosing method and the cut, is either one bare find call like that, or
 * the back off {@code Character.isHighSurrogate(r.charAt(K - 1)) ? K - 1 : K}
 * on the same receiver {@code r}, where {@code K} is a name or a dotted name
 * with an optional {@code - n} and the two branches differ by exactly one.
 * Everything else is flagged: a constant, a number, a parameter,
 * {@code Math.min(...)} around anything, {@code s.length() - 1}, a swapped
 * back off. The enclosing method is the innermost block whose header has the
 * form {@code name(...)} with an optional throws clause, read with comments
 * and string literals blanked; {@code if}, {@code for}, {@code while},
 * {@code switch}, {@code catch}, {@code synchronized} and {@code new X(...)}
 * headers are not methods. The receiver {@code hex} or {@code hex(...)} is
 * exempt, because a hex string is ASCII by construction. Tail cuts are not
 * read. The files are read from the source tree, so a new file is checked
 * without a list to update.</p>
 */
class PairSafeCutDriftTest {

    private static final List<Path> ROOTS = List.of(
            Path.of("src/main/java/dev/spectroscope/core/loop"),
            Path.of("src/main/java/dev/spectroscope/core/messaging"),
            Path.of("src/main/java/dev/spectroscope/core/peer"),
            Path.of("src/main/java/dev/spectroscope/core/playbook/run"),
            Path.of("src/main/java/dev/spectroscope/core/subagents"));

    private static final String CALL = ".substring(";
    private static final Pattern HEX_RECEIVER = Pattern.compile("\\bhex(?:\\([^()]*\\))?$");
    private static final Pattern FOUND = Pattern.compile("\\.(?:indexOf|lastIndexOf)\\(");
    private static final Pattern FOUND_INLINE =
            Pattern.compile("[\\w.]+\\.(?:indexOf|lastIndexOf)\\([^()]*\\)");
    private static final Pattern IDENTIFIER = Pattern.compile("[a-z][A-Za-z0-9_]*");
    private static final Pattern RECEIVER = Pattern.compile("(\\w+)\\s*$");
    private static final Pattern BACK_OFF = Pattern.compile(
            "Character\\.isHighSurrogate\\(\\s*(\\w+)\\.charAt\\(([^()]+)\\)\\s*\\)\\s*\\?\\s*([^:?]+?)\\s*:\\s*([^:?]+)",
            Pattern.DOTALL);
    private static final Pattern OFFSET = Pattern.compile("([A-Za-z_][\\w.]*)(?:\\s*-\\s*(\\d+))?");
    private static final Pattern METHOD_HEADER = Pattern.compile(
            "(?s).*?\\b(\\w+)\\s*\\([^()]*\\)\\s*(?:throws\\s+[\\w.,\\s]+)?");
    private static final Pattern ANONYMOUS = Pattern.compile("(?s).*\\bnew\\s+[\\w.<>]+\\s*\\([^()]*\\)\\s*");
    private static final java.util.Set<String> NOT_METHODS =
            java.util.Set.of("if", "for", "while", "switch", "catch", "synchronized", "try");
    private static final Pattern LENGTHS_ONLY = Pattern.compile(
            "[\\w.\"]+\\.length\\(\\)(?:\\s*[-+]\\s*[\\w.\"]+\\.length\\(\\))*");

    /** One {@code substring(0, end)} call: where it starts and its end argument. */
    record HeadCut(int at, String end) {
    }

    /** Every two-argument {@code substring} whose first argument is {@code 0}. */
    static List<HeadCut> headCuts(String text) {
        List<HeadCut> out = new ArrayList<>();
        for (int at = text.indexOf(CALL); at >= 0; at = text.indexOf(CALL, at + 1)) {
            List<String> args = arguments(text, at + CALL.length());
            if (args.size() == 2 && args.getFirst().equals("0")) {
                out.add(new HeadCut(at, args.get(1)));
            }
        }
        return out;
    }

    /** The comma separated arguments from {@code open} to the matching parenthesis. */
    private static List<String> arguments(String text, int open) {
        List<String> args = new ArrayList<>();
        int depth = 0;
        int from = open;
        char quote = 0;
        for (int i = open; i < text.length(); i++) {
            char c = text.charAt(i);
            if (quote != 0) {
                if (c == '\\') {
                    i++;
                } else if (c == quote) {
                    quote = 0;
                }
            } else if (c == '"' || c == '\'') {
                quote = c;
            } else if (c == '(') {
                depth++;
            } else if (c == ')' && depth > 0) {
                depth--;
            } else if (c == ')' || (c == ',' && depth == 0)) {
                args.add(text.substring(from, i).strip());
                from = i + 1;
                if (c == ')') {
                    return args;
                }
            }
        }
        return List.of();
    }

    /** Whether a head cut at {@code end} cannot fall inside a pair, by the rules above. */
    static boolean safeEnd(String text, HeadCut cut) {
        String end = cut.end();
        if (LENGTHS_ONLY.matcher(end).matches()) {
            return true;
        }
        if (FOUND_INLINE.matcher(end).matches()) {
            return true;
        }
        if (!IDENTIFIER.matcher(end).matches()) {
            return false;
        }
        int body = enclosingMethodBody(text, cut.at());
        if (body < 0) {
            return false;
        }
        Matcher declared = Pattern.compile("\\bint\\s+" + Pattern.quote(end) + "\\s*=([^;]+);")
                .matcher(text.substring(body, cut.at()));
        String init = null;
        while (declared.find()) {
            init = declared.group(1).strip();
        }
        if (init == null) {
            return false;
        }
        Matcher receiver = RECEIVER.matcher(text.substring(0, cut.at()));
        return FOUND_INLINE.matcher(init).matches()
                || (receiver.find() && backsOff(init, receiver.group(1)));
    }

    /** Whether {@code init} is {@code isHighSurrogate(r.charAt(E)) ? E : F} with E one below F. */
    static boolean backsOff(String init, String receiver) {
        Matcher shape = BACK_OFF.matcher(init);
        if (!shape.matches() || !shape.group(1).equals(receiver)) {
            return false;
        }
        String probe = shape.group(2).replaceAll("\\s+", " ");
        if (!probe.equals(shape.group(3).replaceAll("\\s+", " "))) {
            return false;
        }
        Matcher e = OFFSET.matcher(shape.group(2).strip());
        Matcher f = OFFSET.matcher(shape.group(4).strip());
        if (!e.matches() || !f.matches() || !e.group(1).equals(f.group(1))) {
            return false;
        }
        int below = e.group(2) == null ? 0 : Integer.parseInt(e.group(2));
        int top = f.group(2) == null ? 0 : Integer.parseInt(f.group(2));
        return below == top + 1;
    }

    /**
     * @return the index just after the opening brace of the innermost method
     *         around {@code at}, or -1 when none is found
     */
    static int enclosingMethodBody(String text, int at) {
        String masked = masked(text);
        List<Integer> open = new ArrayList<>();
        for (int i = 0; i < at && i < masked.length(); i++) {
            char c = masked.charAt(i);
            if (c == '{') {
                open.add(i);
            } else if (c == '}' && !open.isEmpty()) {
                open.removeLast();
            }
        }
        for (int k = open.size() - 1; k >= 0; k--) {
            int brace = open.get(k);
            int from = Math.max(Math.max(masked.lastIndexOf(';', brace - 1), masked.lastIndexOf('{', brace - 1)),
                    masked.lastIndexOf('}', brace - 1)) + 1;
            String header = masked.substring(from, brace).strip();
            Matcher method = METHOD_HEADER.matcher(header);
            if (method.matches() && !NOT_METHODS.contains(method.group(1))
                    && !ANONYMOUS.matcher(header).matches()) {
                return brace + 1;
            }
        }
        return -1;
    }

    /** {@code text} with comments and the inside of string and char literals blanked, same length. */
    static String masked(String text) {
        StringBuilder out = new StringBuilder(text);
        int i = 0;
        while (i < text.length()) {
            char c = text.charAt(i);
            if (c == '/' && i + 1 < text.length() && text.charAt(i + 1) == '/') {
                int stop = text.indexOf('\n', i);
                stop = stop < 0 ? text.length() : stop;
                blank(out, i, stop);
                i = stop;
            } else if (c == '/' && i + 1 < text.length() && text.charAt(i + 1) == '*') {
                int stop = text.indexOf("*/", i + 2);
                stop = stop < 0 ? text.length() : stop + 2;
                blank(out, i, stop);
                i = stop;
            } else if (text.startsWith("\"\"\"", i)) {
                int stop = text.indexOf("\"\"\"", i + 3);
                stop = stop < 0 ? text.length() : stop;
                blank(out, i + 3, stop);
                i = stop + 3;
            } else if (c == '"' || c == '\'') {
                int j = i + 1;
                while (j < text.length() && text.charAt(j) != c && text.charAt(j) != '\n') {
                    j += text.charAt(j) == '\\' ? 2 : 1;
                }
                blank(out, i + 1, Math.min(j, text.length()));
                i = j + 1;
            } else {
                i++;
            }
        }
        return out.toString();
    }

    private static void blank(StringBuilder out, int from, int to) {
        for (int i = from; i < to; i++) {
            if (out.charAt(i) != '\n') {
                out.setCharAt(i, ' ');
            }
        }
    }

    static List<String> rawCuts(Path root) throws IOException {
        List<String> hits = new ArrayList<>();
        try (Stream<Path> files = Files.walk(root)) {
            for (Path file : files.filter(f -> f.toString().endsWith(".java")).sorted().toList()) {
                String text = Files.readString(file);
                for (HeadCut cut : headCuts(text)) {
                    int lineStart = text.lastIndexOf('\n', cut.at()) + 1;
                    if (HEX_RECEIVER.matcher(text.substring(lineStart, cut.at())).find() || safeEnd(text, cut)) {
                        continue;
                    }
                    int line = (int) text.substring(0, cut.at()).chars().filter(c -> c == '\n').count() + 1;
                    hits.add(file + ":" + line + " substring(0, " + cut.end() + ")");
                }
            }
        }
        return hits;
    }

    @Test
    void noRawCutAtACapInTheGuardedPackages() throws IOException {
        List<String> hits = new ArrayList<>();
        int read = 0;
        for (Path root : ROOTS) {
            assertTrue(Files.isDirectory(root), "the walk starts in the module directory: " + root);
            hits.addAll(rawCuts(root));
            try (Stream<Path> files = Files.walk(root)) {
                for (Path file : files.filter(f -> f.toString().endsWith(".java")).toList()) {
                    read += headCuts(Files.readString(file)).size();
                }
            }
        }
        assertEquals(List.of(), hits);
        assertTrue(read >= 13, "positive: the scan reads the head cuts of the guarded packages, saw " + read);
    }

    @Test
    void theScanFindsEachShapeOfARawCut(@TempDir Path dir) throws IOException {
        Files.writeString(dir.resolve("Sample.java"), String.join("\n",
                "class Sample {",
                "    String a(String s) { return s.substring(0, PeerLimits.SUMMARY_CAP); }",
                "    String b(String s) { return s.substring(0, 200); }",
                "    String c(String s) { return s.substring(0, MAX_STEP_CHARS - 1) + \"x\"; }",
                "    String d(String s) { return s.substring(0, CAP); }",
                "}", ""));
        List<String> hits = rawCuts(dir);
        assertEquals(4, hits.size(), hits.toString());
        assertTrue(hits.getFirst().contains("Sample.java:2"), hits.toString());
    }

    @Test
    void aPairSafeCutAndAHexCutAreNotFlagged(@TempDir Path dir) throws IOException {
        Files.writeString(dir.resolve("Sample.java"), String.join("\n",
                "class Sample {",
                "    String a(String s) {",
                "        int end = Character.isHighSurrogate(s.charAt(CAP - 1)) ? CAP - 1 : CAP;",
                "        return s.substring(0, end);",
                "    }",
                "    String b(String s) { return s.substring(0, s.indexOf('\\n')); }",
                "    String c(String id) { return hex(id).substring(0, PeerLimits.REF_HEX); }",
                "    String d(String hex) { return hex.substring(0, 2); }",
                "    String e(String s) { return PeerNotices.cut(s, PeerLimits.SUMMARY_CAP); }",
                "}", ""));
        assertEquals(List.of(), rawCuts(dir));
    }

    @Test
    void aCutAtAComputedEndThatIsNotFoundOrBackedOffIsFlagged(@TempDir Path dir) throws IOException {
        Files.writeString(dir.resolve("Sample.java"), String.join("\n",
                "class Sample {",
                "    String a(String s) { return s.substring(0, Math.min(s.length(), PeerLimits.SUMMARY_CAP)); }",
                "    String b(String s, int n) { return s.substring(0, n); }",
                "    String c(String s) { int end = CAP; return s.substring(0, end); }",
                "    String d(String s) { return s.substring(0, s.length() - 1); }",
                "}", ""));
        List<String> hits = rawCuts(dir);
        assertEquals(4, hits.size(), hits.toString());
        assertTrue(hits.getFirst().contains("Math.min"), hits.toString());
    }

    /**
     * Last fix round: a parameter that shares its name with a found local of
     * an earlier method, a back off whose branches are swapped, and a found
     * position inside {@code Math.min(...)} are each flagged.
     */
    @Test
    void aBorrowedDeclarationAnInvertedBackOffAndAFindInsideMinAreFlagged(@TempDir Path dir) throws IOException {
        Files.writeString(dir.resolve("Sample.java"), String.join("\n",
                "class Sample {",
                "    String a(String s) { int end = s.indexOf('x'); return s.substring(0, end); }",
                "    String b(String s, int end) { return s.substring(0, end); }",
                "    String c(String s) {",
                "        int end = Character.isHighSurrogate(s.charAt(CAP - 1)) ? CAP : CAP - 1;",
                "        return s.substring(0, end);",
                "    }",
                "    String d(String s) { int end = Math.min(CAP, s.indexOf(x) + 400); return s.substring(0, end); }",
                "    String e(String s) { return s.substring(0, Math.min(CAP, s.indexOf(x) + 400)); }",
                "}", ""));
        List<String> hits = rawCuts(dir);
        assertEquals(4, hits.size(), hits.toString());
        assertTrue(hits.get(0).contains("Sample.java:3"), "the parameter: " + hits);
        assertTrue(hits.get(1).contains("Sample.java:6"), "the inverted back off: " + hits);
        assertTrue(hits.get(2).contains("Sample.java:8"), "the find inside min: " + hits);
        assertTrue(hits.get(3).contains("Sample.java:9"), "the same inline: " + hits);
    }

    /**
     * Last fix round 2026-10-12: each part of the back off check has a sample
     * that only it flags. Another receiver, two different names, a true branch
     * that is not the probe, and a gap of two.
     */
    @Test
    void eachPartOfTheBackOffCheckFlagsASampleOfItsOwn(@TempDir Path dir) throws IOException {
        Files.writeString(dir.resolve("Sample.java"), String.join("\n",
                "class Sample {",
                "    String a(String s, String t) {",
                "        int end = Character.isHighSurrogate(t.charAt(K - 1)) ? K - 1 : K;",
                "        return s.substring(0, end);",
                "    }",
                "    String b(String s) {",
                "        int end = Character.isHighSurrogate(s.charAt(A - 1)) ? A - 1 : B;",
                "        return s.substring(0, end);",
                "    }",
                "    String c(String s) {",
                "        int end = Character.isHighSurrogate(s.charAt(K - 1)) ? J : K;",
                "        return s.substring(0, end);",
                "    }",
                "    String d(String s) {",
                "        int end = Character.isHighSurrogate(s.charAt(K - 2)) ? K - 2 : K;",
                "        return s.substring(0, end);",
                "    }",
                "}", ""));
        List<String> hits = rawCuts(dir);
        assertEquals(4, hits.size(), hits.toString());
        assertTrue(hits.get(0).contains("Sample.java:4"), "another receiver: " + hits);
        assertTrue(hits.get(1).contains("Sample.java:8"), "two names: " + hits);
        assertTrue(hits.get(2).contains("Sample.java:12"), "a true branch that is not the probe: " + hits);
        assertTrue(hits.get(3).contains("Sample.java:16"), "a gap of two: " + hits);
    }

    @Test
    void aBackedOffEndAFoundPositionAndASuffixTakenOffAreNotFlagged(@TempDir Path dir) throws IOException {
        Files.writeString(dir.resolve("Sample.java"), String.join("\n",
                "class Sample {",
                "    String a(String s) {",
                "        int end = Character.isHighSurrogate(s.charAt(CAP - 1))",
                "                ? CAP - 1 : CAP;",
                "        return s.substring(0, end);",
                "    }",
                "    String b(String s) { int newline = s.indexOf('\\n'); return s.substring(0, newline); }",
                "    String c(String f) { return f.substring(0, f.length() - \".json\".length()); }",
                "}", ""));
        assertEquals(List.of(), rawCuts(dir));
    }

    @Test
    void theHexCutsOfPeerNamesAreSeenAndExempt(@TempDir Path dir) throws IOException {
        String names = Files.readString(Path.of("src/main/java/dev/spectroscope/core/peer/PeerNames.java"));
        long seen = headCuts(names).size();
        assertEquals(4, seen, "positive: the pattern sees the four hex cuts of PeerNames");
        Files.writeString(dir.resolve("PeerNames.java"), names);
        assertEquals(List.of(), rawCuts(dir), "and the hex receiver exempts each of them");
    }
}
