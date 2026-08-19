package dev.spectroscope.core.config;

import org.junit.jupiter.api.Test;

import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.HexFormat;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import java.util.stream.Stream;

import static org.junit.jupiter.api.Assertions.assertEquals;
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
 *
 * <p>The last two tests follow that fact outward past the chapter it lives in:
 * first into the two assembled HTML editions, then into the two PDFs printed
 * from them. Each hop was added because the one before it went green over an
 * artefact a reader would actually have opened.</p>
 */
class ConfigDocDriftTest {

    private static final Path REFERENCE =
            Path.of("docs/guide-assets/parts/18-ref-config-build.html");

    /** What each tracked PDF was printed from, written by the rebuild ritual. */
    private static final Path PDF_STAMP = Path.of("docs/guide-assets/pdf-stamp.txt");

    /** Where both shipped editions live, as {@code .html} and printed {@code .pdf}. */
    private static final Path DOCS = Path.of("docs");

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
    void theChapterCarriesTheOneConditionOnTheLivePromise() throws IOException {
        // Card 222, review finding F5. The live promise has exactly one
        // exception, and this is the second round in which it went unwritten.
        // The image BACKEND has a live control of its own — the composer's
        // dropdown — and a pick there outranks a file saved under it for the
        // rest of the session. Worse, until this round the APP sent that pick
        // itself, on a plain reconnect, so the exception applied with nobody
        // having chosen anything. The exception is gone from the app and stated
        // here, because a promise with a silent condition is the exact shape of
        // the defect this card was opened for.
        Path source = source();
        assumeTrue(source != null, "not running from a source checkout");
        String reference = Files.readString(source);

        // Scoped to the paragraph that makes the promise, not to the whole
        // chapter: "sttProvider" appears in the 25-row key table further down,
        // and an assertion the table already satisfies would have measured
        // nothing. The first draft of this test did exactly that and passed
        // against the unedited file.
        String promise = paragraphContaining(reference, "When a saved setting lands");
        for (String live : List.of("sttProvider", "sttLanguage")) {
            assertTrue(promise.contains(live),
                    "the live-promise paragraph does not name \"" + live + "\" — the settings"
                            + " page saves it and the transcription route reads it per request."
                            + " Paragraph: " + promise);
        }

        String exception = paragraphContaining(reference, "outranks a saved");
        assertTrue(exception.contains("composer") && exception.contains("imageProvider"),
                "the chapter never says that the COMPOSER's image-backend dropdown outranks a"
                        + " saved imageProvider for the rest of the session — the one condition"
                        + " on the promise above it, and the one the app used to trigger by"
                        + " itself. Paragraph: " + exception);
    }

    /** The one {@code <p>} carrying {@code marker}, so an assertion about a
     *  sentence cannot be satisfied by a table elsewhere in the chapter.
     *  @param html   the reference chapter
     *  @param marker text that appears in the wanted paragraph and nowhere else
     *  @return the paragraph's markup, or "" when the marker is absent */
    private static String paragraphContaining(String html, String marker) {
        int at = html.indexOf(marker);
        if (at < 0) {
            return "";
        }
        int open = html.lastIndexOf("<p>", at);
        int close = html.indexOf("</p>", at);
        return open < 0 || close < 0 ? "" : html.substring(open, close);
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

    @Test
    void theBuiltEditionsCarryWhatThisChapterNowSays() throws IOException {
        // Card 220's review, the one blocker: this test reads the PART, the
        // reader gets the assembled EDITION, and nothing tied the two together.
        // The part gained the headlessMcp row and a re-counted lead while
        // USER-GUIDE.html still said "26 keys" and named the switch nowhere —
        // the gate was green over a guide that lied. The editions ship in-tree,
        // so the tie is a read: the built guide must carry the count this test
        // computes and the key card 220 added. When this goes red after a part
        // edit, the fix is the rebuild ritual in build_user_guide.py's
        // docstring: python3 build_user_guide.py (and --light), then the
        // Chrome print for each PDF.
        Path source = source();
        assumeTrue(source != null, "not running from a source checkout");
        int rows = keyRowCount(Files.readString(source));

        Path root = repoRoot();
        for (String name : List.of("docs/USER-GUIDE.html", "docs/USER-GUIDE-LIGHT.html")) {
            Path built = root.resolve(name);
            assertTrue(Files.isRegularFile(built),
                    name + " is gone — the assembled editions are tracked, and this"
                            + " test is what keeps them from lagging the parts");
            String edition = Files.readString(built);
            assertTrue(edition.contains(rows + " keys"),
                    name + " does not say \"" + rows + " keys\", which is what the"
                            + " config reference part now lists — the edition lags the"
                            + " parts; rebuild it (docs/guide-assets/build_user_guide.py,"
                            + " both themes, then the PDFs)");
            assertTrue(edition.contains("headlessMcp"),
                    name + " never names headlessMcp — the switch that widens an"
                            + " unattended run is in the part and not in the guide a"
                            + " reader actually opens; rebuild it"
                            + " (docs/guide-assets/build_user_guide.py, both themes,"
                            + " then the PDFs)");
        }
    }

    @Test
    void everyTrackedPdfWasPrintedFromTheHtmlEditionAsItStandsNow() throws Exception {
        // The test above ties the two HTML editions to the parts, and its own
        // failure message ends "then the PDFs" — so the PDFs were known to need
        // the same rebuild, and nothing anywhere said when they had not had it.
        // Measured 2026-08-19 while building cards 281/282: one added config key
        // moved the chapter lead from "31 keys" to "32 keys", the HTML guard went
        // red at once, and the two 23 MB PDFs would have shipped saying 31 with
        // nothing red anywhere. They were reprinted only because a person
        // happened to run `git ls-files docs/ | grep pdf`.
        //
        // Reading the PDFs is NOT the way to check this. Their text lives in
        // FlateDecode content streams as positioned glyph runs, so "32 keys" is
        // not a substring of the inflated bytes either, and a scan over 23 MB
        // costs more than the whole module's suite. What is cheap and exact is
        // the digest of the SOURCE recorded beside the print it produced: two
        // reads and a hash, no PDF parsing at all.
        // Keyed on the same source-checkout marker as every test above, and
        // deliberately NOT on the artefacts themselves: an assumption naming
        // docs/USER-GUIDE.html would turn "someone deleted an edition" from a
        // failure into a skip, which is the one answer this test must never give.
        assumeTrue(source() != null, "not running from a source checkout");
        Path root = repoRoot();

        Path stampFile = root.resolve(PDF_STAMP);
        assertTrue(Files.isRegularFile(stampFile),
                PDF_STAMP + " is missing — it records which HTML edition each tracked"
                        + " PDF was printed from, and it is the only thing standing"
                        + " between a stale 23 MB download and a green gate. Write it:"
                        + " cd docs/guide-assets && python3 build_user_guide.py --stamp");
        Map<String, String> stamp = readStamp(stampFile);

        // Discovered rather than listed, the way the forbidden-key test above
        // reads its own list: a THIRD edition printed into docs/ is guarded the
        // day it lands, instead of being the one PDF nothing watches.
        List<String> editions = editions(root);
        assertEquals(List.of("USER-GUIDE", "USER-GUIDE-LIGHT"), editions,
                "the set of tracked PDF editions in docs/ has changed. That is fine —"
                        + " but each one needs its own three lines in " + PDF_STAMP
                        + " (python3 build_user_guide.py --stamp), and this list is"
                        + " here so the change cannot pass unread");

        for (String edition : editions) {
            Path html = root.resolve(DOCS).resolve(edition + ".html");
            Path pdf = root.resolve(DOCS).resolve(edition + ".pdf");
            assertTrue(Files.isRegularFile(html),
                    "docs/" + edition + ".pdf has no docs/" + edition + ".html beside"
                            + " it — a PDF whose source is not in the tree cannot be"
                            + " checked against anything");

            // The measured failure: the part moves, the HTML is rebuilt, the
            // print is not repeated. Everything else here guards the record.
            assertEquals(stamp.get(edition + ".source.sha256"), sha256(html),
                    "docs/" + edition + ".html has changed since docs/" + edition
                            + ".pdf was printed from it, so the PDF a reader downloads"
                            + " still says what the guide said before that edit."
                            + " Reprint it (the Chrome command in the docstring of"
                            + " docs/guide-assets/build_user_guide.py), then record the"
                            + " print: python3 build_user_guide.py --stamp");

            assertEquals(stamp.get(edition + ".printed"), printedAt(pdf),
                    "docs/" + edition + ".pdf is not the print " + PDF_STAMP + " names:"
                            + " its own /CreationDate disagrees. The stamp is a record of"
                            + " a specific print, so re-run python3 build_user_guide.py"
                            + " --stamp rather than editing it by hand");

            assertEquals(stamp.get(edition + ".bytes"), Long.toString(Files.size(pdf)),
                    "docs/" + edition + ".pdf is " + Files.size(pdf) + " bytes where "
                            + PDF_STAMP + " records " + stamp.get(edition + ".bytes")
                            + " — a Chrome print that never finished still exits 0 and"
                            + " still leaves a file that opens, so the length is checked"
                            + " rather than trusted");
        }
    }

    /** Every printed edition in {@code docs/}, read off the directory itself. */
    private static List<String> editions(Path root) throws IOException {
        assertTrue(Files.isDirectory(root.resolve(DOCS)),
                "there is no docs/ directory in this checkout at all");
        try (Stream<Path> files = Files.list(root.resolve(DOCS))) {
            return files.map(file -> file.getFileName().toString())
                    .filter(name -> name.endsWith(".pdf"))
                    .map(name -> name.substring(0, name.length() - ".pdf".length()))
                    .sorted()
                    .toList();
        }
    }

    /** The {@code key=value} lines of the stamp, {@code #} comments dropped. */
    private static Map<String, String> readStamp(Path stamp) throws IOException {
        Map<String, String> values = new HashMap<>();
        for (String line : Files.readAllLines(stamp)) {
            String trimmed = line.strip();
            if (trimmed.isEmpty() || trimmed.startsWith("#")) {
                continue;
            }
            int split = trimmed.indexOf('=');
            assertTrue(split > 0, PDF_STAMP + " has a line that is not key=value: " + trimmed);
            values.put(trimmed.substring(0, split), trimmed.substring(split + 1));
        }
        return values;
    }

    /** SHA-256 of a file, streamed — the editions are ~13 MB each. */
    private static String sha256(Path file) throws IOException, NoSuchAlgorithmException {
        MessageDigest digest = MessageDigest.getInstance("SHA-256");
        byte[] buffer = new byte[1 << 20];
        try (InputStream in = Files.newInputStream(file)) {
            for (int read; (read = in.read(buffer)) > 0; ) {
                digest.update(buffer, 0, read);
            }
        }
        return HexFormat.of().formatHex(digest.digest());
    }

    /**
     * The {@code /CreationDate} headless Chrome wrote into the PDF's Info
     * dictionary.
     *
     * <p>Skia writes that dictionary as object 1, uncompressed, inside the first
     * kilobyte of the file, so this is one short read and never touches a
     * content stream. It is also the one timestamp that survives a clone: a
     * file's mtime is whatever the checkout wrote, in index order, and would
     * make this guard say different things on two machines.</p>
     *
     * @param pdf a tracked edition
     * @return the raw date string, e.g. {@code D:20260819191326+00'00'}
     */
    private static String printedAt(Path pdf) throws IOException {
        byte[] head = new byte[2048];
        int read;
        try (InputStream in = Files.newInputStream(pdf)) {
            read = in.readNBytes(head, 0, head.length);
        }
        String text = new String(head, 0, read, StandardCharsets.ISO_8859_1);
        Matcher date = Pattern.compile("/CreationDate \\(([^)]*)\\)").matcher(text);
        assertTrue(date.find(),
                pdf.getFileName() + " carries no /CreationDate in its first " + read
                        + " bytes — it did not come from the headless Chrome print in"
                        + " build_user_guide.py's docstring");
        return date.group(1);
    }

    /** Rows of the "Every key" table — the one count the lead must restate. */
    private static int keyRowCount(String reference) {
        int table = reference.indexOf("id=\"ch-config-keys\"");
        String keyTable = reference.substring(table, reference.indexOf("</table>", table));
        return keyTable.split("<tr><td><code>", -1).length - 1;
    }

    private static Path source() {
        Path root = repoRoot();
        if (root == null) {
            return null;
        }
        Path reference = root.resolve(REFERENCE);
        return Files.isRegularFile(reference) ? reference : null;
    }

    /** Walks up to the directory holding the Gradle settings file. */
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
