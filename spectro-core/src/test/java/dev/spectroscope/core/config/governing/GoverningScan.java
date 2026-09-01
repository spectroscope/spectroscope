package dev.spectroscope.core.config.governing;

import java.io.IOException;
import java.lang.reflect.Field;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.List;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import java.util.stream.Stream;

/**
 * The walk that derives the registry — card 357's criterion 3, and the reason
 * this card is not a table somebody typed.
 *
 * <p>It reads {@code spectro-core/src/main/java}, finds every constant of the
 * GOVERNING SHAPE, and builds a {@link GoverningNumber} for each one from three
 * sources, none of which is a hand list:</p>
 *
 * <ul>
 *   <li>the <b>value</b> off the field itself, by reflection — the live value,
 *       not a literal re-typed from the source;</li>
 *   <li>the <b>kind</b>, <b>unit</b> and <b>key</b> off the {@link Governs}
 *       annotation, which sits on the constant;</li>
 *   <li>the <b>explanation</b> from the javadoc already standing above it,
 *       flattened to text.</li>
 * </ul>
 *
 * <p><b>The shape is the definition, and it lives here once</b> — in
 * {@code NUMERIC_TYPE}, which every sentence about this registry now points at
 * instead of restating. A constant is in scope when it is a {@code static
 * final} of one of those types with a SCREAMING_SNAKE name in this module's
 * main sources. Whether such a constant counts as GOVERNING is then its own
 * declared {@link Governs.Kind}, not a name the scan recognises — so "what
 * counts as governing" cannot exist in two places, and an exclusion has to be
 * written next to the number it excludes rather than remembered in a list
 * here.</p>
 *
 * <p>An unannotated constant is a scan FAILURE, not a silent skip. That is the
 * whole guard: {@code GoverningNumbersDriftTest} adds a further constant to the
 * source and demands red. <b>The reach of the shape is a second guard</b>,
 * added after a reviewer showed the first one alone was not enough: {@link
 * #unseenTypes()} hands the drift test the declared type of every constant the
 * shape does NOT match, so a numeric family outside it fails the build by name
 * rather than shrinking the page in silence.</p>
 */
final class GoverningScan {

    /**
     * Every type this walk counts as numeric, and the ONE place that list
     * lives.
     *
     * <p>It is all seven numeric primitives (Java calls {@code char} integral,
     * and one of them holds a separator rather than a quantity — it says so
     * itself by declaring {@link Governs.Kind#PLUMBING}, which is the point of
     * having the kind), an array of any of them, and {@link java.time.Duration}
     * spelt either way. <b>Duration is here because leaving it out cost the
     * card its sharpest examples:</b> the 19 timeouts of the MCP transports,
     * the browser and the searchers are all Durations, and the card's own notes
     * call {@code McpClient.DEFAULT_TIMEOUT} the sharpest looks-settable number
     * in the tree and the {@code StdioTransport} family "the proof of this
     * card's whole thesis". A reviewer added a plainly governing
     * {@code Duration}, an {@code int[]} ladder and a {@code short} to the
     * source and the drift test stayed green through all three.</p>
     *
     * <p>What is deliberately NOT here: {@code boolean}, {@code String} and
     * every object type, because the registry is about numbers. Nothing else
     * is excluded — {@code theShapeSeesEveryNumericConstantTheTreeDeclares}
     * derives the excluded type names from the source rather than trusting
     * this sentence, so the next family somebody introduces cannot be invisible
     * the way Duration was.</p>
     */
    private static final String NUMERIC_TYPE =
            "(?:(?:byte|short|char|int|long|float|double)(?:\\[\\])?"
                    + "|(?:java\\.time\\.)?Duration)";

    /** The governing shape: a {@link #NUMERIC_TYPE} {@code static final} with a
     *  SCREAMING_SNAKE name. Modifiers may be in either order and may be
     *  absent (package-private constants are as governing as public ones). */
    private static final Pattern DECLARATION = Pattern.compile(
            "^[ \\t]*(?:(?:public|private|protected)\\s+)?"
                    + "(?:static\\s+final|final\\s+static)\\s+"
                    + NUMERIC_TYPE + "\\s+"
                    + "([A-Z][A-Z0-9_]*)\\s*(?:=|$)");

    /** Any {@code static final} SCREAMING_SNAKE constant, whatever its type —
     *  the wider net {@link #unseenTypes()} subtracts the shape from, so an
     *  exclusion has to be a type name somebody can read rather than a silence
     *  nobody can see. Group 1 is the declared type. */
    private static final Pattern ANY_CONSTANT = Pattern.compile(
            "^[ \\t]*(?:(?:public|private|protected)\\s+)?"
                    + "(?:static\\s+final|final\\s+static)\\s+"
                    + "([A-Za-z_$][\\w$.]*(?:<[^>]*>)?(?:\\[\\])?)\\s+"
                    + "[A-Z][A-Z0-9_]*\\s*(?:=|;|$)");

    private static final Pattern INLINE_TAG =
            Pattern.compile("\\{@(code|literal|link|linkplain)\\s+([^}]*)}");

    /** Stands in for a newline inside a {@code <pre>} block while the
     *  paragraph collapse runs — a character no javadoc in this tree holds. */
    private static final String PRE_NEWLINE = "\u0001";

    private GoverningScan() {
    }

    /**
     * Every classified constant this module's main sources declare.
     *
     * @return the registry the resource has to equal, in resource order
     * @throws IOException              when the source tree cannot be read
     * @throws IllegalStateException    when a constant of the governing shape
     *                                  carries no {@link Governs}
     */
    static List<GoverningNumber> scan() throws IOException {
        List<GoverningNumber> found = new ArrayList<>();
        List<String> unclassified = new ArrayList<>();
        Path root = sourceRoot();
        for (Path file : sourceFiles()) {
            List<String> lines = Files.readAllLines(file);
            String className = classNameOf(root, file);
            for (int i = 0; i < lines.size(); i++) {
                Matcher declaration = DECLARATION.matcher(stripLineComment(lines.get(i)));
                if (!declaration.find()) {
                    continue;
                }
                String name = declaration.group(1);
                Field field = fieldOf(className, name);
                if (field == null) {
                    unclassified.add(relative(root, file) + ":" + (i + 1) + " " + name
                            + " (no such field on " + className + " or its members)");
                    continue;
                }
                Governs governs = field.getAnnotation(Governs.class);
                if (governs == null) {
                    unclassified.add(relative(root, file) + ":" + (i + 1) + " " + name);
                    continue;
                }
                found.add(new GoverningNumber(field.getDeclaringClass().getName(), name,
                        valueOf(field), expressionAt(lines, i), governs.kind(), governs.unit(),
                        governs.key(), javadocAbove(lines, i)));
            }
        }
        if (!unclassified.isEmpty()) {
            throw new IllegalStateException("numeric constants of the governing shape with no"
                    + " @Governs — every one of them decides something about a run, and an"
                    + " unclassified number is exactly the reach card 357 exists to close:\n  "
                    + String.join("\n  ", unclassified));
        }
        return found.stream()
                .sorted(Comparator.comparing(GoverningNumber::owner)
                        .thenComparing(GoverningNumber::field))
                .toList();
    }

    /** Every {@code .java} file of the covered tree, in a stable order. */
    private static List<Path> sourceFiles() throws IOException {
        try (Stream<Path> tree = Files.walk(sourceRoot())) {
            return tree.filter(Files::isRegularFile)
                    .filter(p -> p.toString().endsWith(".java"))
                    .sorted()
                    .toList();
        }
    }

    /** {@code spectro-core}'s main sources, the one tree this scan covers. */
    static Path sourceRoot() {
        return repoRoot().resolve("spectro-core/src/main/java");
    }

    /** Walks up to the directory holding the Gradle settings file — the same
     *  recipe {@code KnownKeysDriftTest} and {@code ConfigDocDriftTest} use. */
    static Path repoRoot() {
        for (Path candidate = Path.of("").toAbsolutePath();
                candidate != null; candidate = candidate.getParent()) {
            if (Files.isRegularFile(candidate.resolve("settings.gradle.kts"))) {
                return candidate;
            }
        }
        throw new IllegalStateException("no settings.gradle.kts above " + Path.of("").toAbsolutePath());
    }

    private static String relative(Path root, Path file) {
        return root.relativize(file).toString();
    }

    private static String classNameOf(Path root, Path file) {
        String relative = relative(root, file);
        return relative.substring(0, relative.length() - ".java".length())
                .replace(java.io.File.separatorChar, '.');
    }

    /** The field, looked up on the file's own class and then on its member
     *  classes — a constant may sit in a nested type and still govern. */
    private static Field fieldOf(String className, String name) {
        try {
            return declared(Class.forName(className), name);
        } catch (ClassNotFoundException e) {
            return null;
        }
    }

    private static Field declared(Class<?> type, String name) {
        try {
            Field field = type.getDeclaredField(name);
            field.setAccessible(true);
            return field;
        } catch (NoSuchFieldException e) {
            for (Class<?> member : type.getDeclaredClasses()) {
                Field nested = declared(member, name);
                if (nested != null) {
                    return nested;
                }
            }
            return null;
        }
    }

    private static String valueOf(Field field) {
        try {
            return render(field.get(null));
        } catch (IllegalAccessException e) {
            throw new IllegalStateException("cannot read " + field, e);
        }
    }

    /**
     * A live field value as the page has to print it — a NUMBER, not an
     * object's {@code toString}.
     *
     * <p>Two types cannot go through {@link String#valueOf} and stay honest. A
     * {@code Duration} prints ISO-8601 ({@code PT20S}), which is not something
     * an operator can weigh against the seconds the unit column names beside
     * it. An array prints its identity hash ({@code [I@1f2a3b}), which is not
     * a value at all — it would put a different string in the generated
     * resource on every single run and make the byte compare meaningless.</p>
     *
     * @param value the live value off the field
     * @return the decimal a reader can use
     */
    static String render(Object value) {
        if (value instanceof java.time.Duration duration) {
            return duration.getNano() == 0
                    ? String.valueOf(duration.toSeconds())
                    : String.valueOf(duration.toMillis());
        }
        if (value != null && value.getClass().isArray()) {
            StringBuilder out = new StringBuilder("[");
            for (int i = 0; i < java.lang.reflect.Array.getLength(value); i++) {
                out.append(i == 0 ? "" : ", ").append(java.lang.reflect.Array.get(value, i));
            }
            return out.append("]").toString();
        }
        return String.valueOf(value);
    }

    /**
     * The declared type of every {@code static final} SCREAMING_SNAKE constant
     * in the tree that the governing shape does NOT see.
     *
     * <p>The exclusion is the whole risk of this card. A shape that quietly
     * skips a family reads exactly like a tree that has none, and that is how
     * 19 {@code Duration} timeouts sat outside a registry whose javadoc claimed
     * every numeric constant. So the excluded families are DERIVED here rather
     * than remembered: a test holds this set to the non-numeric types alone,
     * and the day somebody declares a {@code static final BigDecimal RATE} the
     * build says so instead of the page silently shrinking.</p>
     *
     * @return the type names, deduplicated and sorted
     * @throws IOException when the source tree cannot be read
     */
    static java.util.SortedSet<String> unseenTypes() throws IOException {
        java.util.SortedSet<String> types = new java.util.TreeSet<>();
        for (Path file : sourceFiles()) {
            for (String raw : Files.readAllLines(file)) {
                String line = stripLineComment(raw);
                if (DECLARATION.matcher(line).find()) {
                    continue;
                }
                Matcher any = ANY_CONSTANT.matcher(line);
                if (any.find()) {
                    types.add(any.group(1));
                }
            }
        }
        return types;
    }

    /** The initializer exactly as the source writes it, joined across
     *  continuation lines and stripped of any trailing line comment. */
    private static String expressionAt(List<String> lines, int at) {
        StringBuilder declaration = new StringBuilder();
        for (int i = at; i < lines.size(); i++) {
            declaration.append(' ').append(stripLineComment(lines.get(i)).trim());
            if (declaration.indexOf(";") >= 0) {
                break;
            }
        }
        String text = declaration.toString();
        int equals = text.indexOf('=');
        int semicolon = text.indexOf(';');
        if (equals < 0 || semicolon < equals) {
            return "";
        }
        return text.substring(equals + 1, semicolon).trim().replaceAll("\\s+", " ");
    }

    private static String stripLineComment(String line) {
        int at = line.indexOf("//");
        return at < 0 ? line : line.substring(0, at);
    }

    /**
     * The javadoc standing above a declaration, flattened to plain text.
     *
     * <p>The walk steps back over the {@link Governs} annotation lines first:
     * the annotation sits between the prose and the constant, and the prose is
     * what the operator reads.</p>
     */
    private static String javadocAbove(List<String> lines, int at) {
        int cursor = at - 1;
        while (cursor >= 0 && lines.get(cursor).trim().startsWith("@Governs")) {
            cursor--;
        }
        if (cursor < 0 || !lines.get(cursor).trim().endsWith("*/")) {
            return "";
        }
        int end = cursor;
        while (cursor >= 0 && !lines.get(cursor).trim().startsWith("/**")) {
            cursor--;
        }
        if (cursor < 0) {
            return "";
        }
        StringBuilder raw = new StringBuilder();
        for (int i = cursor; i <= end; i++) {
            String line = lines.get(i).trim();
            line = line.startsWith("/**") ? line.substring(3) : line;
            line = line.endsWith("*/") ? line.substring(0, line.length() - 2) : line;
            line = line.startsWith("*") ? line.substring(1) : line;
            raw.append(line).append('\n');
        }
        return flatten(raw.toString());
    }

    /**
     * Javadoc markup to the text a settings room can print: inline tags keep
     * their subject, paragraph tags become blank lines, the rest goes.
     *
     * <p>"The rest" means any HTML tag, of any length. It used to mean a tag of
     * one to forty characters, which was a sentence wider than its code: a
     * javadoc holding {@code <a href="https://platform.openai.com/docs/api-reference">}
     * is fifty-six characters and would have survived the strip, reached the
     * generated resource, and been rendered at the operator as literal angle
     * brackets. The bound is now a SHAPE rather than a length — a tag begins
     * with a letter or a slash — so prose like {@code a < b && c > d} is still
     * left alone, which is what the length bound was really protecting.</p>
     *
     * @param javadoc the raw comment body, asterisks already stripped
     * @return the flattened text, paragraphs separated by a blank line
     */
    static String flatten(String javadoc) {
        String text = javadoc;
        text = INLINE_TAG.matcher(text).replaceAll(match -> {
            String body = match.group(2).trim();
            // {@code} and {@literal} quote text VERBATIM — a file name like
            // konzept/ORCHESTRATION.md is not a class reference, and treating
            // it as one printed the word "md" on the settings room.
            if (!match.group(1).startsWith("link")) {
                return Matcher.quoteReplacement(body);
            }
            int hash = body.indexOf('#');
            String head = hash < 0 ? body : body.substring(0, hash);
            String tail = hash < 0 ? "" : body.substring(hash + 1);
            int dot = head.lastIndexOf('.');
            String simple = dot < 0 ? head : head.substring(dot + 1);
            String joined = tail.isEmpty() ? simple : (simple.isEmpty() ? tail : simple + "." + tail);
            return Matcher.quoteReplacement(joined);
        });
        // A <pre> block is the one place a line break carries meaning (the two
        // census tables in SpectroConfig). Its newlines are parked on a
        // sentinel so the paragraph collapse below cannot eat them.
        text = Pattern.compile("(?is)<pre>(.*?)</pre>").matcher(text)
                .replaceAll(match -> Matcher.quoteReplacement(
                        "\n\n" + match.group(1).strip().replace("\n", PRE_NEWLINE) + "\n\n"));
        text = text.replaceAll("(?i)</p>", "");
        text = text.replaceAll("(?i)<p>", "\n\n");
        text = text.replaceAll("(?i)<li>", "\n\n");
        text = text.replaceAll("</?[A-Za-z][^>]*>", "");
        text = text.replace("&#47;", "/").replace("&lt;", "<").replace("&gt;", ">")
                .replace("&quot;", "\"").replace("&amp;", "&");
        text = text.replaceAll("(?m)^\\s*@(param|return|throws|see|since|deprecated)\\b.*$", "");
        StringBuilder out = new StringBuilder();
        for (String paragraph : text.split("\n\\s*\n")) {
            String collapsed = paragraph.replaceAll("\\s+", " ").trim();
            if (collapsed.isEmpty()) {
                continue;
            }
            if (out.length() > 0) {
                out.append("\n\n");
            }
            out.append(collapsed);
        }
        return out.toString().replace(PRE_NEWLINE, "\n");
    }
}
