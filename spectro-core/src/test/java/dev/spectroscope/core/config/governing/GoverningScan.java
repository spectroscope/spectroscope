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
 * <p><b>The shape is the definition, and it lives here once.</b> A constant
 * governs a run when it is a numeric {@code static final} with a
 * SCREAMING_SNAKE name in this module's main sources. Whether such a constant
 * counts as governing is then the constant's own declared
 * {@link Governs.Kind}, not a name the scan recognises — so "what counts as
 * governing" cannot exist in two places, and an exclusion has to be written
 * next to the number it excludes rather than remembered in a list here.</p>
 *
 * <p>An unannotated constant is a scan FAILURE, not a silent skip. That is the
 * whole guard: {@code GoverningNumbersDriftTest} adds a 77th constant to the
 * source and demands red.</p>
 */
final class GoverningScan {

    /** The governing shape: a numeric {@code static final} with a
     *  SCREAMING_SNAKE name. Modifiers may be in either order and may be
     *  absent (package-private constants are as governing as public ones). */
    private static final Pattern DECLARATION = Pattern.compile(
            "^[ \\t]*(?:(?:public|private|protected)\\s+)?"
                    + "(?:static\\s+final|final\\s+static)\\s+"
                    + "(?:int|long|double|float)\\s+"
                    + "([A-Z][A-Z0-9_]*)\\s*(?:=|$)");

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
        List<Path> files;
        try (Stream<Path> tree = Files.walk(root)) {
            files = tree.filter(Files::isRegularFile)
                    .filter(p -> p.toString().endsWith(".java"))
                    .sorted()
                    .toList();
        }
        for (Path file : files) {
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
            return String.valueOf(field.get(null));
        } catch (IllegalAccessException e) {
            throw new IllegalStateException("cannot read " + field, e);
        }
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

    /** Javadoc markup to the text a settings room can print: inline tags keep
     *  their subject, paragraph tags become blank lines, the rest goes. */
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
        text = text.replaceAll("<[^>]{1,40}>", "");
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
