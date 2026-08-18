package dev.spectroscope.core.provider;

import org.junit.jupiter.api.Test;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import java.util.stream.Stream;

import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.junit.jupiter.api.Assertions.fail;

/**
 * Every production {@link LlmProvider} answers every capability question — or
 * says here, once, why it does not.
 *
 * <h2>Why a source scan and not a normal test</h2>
 *
 * <p>The same hole has now been dug twice, by two different cards, in two
 * different wrappers. Card 252 added {@code vision()} and
 * {@code ServerLocalRuntime.SessionProvider} did not forward it; card 263 added
 * {@code contextWindow()} and {@code TracingProvider} did not forward it. Both
 * are FACADES over a live delegate, so the missing override is invisible: the
 * interface default answers "nothing known", which is a legal answer, and the
 * only symptom is a fence that never closes or a session that compacts at the
 * wrong number.</p>
 *
 * <p>A per-wrapper test cannot close that class of defect, because the next
 * wrapper is the one nobody writes a test for — and the wrappers are spread
 * across modules, so no single compiled test can even SEE them all
 * ({@code TracingProvider} lives in spectro-cli, {@code SessionProvider} in
 * spectro-server, and neither is visible from here). Reading the source is the
 * only seam that spans the repo. It is a coarse instrument on purpose: it does
 * not check that the forward is correct, only that a decision was made.</p>
 */
class LlmProviderCapabilityDriftTest {

    /** Every capability method on the interface that has a "nothing known"
     *  default, mapped to the signature a real implementation must declare. */
    private static final Map<String, String> CAPABILITIES = Map.of(
            "vision", "Vision vision()",
            "contextWindow", "int contextWindow()");

    /** Implementations that deliberately answer the defaults, with the reason.
     *  An entry here is a decision on the record, not an exemption granted to
     *  save work — adding one should feel like writing it down. */
    private static final Map<String, String> BY_DESIGN = Map.of(
            "AnthropicProvider.java",
            "the Anthropic API publishes no capability listing and no loaded window;"
                    + " its models are documented as sighted, and UNKNOWN sends the image"
                    + " anyway (LlmProvider#vision)");

    /** The repo root, found by the file that only it carries. */
    private static Path repoRoot() {
        Path here = Path.of("").toAbsolutePath();
        for (Path candidate = here; candidate != null; candidate = candidate.getParent()) {
            if (Files.exists(candidate.resolve("settings.gradle.kts"))) {
                return candidate;
            }
        }
        return fail("no settings.gradle.kts above " + here + " — the scan cannot run");
    }

    /** The modules that SHIP, read from the build rather than remembered — a
     *  module added tomorrow is scanned without anyone editing this file.
     *  {@code samples/} is deliberately outside: those files exist to show the
     *  smallest thing that compiles, and a sample provider answering the
     *  documented defaults is correct. */
    private static List<Path> shippedModules() throws IOException {
        String settings = Files.readString(repoRoot().resolve("settings.gradle.kts"));
        Matcher include = Pattern.compile("include\\(([^)]*)\\)").matcher(settings);
        List<Path> modules = new ArrayList<>();
        while (include.find()) {
            Matcher name = Pattern.compile("\"([^\"]+)\"").matcher(include.group(1));
            while (name.find()) {
                modules.add(repoRoot().resolve(name.group(1)));
            }
        }
        assertTrue(modules.size() >= 5, "settings.gradle.kts parsed to " + modules);
        return modules;
    }

    /** Every shipped source file that implements the provider interface. */
    private static List<Path> implementations() throws IOException {
        List<Path> found = new ArrayList<>();
        for (Path module : shippedModules()) {
            Path sources = module.resolve("src/main/java");
            if (!Files.isDirectory(sources)) {
                continue;
            }
            try (Stream<Path> tree = Files.walk(sources)) {
                for (Path file : tree.filter(Files::isRegularFile).toList()) {
                    if (file.toString().endsWith(".java")
                            && Files.readString(file).contains("implements LlmProvider")) {
                        found.add(file);
                    }
                }
            }
        }
        return found;
    }

    @Test
    void everyProviderAnswersEveryCapabilityOrIsListedAsAnsweringTheDefault() throws IOException {
        List<Path> implementations = implementations();

        // The scan itself is the first thing that can rot: a walk that finds
        // nothing passes every assertion below. So pin the population, by name.
        Set<String> names = implementations.stream()
                .map(path -> path.getFileName().toString())
                .collect(java.util.stream.Collectors.toSet());
        assertTrue(names.containsAll(Set.of(
                        "OpenAiCompatProvider.java", "OllamaProvider.java",
                        "AnthropicProvider.java", "SwitchableProvider.java",
                        "RetryingProvider.java", "TracingProvider.java",
                        "ServerLocalRuntime.java")),
                "the source scan lost sight of known implementations — found " + names);

        List<String> drifted = new ArrayList<>();
        for (Path file : implementations) {
            String name = file.getFileName().toString();
            String source = Files.readString(file);
            for (Map.Entry<String, String> capability : CAPABILITIES.entrySet()) {
                if (source.contains(capability.getValue())) {
                    continue;
                }
                if (BY_DESIGN.containsKey(name)) {
                    continue;
                }
                drifted.add(name + " does not answer " + capability.getKey() + "()");
            }
        }

        assertTrue(drifted.isEmpty(),
                "a provider inheriting a capability default answers \"nothing known\" and"
                        + " nothing anywhere goes red — that is how the fence stayed open"
                        + " for spectro-local sessions and how the window was lost in the"
                        + " CLI's trace wrapper. Either forward it or add it to BY_DESIGN"
                        + " with a reason: " + drifted);
    }

    @Test
    void anExemptionCarriesItsReason() {
        // The allowlist is the escape hatch, so it needs a lock of its own: an
        // empty reason would turn it into a silent opt-out.
        BY_DESIGN.forEach((name, reason) ->
                assertFalse(reason == null || reason.isBlank(),
                        name + " is exempted without saying why"));
    }
}
