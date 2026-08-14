package dev.spectroscope.core.config;

import org.junit.jupiter.api.Test;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;

import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.junit.jupiter.api.Assumptions.assumeTrue;

/**
 * The published config reference against the config record.
 *
 * <p>Card 193 added two settings fields and two environment variables and
 * touched no documentation at all, so the guide chapter a reader consults to
 * find out where LM Studio lives listed neither — and its {@code baseUrl} row
 * still promised that "an explicit URL always wins", which is exactly what
 * stopped being true for the two local-model providers.</p>
 *
 * <p>Same shape as {@code HeapBudgetDocDriftTest} and {@code WireDocDriftTest}:
 * when a fact is restated in files that cannot import each other, the test has
 * to go and look. The field list is read off {@link SpectroConfig}'s record
 * components, so a THIRD per-provider address turns this red the day it is
 * added rather than the day someone notices.</p>
 */
class ConfigDocDriftTest {

    private static final Path REFERENCE =
            Path.of("docs/guide-assets/parts/18-ref-config-build.html");

    /** Every per-provider address component — the shared legacy field excluded. */
    private static List<String> addressFields() {
        List<String> fields = new ArrayList<>();
        for (var component : SpectroConfig.class.getRecordComponents()) {
            String name = component.getName();
            if (name.endsWith("BaseUrl") && !"baseUrl".equals(name)) {
                fields.add(name);
            }
        }
        return fields;
    }

    /** The SPECTRO_* variable a field's env layer really reads. */
    private static String envVarFor(String field) {
        return "SPECTRO_" + field.replaceAll("([A-Z])", "_$1").toUpperCase(Locale.ROOT);
    }

    @Test
    void everyPerProviderAddressIsPublishedAsAKeyAndAsAVariable() throws IOException {
        Path source = source();
        assumeTrue(source != null, "not running from a source checkout");
        String reference = Files.readString(source);

        List<String> fields = addressFields();
        assertFalse(fields.isEmpty(),
                "no per-provider address components found — the reflection above went stale");
        for (String field : fields) {
            // A row of its OWN, not a passing mention inside another row's prose.
            assertTrue(reference.contains("<tr><td><code>" + field + "</code></td>"),
                    "the config reference has no row for the settings key \"" + field
                            + "\" — the one chapter a reader consults to find out where a"
                            + " local provider lives (card 193)");
            assertTrue(reference.contains(envVarFor(field)),
                    "the config reference does not name " + envVarFor(field)
                            + ", the environment form of \"" + field + "\"");
        }
    }

    @Test
    void theSharedBaseUrlRowAdmitsThatTheLocalProvidersOutrankIt() throws IOException {
        Path source = source();
        assumeTrue(source != null, "not running from a source checkout");
        String row = rowStartingWith(Files.readString(source), "<code>baseUrl</code>");

        for (String field : addressFields()) {
            assertTrue(row.contains(field),
                    "the baseUrl row promises the reader an explicit URL always wins, and"
                            + " for the providers that own \"" + field + "\" it does not:"
                            + " endpointFor takes the per-provider field first, whatever"
                            + " layer either value came from. Row: " + row);
        }
    }

    @Test
    void theChapterOpensWithTheNumberOfKeysItActuallyLists() throws IOException {
        Path source = source();
        assumeTrue(source != null, "not running from a source checkout");
        String reference = Files.readString(source);

        int table = reference.indexOf("id=\"ch-config-keys\"");
        String keyTable = reference.substring(table, reference.indexOf("</table>", table));
        int rows = keyTable.split("<tr><td><code>", -1).length - 1;

        // The lead said "seventeen" while the table listed twenty, and card 193
        // then added two more. A count in prose drifts the moment anyone edits
        // the thing it counts, so it carries its own measurement from here on.
        assertTrue(reference.contains(rows + " keys"),
                "the chapter lead does not say \"" + rows + " keys\", which is what the"
                        + " \"Every key\" table now lists");
    }

    @Test
    void theChapterSaysWhichSettingsReachAnOpenSessionAndWhichDoNot() throws IOException {
        // Card 222. The owner saved a SearXNG address, /api/config reported the
        // new tier, and the next search in the same window used the old one. The
        // page and the reference between them said nothing about WHEN a saved
        // setting lands, and the silence is what made a right answer unusable.
        // Whatever the answer, the reference has to carry it: this is the
        // chapter a reader consults before they go and change something.
        Path source = source();
        assumeTrue(source != null, "not running from a source checkout");
        String reference = Files.readString(source);

        for (String live : List.of("searxngUrl", "imageModel", "chromeBinary", "allowLocalhost")) {
            assertTrue(reference.contains(live),
                    "the config reference does not name \"" + live + "\" among the settings"
                            + " a running session picks up on its next tool call");
        }
        assertTrue(reference.contains("already have open") || reference.contains("already open"),
                "the reference never says that a saved setting reaches the session already"
                        + " open — which is the promise card 222 exists to make good");
        for (String fixed : List.of("MCP servers", "shell hooks", "system prompt", "allowlist")) {
            assertTrue(reference.contains(fixed),
                    "the reference does not name \"" + fixed + "\" among the things that stay"
                            + " settled for the session — a list that names only the live half"
                            + " leaves the reader guessing about the other one");
        }
        // The review's criterion-2 correction. The first version of this
        // chapter called provider and model "the header picker's", which is
        // true of the picker and NOT of this page: a model saved here was
        // measured not to reach the open session, while the page's own note
        // said it applied immediately. The reference has to carry both halves,
        // or the next reader re-derives the wrong one.
        assertTrue(reference.contains("applies from the next session"),
                "the reference never says that the provider pair saved on the settings page"
                        + " waits for the next session — the half the review measured");
        assertTrue(reference.contains("picker"),
                "and it must name the picker as the live path, or the limitation reads as a"
                        + " dead end");
        for (String pageBound : List.of("Provider, model", "thinking")) {
            assertTrue(reference.contains(pageBound),
                    "the reference does not name \"" + pageBound + "\" among the settings that"
                            + " land with the next session");
        }
    }

    @Test
    void everyKeyAWorkspaceScopeMayNotHoldSaysSoInItsOwnRow() throws IOException {
        // Card 222, review finding F2. The refusal is loud at load time — the
        // whole scope is dropped and the message names the file — so the one
        // thing an operator needs is somewhere to look it up. Two of the five
        // keys were added by this card, and one of them (searxngUrl) had no row
        // in this table at all: it was refusable and unpublished in the same
        // edit, which is how a fence becomes a mystery.
        //
        // Driven off the list itself, so a SIXTH key cannot be added in silence.
        Path source = source();
        assumeTrue(source != null, "not running from a source checkout");
        String reference = Files.readString(source);

        List<String> forbidden = SpectroConfig.workspaceScopeForbiddenKeys();
        assertTrue(forbidden.size() >= 5,
                "the workspace-scope refusal list shrank to " + forbidden
                        + " — a key leaving it is a security decision, not a cleanup");
        for (String key : forbidden) {
            String row = rowStartingWith(reference, "<code>" + key + "</code>");
            assertTrue(row.contains("workspace scope"),
                    "a workspace scope is refused when it sets \"" + key + "\" and the config"
                            + " reference's row for it never says so. Row: " + row);
        }
    }

    /** The row holding {@code marker} inside the "Every key" table — the
     *  deprecation table above it names the same keys in its own cells. */
    private static String rowStartingWith(String html, String marker) {
        int table = html.indexOf("id=\"ch-config-keys\"");
        assertTrue(table > 0, "the \"Every key\" table has moved or lost its anchor");
        int cell = html.indexOf(marker, table);
        assertTrue(cell > 0, "no table cell containing " + marker);
        int start = html.lastIndexOf("<tr>", cell);
        int end = html.indexOf("</tr>", cell);
        assertTrue(start >= 0 && end > start, "unbalanced table row around " + marker);
        return html.substring(start, end);
    }

    private static Path source() {
        for (Path candidate = Path.of("").toAbsolutePath();
                candidate != null; candidate = candidate.getParent()) {
            if (Files.isRegularFile(candidate.resolve("settings.gradle.kts"))) {
                Path reference = candidate.resolve(REFERENCE);
                return Files.isRegularFile(reference) ? reference : null;
            }
        }
        return null;
    }
}
