package dev.spectroscope.core.config;

import org.junit.jupiter.api.Test;

import java.io.IOException;
import java.lang.reflect.Field;
import java.lang.reflect.Modifier;
import java.lang.reflect.RecordComponent;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Arrays;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Set;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import java.util.stream.Collectors;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.junit.jupiter.api.Assumptions.assumeTrue;

/**
 * The config record against every hand-copy of its key list (card 232, slice 1).
 *
 * <p>{@link SpectroConfig}'s record components are the one truth about which
 * settings keys exist. Until this test, three in-repo copies restated that
 * truth by hand — {@code SettingsWriter.KNOWN_KEYS}, the provenance probes
 * ({@code FIELD_PROBES}), {@code PartialConfig}'s field list — and a fourth
 * lives in the published config reference's key table. Each copy was pinned
 * only by a comment, and one of them has already shipped a silent defect:
 * card 203's review found the Settings page's one working save path answering
 * "unknown settings key" with the whole suite green, because nothing held
 * {@code KNOWN_KEYS} to the record ({@code SettingsWriterTest} records the
 * incident verbatim).</p>
 *
 * <p>This test derives the expected set reflectively, so component 27 turns
 * every unregistered copy red the day it is added — before any review reads
 * the diff. Full evidence: {@code konzept/CODE-REVIEW-2026-08-14.md},
 * finding 2.</p>
 */
class KnownKeysDriftTest {

    /** The one allowed foreign row in the doc table: the CLI-side {@code tts}
     *  block rides the same settings file, the core deliberately ignores it
     *  ({@code PartialConfig} is {@code ignoreUnknown}), and {@code
     *  SettingsWriter.patch} refuses it — so it is documented without being a
     *  record component. Anything else foreign in the table is drift. */
    private static final Set<String> DOC_ONLY_KEYS = Set.of("tts");

    private static final Path REFERENCE =
            Path.of("docs/guide-assets/parts/18-ref-config-build.html");

    /** The record's own components, in declaration order — the single source
     *  every assertion below compares against. */
    private static List<String> recordKeys() {
        return Arrays.stream(SpectroConfig.class.getRecordComponents())
                .map(RecordComponent::getName)
                .toList();
    }

    @Test
    void settingsWriterAcceptsExactlyTheRecordsKeys() {
        // The card-203-F2 class: a key missing HERE makes the settings API
        // refuse a component that loads fine, and no other test notices.
        assertEquals(Set.copyOf(recordKeys()), SettingsWriter.knownKeys(),
                "SettingsWriter.KNOWN_KEYS no longer mirrors SpectroConfig's record"
                        + " components — a key in the record and not in the writer is a"
                        + " silent refusal on the settings API (card 203 F2), a key in the"
                        + " writer and not in the record is accepted and then ignored");
    }

    @Test
    void provenanceProbesCoverEveryComponentInRecordOrder() {
        // Order included: FIELD_PROBES' own javadoc promises record-component
        // order, and the settings page renders the probes as given.
        assertEquals(recordKeys(), SpectroConfig.fieldProbeNames(),
                "SpectroConfig.FIELD_PROBES drifted from the record components — a"
                        + " component without a probe resolves fine but reports no origin,"
                        + " so the settings page shows a value nobody can trace to a layer");
    }

    @Test
    void partialConfigCarriesOneFieldPerComponent() {
        Set<String> fields = Arrays.stream(SpectroConfig.PartialConfig.class.getDeclaredFields())
                .filter(field -> !Modifier.isStatic(field.getModifiers()) && !field.isSynthetic())
                .map(Field::getName)
                .collect(Collectors.toSet());
        assertEquals(Set.copyOf(recordKeys()), fields,
                "PartialConfig's fields no longer mirror SpectroConfig's record"
                        + " components — a component without a partial field cannot be set"
                        + " from ANY settings layer, and Jackson's ignoreUnknown means no"
                        + " load ever says so");
    }

    @Test
    void workspaceForbiddenKeysAreRealRecordKeys() {
        // A typo in a ProcessGlobal's key string would leave the read-side
        // probe working and the write-side name check dead — the fence would
        // refuse the load but let the settings API write the key anyway.
        List<String> forbidden = SpectroConfig.workspaceScopeForbiddenKeys();
        assertTrue(Set.copyOf(recordKeys()).containsAll(forbidden),
                "the workspace-scope refusal list names keys that are not record"
                        + " components: " + forbidden.stream()
                                .filter(key -> !recordKeys().contains(key)).toList());
    }

    @Test
    void theDocTableListsExactlyTheRecordsKeys() throws IOException {
        // ConfigDocDriftTest already holds the chapter lead to the table's row
        // COUNT; this holds the rows themselves to the record, so the count
        // can no longer be right about the wrong keys.
        Path source = source();
        assumeTrue(source != null, "not running from a source checkout");
        String reference = Files.readString(source);

        int table = reference.indexOf("id=\"ch-config-keys\"");
        assertTrue(table > 0, "the \"Every key\" table has moved or lost its anchor");
        String keyTable = reference.substring(table, reference.indexOf("</table>", table));

        Set<String> documented = new LinkedHashSet<>();
        int rows = 0;
        Matcher row = Pattern.compile("<tr><td><code>([^<]+)</code>").matcher(keyTable);
        while (row.find()) {
            documented.add(row.group(1));
            rows++;
        }

        // Card 368, criterion 4. A SET dedupes itself, so the comparison below
        // is blind to a duplicated row by construction — and that is not
        // hypothetical: on 2026-09-01 a merge took an overlapping region twice
        // and put a second maxTurns and a second maxRetries in the table. This
        // test said nothing; only ConfigDocDriftTest's row COUNT spoke, in
        // another file, about another fact. Deduping by hand then kept the wrong
        // one of the two maxTurns rows — int · 15 against a shipped 150 — and it
        // shipped through a full green gate. Counting here costs one int and
        // means the only guard that reads this table's CONTENTS can no longer be
        // fooled by the same row twice.
        assertEquals(documented.size(), rows,
                "the \"Every key\" table has " + rows + " rows for " + documented.size()
                        + " distinct keys, so at least one key has two rows. The set"
                        + " comparison below cannot see that — a set dedupes itself — and a"
                        + " duplicate is how a wrong default survived a green gate once"
                        + " already (card 368). Which key: " + duplicatesIn(keyTable));

        Set<String> documentedComponents = new LinkedHashSet<>(documented);
        documentedComponents.removeAll(DOC_ONLY_KEYS);
        assertEquals(Set.copyOf(recordKeys()), documentedComponents,
                "the config reference's \"Every key\" table drifted from the record"
                        + " components (the CLI-side " + DOC_ONLY_KEYS + " row is the one"
                        + " allowed foreigner) — a key shipped without a row is a refusal"
                        + " or a setting the reader cannot look up");
    }

    /** The keys the table lists more than once — for the failure message only,
     *  so a duplicate names itself instead of leaving a count to be diffed.
     *  @param keyTable the "Every key" table's markup
     *  @return the repeated keys, in the order they first appear */
    private static List<String> duplicatesIn(String keyTable) {
        List<String> seen = new java.util.ArrayList<>();
        List<String> twice = new java.util.ArrayList<>();
        Matcher row = Pattern.compile("<tr><td><code>([^<]+)</code>").matcher(keyTable);
        while (row.find()) {
            String key = row.group(1);
            if (!seen.add(key) || java.util.Collections.frequency(seen, key) > 1) {
                if (!twice.contains(key)) {
                    twice.add(key);
                }
            }
        }
        return twice;
    }

    private static Path source() {
        Path root = repoRoot();
        if (root == null) {
            return null;
        }
        Path reference = root.resolve(REFERENCE);
        return Files.isRegularFile(reference) ? reference : null;
    }

    /** Walks up to the directory holding the Gradle settings file — same
     *  recipe as {@code ConfigDocDriftTest}, which reads the same chapter. */
    private static Path repoRoot() {
        for (Path candidate = Path.of("").toAbsolutePath();
                candidate != null; candidate = candidate.getParent()) {
            if (Files.isRegularFile(candidate.resolve("settings.gradle.kts"))) {
                return candidate;
            }
        }
        return null;
    }
}
