package dev.spectroscope.core.config.governing;

import com.fasterxml.jackson.core.type.TypeReference;
import com.fasterxml.jackson.core.util.DefaultIndenter;
import com.fasterxml.jackson.core.util.DefaultPrettyPrinter;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.Test;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.Set;
import java.util.TreeSet;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * The registry is the source tree, or the build is red — card 357 criterion 4.
 *
 * <p>Every other test in this file is a property of the numbers. THIS one is
 * the card: the shipped registry is regenerated from
 * {@code spectro-core/src/main/java} on every run and compared byte for byte,
 * so a 77th constant cannot appear in the source without appearing on the
 * settings room, and a number that moves cannot leave a stale value behind.
 * The canon's most-repeated defect is a hand-list guarded by a test that types
 * the same hand-list — found three times in one card (312) and again in 314.
 * Nothing in this file types a constant's value, its unit or its reason.</p>
 *
 * <p><b>Regenerating:</b> run the suite with {@code -Dgoverning.rewrite=true}.
 * It writes the resource and then fails on purpose, so the flag cannot be left
 * on in a green build.</p>
 */
class GoverningNumbersDriftTest {

    /** Where the generated registry is checked in. */
    private static final String RESOURCE = "spectro-core/src/main/resources/governing/numbers.json";

    /**
     * A floor under the walk, not a total. A scan that finds NOTHING passes
     * every assertion below it, so the population is pinned — but as a floor,
     * because a total in prose is the number this house has watched go wrong
     * four times.
     */
    private static final int AT_LEAST = 100;

    @Test
    void theShippedRegistryIsWhatTheSourceTreeSaysToday() throws IOException {
        List<GoverningNumber> scanned = GoverningScan.scan();
        Path resource = GoverningScan.repoRoot().resolve(RESOURCE);

        if (Boolean.getBoolean("governing.rewrite")) {
            Files.createDirectories(resource.getParent());
            Files.writeString(resource, render(scanned));
            throw new AssertionError("registry rewritten from the source tree ("
                    + scanned.size() + " constants) — re-run without -Dgoverning.rewrite");
        }

        assertTrue(Files.isRegularFile(resource), RESOURCE + " is missing — the settings room"
                + " reads it at runtime and a javadoc is not in the bytecode");
        String shipped = Files.readString(resource);
        List<GoverningNumber> read = new ObjectMapper()
                .readValue(shipped, new TypeReference<List<GoverningNumber>>() { });

        Set<String> onlyInSource = names(scanned);
        onlyInSource.removeAll(names(read));
        Set<String> onlyInRegistry = names(read);
        onlyInRegistry.removeAll(names(scanned));
        assertEquals(Set.of(), onlyInSource, "constants the source declares and the registry"
                + " does not carry — a number nobody can see is not observable, which is the"
                + " whole card; regenerate with -Dgoverning.rewrite=true");
        assertEquals(Set.of(), onlyInRegistry, "constants the registry carries and the source"
                + " no longer declares — the room would print a number that is not in the build");

        assertEquals(render(scanned), shipped, "the registry drifted from the source in a value,"
                + " a kind, a unit or an explanation — regenerate with -Dgoverning.rewrite=true");
    }

    @Test
    void theWalkFoundTheTreeAndNotAnEmptyDirectory() throws IOException {
        List<GoverningNumber> scanned = GoverningScan.scan();
        assertTrue(scanned.size() >= AT_LEAST,
                "the scan found " + scanned.size() + " constants, under the floor of " + AT_LEAST
                        + " — a walk that finds nothing passes every other assertion here");
        assertTrue(names(scanned).contains("dev.spectroscope.core.subagents.SubagentManager"
                        + "#MAX_PARALLEL_CHILDREN"),
                "the walk lost the constant card 357 was written about");
    }

    @Test
    void whatIsLoadedAtRuntimeIsWhatIsCheckedIn() throws IOException {
        assertEquals(GoverningScan.scan(), GoverningNumbers.all(),
                "the classpath resource the settings room reads is not the one this build's"
                        + " source produces — the room would answer for a different jar");
    }

    @Test
    void everyClassifiedNumberBringsItsOwnExplanation() {
        List<String> mute = GoverningNumbers.all().stream()
                .filter(number -> number.explanation().isBlank())
                .map(number -> number.ownerSimpleName() + "#" + number.field())
                .toList();
        assertEquals(List.of(), mute, "a classified number that says nothing about itself."
                + " For a governing one the operator meets it as an error message with nowhere"
                + " to read about it; for plumbing and aliases the silence is worse, because"
                + " the EXCLUSION is then taste rather than a stated rule (card 357 criterion"
                + " 6). Write the javadoc — the scan lifts it, nobody types it twice");
    }

    @Test
    void onlyTheReachableOnesNameAKey() {
        for (GoverningNumber number : GoverningNumbers.all()) {
            String at = number.ownerSimpleName() + "#" + number.field();
            if (number.kind() == Governs.Kind.SETTABLE) {
                assertFalse(number.key().isBlank(), at + " is settable and names no key — the"
                        + " entry says 'you can change this' and does not say where");
            } else {
                assertTrue(number.key().isBlank(), at + " is " + number.kind() + " and names a"
                        + " key anyway; only SETTABLE may, or the page promises a control that"
                        + " does not reach the number");
            }
        }
    }

    @Test
    void aUnitIsForNumbersThatMeanSomething() {
        for (GoverningNumber number : GoverningNumbers.all()) {
            String at = number.ownerSimpleName() + "#" + number.field();
            if (number.governs()) {
                assertTrue(number.unit() != Governs.Unit.NONE,
                        at + " governs a run and counts nothing — a bare number on the page is"
                                + " the guess the card exists to remove");
            }
        }
    }

    @Test
    void theOneThatAdmitsItIsAGuessIsStillOnTheBoard() {
        List<GoverningNumber> unexamined = GoverningNumbers.governing().stream()
                .filter(number -> number.kind() == Governs.Kind.UNEXAMINED)
                .toList();
        assertFalse(unexamined.isEmpty(), "no constant is classified UNEXAMINED any more."
                + " That is either a win worth writing down or a kind somebody quietly"
                + " retired — the backlog is the valuable half of this page");
        assertTrue(unexamined.stream().anyMatch(number ->
                        number.explanation().contains("nobody has measured")),
                "the UNEXAMINED entries no longer carry the sentence that made them"
                        + " unexamined — the kind became a label instead of a quotation");
    }

    private static Set<String> names(List<GoverningNumber> numbers) {
        Set<String> out = new TreeSet<>();
        for (GoverningNumber number : numbers) {
            out.add(number.owner() + "#" + number.field());
        }
        return out;
    }

    /** The one rendering of the registry, used to write it and to hold it. */
    private static String render(List<GoverningNumber> numbers) throws IOException {
        DefaultIndenter indenter = new DefaultIndenter("  ", "\n");
        DefaultPrettyPrinter printer = new DefaultPrettyPrinter()
                .withObjectIndenter(indenter)
                .withArrayIndenter(indenter);
        return new ObjectMapper().writer(printer).writeValueAsString(numbers) + "\n";
    }
}
