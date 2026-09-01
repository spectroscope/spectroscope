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
 * so a further constant cannot appear in the source without appearing on the
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

    @Test
    void theShapeSeesEveryNumericConstantTheTreeDeclares() throws IOException {
        // Review finding F1. The shape used to match four primitives, and the
        // three sentences advertising it said "every numeric static final" —
        // so 19 Duration timeouts, an int[] ladder and a short sat outside a
        // registry that claimed to hold everything. A reviewer proved it by
        // adding one of each and watching this file stay green.
        //
        // Widening the shape fixes today. THIS fixes the next one: the excluded
        // type names are derived from the source, and each is resolved and
        // asked whether it is a number. Nothing is typed here — a hand-list of
        // "families we mean to skip" is the shape the canon names as two copies
        // of the same lie.
        List<String> numericAndUnseen = GoverningScan.unseenTypes().stream()
                .filter(type -> isNumeric(resolve(type)))
                .toList();
        assertEquals(List.of(), numericAndUnseen, "the source declares constants of a NUMERIC"
                + " type that the governing shape does not match, so they reach no registry and"
                + " no settings room. Either widen GoverningScan.NUMERIC_TYPE and classify them,"
                + " or — if they genuinely govern nothing — say so where the reader can see it."
                + " A family the shape skips in silence is indistinguishable from a tree that"
                + " has none, which is exactly how the Duration timeouts stayed invisible");
    }

    @Test
    void aValueReachesThePageAsANumberAndNotAsAnObjectsToString() throws IOException {
        // Widening the shape brought in two types whose toString is not a
        // value: a Duration prints PT20S, an array prints its identity hash.
        // The hash is the worse of the two — it differs on every run, so the
        // byte compare above would fail for a reason that has nothing to do
        // with the source.
        assertEquals("20", GoverningScan.render(java.time.Duration.ofSeconds(20)));
        assertEquals("25", GoverningScan.render(java.time.Duration.ofSeconds(25)));
        assertEquals("1500", GoverningScan.render(java.time.Duration.ofMillis(1500)));
        assertEquals("[2576, 1568, 1024]", GoverningScan.render(new int[] {2576, 1568, 1024}));
        assertEquals("4", GoverningScan.render(4));

        List<String> odd = GoverningNumbers.all().stream()
                .filter(number -> number.value().contains("@")
                        || number.value().matches("P(T.*)?"))
                .map(number -> number.ownerSimpleName() + "#" + number.field()
                        + " = " + number.value())
                .toList();
        assertEquals(List.of(), odd, "an entry's value is an object's toString rather than a"
                + " number — an operator cannot weigh it against the unit beside it, and an"
                + " identity hash would make this resource differ on every run");
    }

    @Test
    void anExplanationReachesTheRoomAsTextAndNotAsMarkup() {
        // Review finding F4. flatten's javadoc said "the rest goes" while the
        // code stripped tags of one to forty characters, so a link tag of
        // fifty-six survived. Fixed at the source; pinned here from both ends.
        assertEquals("see the reference", GoverningScan.flatten(
                "see <a href=\"https://platform.openai.com/docs/api-reference\">the</a> reference"));
        // ...and the length bound was really protecting prose like this, which
        // is why the fix is a shape and not the removal of the bound.
        assertEquals("a < b && c > d", GoverningScan.flatten("a &lt; b &amp;&amp; c &gt; d"));

        List<String> markup = GoverningNumbers.all().stream()
                .filter(number -> number.explanation().matches("(?s).*(</?[A-Za-z][^>]*>|\\{@|&[a-z]+;).*"))
                .map(number -> number.ownerSimpleName() + "#" + number.field())
                .toList();
        assertEquals(List.of(), markup, "an explanation still carries javadoc markup. React"
                + " prints it verbatim, so the operator meets angle brackets where the code's"
                + " own words should be");
    }

    /** The class behind a declared type name, or null when nothing resolves it.
     *  Deliberately tries the JDK packages a constant's type would come from —
     *  a project type that resolves to nothing cannot be a JDK number. */
    private static Class<?> resolve(String typeName) {
        String bare = typeName.replaceAll("<.*", "").replaceAll("\\[]$", "");
        for (String prefix : new String[] {"", "java.lang.", "java.util.", "java.time.",
                "java.math.", "java.util.concurrent.atomic.", "java.util.concurrent."}) {
            try {
                return Class.forName(prefix + bare);
            } catch (ClassNotFoundException notThisOne) {
                continue;
            }
        }
        return null;
    }

    /** Whether a resolved type holds a quantity — a {@link Number}, a primitive,
     *  or an amount of time. The one question the exclusion has to answer. */
    private static boolean isNumeric(Class<?> type) {
        return type != null
                && (Number.class.isAssignableFrom(type)
                        || java.time.temporal.TemporalAmount.class.isAssignableFrom(type)
                        || type.isPrimitive());
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
