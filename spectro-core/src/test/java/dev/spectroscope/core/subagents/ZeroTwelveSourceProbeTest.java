package dev.spectroscope.core.subagents;

import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import javax.tools.Diagnostic;
import javax.tools.DiagnosticCollector;
import javax.tools.JavaCompiler;
import javax.tools.JavaFileObject;
import javax.tools.SimpleJavaFileObject;
import javax.tools.StandardJavaFileManager;
import javax.tools.ToolProvider;
import java.io.File;
import java.net.URI;
import java.nio.file.Path;
import java.util.List;
import java.util.stream.Collectors;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * Card 412, the Gherkin scenario: a class written for spectro-core 0.12.0
 * compiles against this tree, and the compiler reports a deprecation for
 * {@code ChildBudget.FLOOR_MS}.
 *
 * <p>The probe is compiled from a string with the JDK compiler against this
 * test's own classpath, so the check is what {@code javac} says about the
 * source a library user wrote, and a missing member shows up as a failed
 * assertion that quotes the compiler rather than as a test class that does
 * not build. The source uses the 0.12.0 members the release comparison found
 * missing (kanban/evidence/release-0.13.0/api-diff-0.12.0-vs-37b60018.txt):
 * the 13 argument {@link SubagentConfig} constructor and
 * {@code ChildBudget.FLOOR_MS}.</p>
 */
class ZeroTwelveSourceProbeTest {

    /** A library class as it could have been written against 0.12.0. */
    private static final String WRITTEN_FOR_0_12_0 = """
            package probe;

            import dev.spectroscope.core.subagents.ChildBudget;
            import dev.spectroscope.core.subagents.SubagentConfig;
            import java.nio.file.Path;
            import java.util.List;

            public class WrittenFor0120 {
                public static SubagentConfig config() {
                    return new SubagentConfig(request -> List.of(), Path.of("."), "main",
                            request -> true, List.of(), null, null, List.of(),
                            ChildBudget.fixed(45_000L), 5_000, 40, 2_048, Boolean.TRUE);
                }

                public static long floor() {
                    return ChildBudget.FLOOR_MS;
                }
            }
            """;

    @Test
    void aClassWrittenFor0120CompilesAndIsToldThatFloorMsIsDeprecated(@TempDir Path out) {
        JavaCompiler javac = ToolProvider.getSystemJavaCompiler();
        assertNotNull(javac, "the test JVM carries no compiler, so this probe cannot run");
        DiagnosticCollector<JavaFileObject> heard = new DiagnosticCollector<>();
        String classpath = System.getProperty("java.class.path") + File.pathSeparator
                + codeSourceOf(SubagentConfig.class);

        boolean compiled;
        try (StandardJavaFileManager files = javac.getStandardFileManager(heard, null, null)) {
            compiled = javac.getTask(null, files, heard,
                    List.of("-classpath", classpath, "-d", out.toString(), "-Xlint:deprecation"),
                    null, List.of(new StringSource("probe.WrittenFor0120", WRITTEN_FOR_0_12_0)))
                    .call();
        } catch (java.io.IOException e) {
            throw new IllegalStateException(e);
        }

        String report = heard.getDiagnostics().stream()
                .map(d -> d.getKind() + " " + d.getCode() + " line " + d.getLineNumber() + ": "
                        + d.getMessage(null))
                .collect(Collectors.joining("\n"));
        List<Diagnostic<? extends JavaFileObject>> errors = heard.getDiagnostics().stream()
                .filter(d -> d.getKind() == Diagnostic.Kind.ERROR)
                .collect(Collectors.toList());
        assertEquals(List.of(), errors.stream().map(d -> d.getMessage(null)).toList(),
                "code written for 0.12.0 no longer compiles:\n" + report);
        assertTrue(compiled, "javac reported failure:\n" + report);

        // javac files a deprecation under MANDATORY_WARNING, not WARNING.
        boolean floorDeprecated = heard.getDiagnostics().stream()
                .anyMatch(d -> d.getKind() == Diagnostic.Kind.MANDATORY_WARNING
                        && d.getCode().equals("compiler.warn.has.been.deprecated")
                        && d.getMessage(null).contains("FLOOR_MS"));
        assertTrue(floorDeprecated, "the compiler did not report FLOOR_MS as deprecated:\n" + report);
    }

    private static String codeSourceOf(Class<?> type) {
        try {
            return Path.of(type.getProtectionDomain().getCodeSource().getLocation().toURI()).toString();
        } catch (java.net.URISyntaxException e) {
            throw new IllegalStateException(e);
        }
    }

    /** One compilation unit held in memory. */
    private static final class StringSource extends SimpleJavaFileObject {
        private final String code;

        StringSource(String className, String code) {
            super(URI.create("string:///" + className.replace('.', '/') + Kind.SOURCE.extension),
                    Kind.SOURCE);
            this.code = code;
        }

        @Override
        public CharSequence getCharContent(boolean ignoreEncodingErrors) {
            return code;
        }
    }
}
