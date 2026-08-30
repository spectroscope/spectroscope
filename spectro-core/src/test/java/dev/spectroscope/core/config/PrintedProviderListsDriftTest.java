package dev.spectroscope.core.config;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.junit.jupiter.api.Assumptions.assumeTrue;

import java.io.IOException;
import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.Locale;
import java.util.Set;
import java.util.TreeSet;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import org.junit.jupiter.api.Test;

/**
 * The provider names printed OUTSIDE the guide: the README table, the API
 * collection table, and the architecture figures.
 *
 * <p>Card 312, round 5. Round 4 edited all four of these by hand and left
 * every one of them guarded by nothing. Measured with the ordered bite — a
 * ninth provider ({@code "vllm"}) added to {@code SpectroConfig.KNOWN_PROVIDERS},
 * {@link SpectroConfig#endpointFor} and {@code isOpenAiCompat} and nowhere
 * else: the whole gate stayed green while the README's provider table, the
 * {@code /api/models} query note a REST client reads, and three shipped
 * architecture figures all said there were eight.</p>
 *
 * <p><b>Ids, not display names.</b> Each of these pages had grown its own
 * spelling — "LM Studio", "llama.cpp", "built-in" — so holding them to the
 * config would have needed a hand-typed table of aliases, which is the very
 * thing this card keeps finding. Round 5 put the ids back on the pages
 * instead: they are what a reader types into {@code settings.json} and what
 * the picker shows, and {@code built-in} in particular is not a value the
 * config accepts at all. The one display name left is named as a display name
 * ("the picker calls it built-in"), beside its id.</p>
 *
 * <p><b>Figures are guarded as ARTEFACTS, not as generators.</b> The
 * {@code build_NN_*.py} scripts are the source, but the tracked
 * {@code .svg} is what README embeds, what the guide inlines and what the two
 * PDFs print — a generator fixed and not re-run is exactly the shape that
 * shipped a stale figure into both editions. Both themes, because both are
 * tracked and the light one is the {@code <img>} README falls back to. The
 * collection table is the other way round: {@code endpoints.json} is the
 * INPUT of {@code build_api_collections.py}, and the Postman and Bruno files
 * are emitted from it, so the guard holds the input and a regeneration carries
 * it outward.</p>
 */
class PrintedProviderListsDriftTest {

    /** The README's provider chapter — the table a first reader meets. */
    private static final String README = "README.md";

    /** The endpoint table the four API collections are generated from. */
    private static final String ENDPOINTS = "docs/api-collections/endpoints.json";

    /** The architecture figure README embeds, in both tracked themes. */
    private static final List<String> OVERVIEW = svgPair("00-one-core-five-faces.svg");

    /** The deployment figure: the model side, host by host. */
    private static final List<String> DEPLOYMENT = svgPair("15-deployment.svg");

    /** The feature poster, whose foot names the backends. */
    private static final List<String> FEATURE_MAP = svgPair("20-feature-map.svg");

    /** English count words, so a printed "Eight backends" can be derived. */
    private static final List<String> COUNT_WORDS = List.of(
            "zero", "one", "two", "three", "four", "five", "six", "seven",
            "eight", "nine", "ten", "eleven", "twelve");

    private static List<String> svgPair(String name) {
        return List.of("docs/diagrams/" + name, "docs/diagrams/light/" + name);
    }

    /**
     * The README's provider table lists every backend the config accepts, and
     * its lead sentence counts them.
     *
     * <p>Bitten the ordered way — {@code "vllm"} into {@code KNOWN_PROVIDERS},
     * {@code endpointFor} and {@code isOpenAiCompat}, no documentation
     * touched:</p>
     *
     * <pre>
     * the "providers" chapter of README.md never names "vllm" — it is the
     * first table a reader meets, and it is missing a backend they can set.
     * </pre>
     */
    @Test
    void theReadmeProviderTableNamesEveryBackendAndCountsThemRight() throws IOException {
        assumeTrue(sourceCheckout(), "not running from a source checkout");
        String chapter = markdownChapter(read(README), "## providers");
        for (String provider : new TreeSet<>(SpectroConfig.knownProviders())) {
            assertTrue(chapter.contains("`" + provider + "`"),
                    "the \"providers\" chapter of " + README + " never names \"" + provider
                            + "\" as an id — it is the first table a reader meets, and a"
                            + " backend missing from it is one they never learn they can"
                            + " set.\n" + chapter);
        }
        assertCountWord(chapter, "chat providers", SpectroConfig.knownProviders().size(), README);
    }

    /**
     * The {@code /api/models} query note names every provider id the config
     * accepts — in {@code endpoints.json}, which is what the Postman, Bruno,
     * Insomnia and Hoppscotch collections are generated from.
     *
     * <p>The only test that reads this file is {@code WireDocDriftTest}, and it
     * guards caps and fencing, never the provider list — so the note claiming
     * to enumerate "any provider id SpectroConfig accepts" enumerated whatever
     * was true when it was last retyped.</p>
     */
    @Test
    void theApiCollectionsNoteNamesEveryProviderIdTheConfigAccepts() throws IOException {
        assumeTrue(sourceCheckout(), "not running from a source checkout");
        String note = lineContaining(read(ENDPOINTS), "any provider id SpectroConfig accepts");
        for (String provider : new TreeSet<>(SpectroConfig.knownProviders())) {
            assertTrue(note.contains(provider),
                    "the /api/models query note in " + ENDPOINTS + " promises \"any"
                            + " provider id SpectroConfig accepts\" and then does not name"
                            + " \"" + provider + "\". This file is the INPUT the four API"
                            + " collections are generated from: fix it here and re-run"
                            + " docs/api-collections/build_api_collections.py.\n" + note);
        }
    }

    /**
     * The two architecture figures that draw the OpenAI-compatible port name
     * every provider that speaks that wire.
     *
     * <p>Measured on round 5, by base64-decoding the inlined
     * {@code <img src="data:image/svg+xml">} figures out of both shipped guide
     * editions: four stale strings in each. Round 4 had updated the SIBLING
     * generator in the same directory and missed these two, so the card that
     * ADDS llamacpp shipped two figures drawing the provider port without it —
     * in both PDFs and in the image the README puts at the top of "how it is
     * built".</p>
     */
    @Test
    void theArchitectureFiguresNameEveryProviderThatSpeaksTheOpenAiWire() throws IOException {
        assumeTrue(sourceCheckout(), "not running from a source checkout");
        Set<String> compat = SpectroConfig.openAiCompatProviders();
        assertTrue(compat.size() >= 2, "no openai-compatible providers left to draw: " + compat);
        List<String> figures = new java.util.ArrayList<>(OVERVIEW);
        figures.addAll(DEPLOYMENT);
        for (String figure : figures) {
            String svg = read(figure);
            for (String provider : new TreeSet<>(compat)) {
                assertTrue(names(svg, provider),
                        figure + " draws the OpenAI-compatible provider port without naming"
                                + " \"" + provider + "\", which speaks exactly that wire."
                                + " The figure is the artefact: fix the generator in"
                                + " docs/diagrams/ and re-run it for BOTH themes"
                                + " (SPECTRO_DIAGRAM_THEME=light SPECTRO_DIAGRAM_OUTDIR=light),"
                                + " or the tracked SVG keeps shipping into the README, the"
                                + " guide and both PDFs.");
            }
        }
    }

    /**
     * The deployment figure's small print names the port of every LOCAL server
     * on the OpenAI-compatible port.
     *
     * <p>Its comment said "the four openai-compat hosts" over five, and the
     * line under it listed four addresses — llama-server's {@code :8080} was
     * the one missing, in the card that adds llama-server. Derived from
     * {@link SpectroConfig#presetEndpointFor}: a cloud host is spelled several
     * ways in a figure that has to fit them, but a loopback preset has a port
     * and the port is the whole address a reader needs.</p>
     *
     * <p>Scoped to that ONE line, found by openai's own preset host, and not to
     * the figure — measured while writing it: asked of the whole SVG the
     * assertion was green before the fix, because {@code :8080} is also the
     * port pill on spectro-server's own box three columns to the left. A
     * search wide enough to find the wrong thing is not a guard.</p>
     */
    @Test
    void theDeploymentFigureNamesThePortOfEveryLocalOpenAiCompatibleServer() throws IOException {
        assumeTrue(sourceCheckout(), "not running from a source checkout");
        List<String> ports = new java.util.ArrayList<>();
        for (String provider : new TreeSet<>(SpectroConfig.openAiCompatProviders())) {
            if (!SpectroConfig.keylessLocalServers().contains(provider)) {
                continue; // somebody's cloud: the figure spells those as hosts
            }
            URI preset = URI.create(SpectroConfig.presetEndpointFor(provider));
            if (preset.getPort() > 0) {
                ports.add(":" + preset.getPort());
            }
        }
        assertTrue(ports.size() >= 2,
                "no local OpenAI-compatible ports left to draw: " + ports);
        String cloudHost = URI.create(SpectroConfig.presetEndpointFor("openai")).getHost();
        for (String figure : DEPLOYMENT) {
            String hosts = svgTextContaining(read(figure), cloudHost, figure);
            for (String port : ports) {
                assertTrue(hosts.contains(port),
                        figure + "'s openai-compatible host line never names \"" + port
                                + "\" — a local server on that wire whose address the"
                                + " deployment figure does not print. Fix docs/diagrams/"
                                + "build_15_deployment.py and re-run it for both themes."
                                + "\n" + hosts);
            }
        }
    }

    /**
     * The feature poster's foot names every backend, and counts them.
     *
     * <p>It read "Seven backends: … LM Studio · llama.cpp, plus a built-in
     * catalogue" — right by accident on the day it was retyped, and held to
     * nothing. It now prints ids, so this can walk
     * {@link SpectroConfig#knownProviders()} instead of a table of spellings.</p>
     */
    @Test
    void theFeaturePosterFootNamesEveryBackendAndCountsThemRight() throws IOException {
        assumeTrue(sourceCheckout(), "not running from a source checkout");
        for (String figure : FEATURE_MAP) {
            String svg = read(figure);
            for (String provider : new TreeSet<>(SpectroConfig.knownProviders())) {
                assertTrue(names(svg, provider),
                        figure + "'s foot claims to name the backends and never names \""
                                + provider + "\". Fix docs/diagrams/build_20_feature_map.py"
                                + " and re-run it for both themes.");
            }
            assertCountWord(svg, "backends", SpectroConfig.knownProviders().size(), figure);
        }
    }

    // ------------------------------------------------------------- helpers

    /** The id as an id: not inside a longer word, so {@code openai} does not
     *  match {@code openai-compat} prose about the protocol. */
    private static boolean names(String text, String provider) {
        return Pattern.compile("(?<![A-Za-z0-9-])" + Pattern.quote(provider) + "(?![A-Za-z0-9-])")
                .matcher(text).find();
    }

    /**
     * Holds a printed "&lt;word&gt; {@code noun}" count to a computed number.
     * A count nobody can compute is how "Five provider ids" survived over a set
     * of eight; a count sentence that has MOVED must go red too, not quiet.
     */
    private static void assertCountWord(String text, String noun, int expected, String where) {
        assertTrue(expected < COUNT_WORDS.size(),
                "there are now " + expected + " providers and this test only spells up to "
                        + (COUNT_WORDS.size() - 1) + " — extend COUNT_WORDS");
        Matcher counted = Pattern.compile(
                "(?i)\\b([a-z]+)\\s+" + Pattern.quote(noun)).matcher(text);
        assertTrue(counted.find(),
                where + " no longer carries a \"<count> " + noun + "\" sentence at all — a"
                        + " drift test that cannot find its own subject must go red, not"
                        + " quiet");
        assertEquals(COUNT_WORDS.get(expected), counted.group(1).toLowerCase(Locale.ROOT),
                where + " counts its " + noun + " as \"" + counted.group(1) + "\" where the"
                        + " config accepts " + expected + " (" + SpectroConfig.KNOWN_PROVIDERS_DISPLAY
                        + "). The list under it may be right and the number still wrong —"
                        + " they are two facts and this is the second one");
    }

    /** The content of the ONE {@code <text>} element carrying {@code marker}. */
    private static String svgTextContaining(String svg, String marker, String where) {
        Matcher node = Pattern.compile("(?s)<text[^>]*>(.*?)</text>").matcher(svg);
        String found = null;
        while (node.find()) {
            if (node.group(1).contains(marker)) {
                assertTrue(found == null,
                        where + " has more than one <text> naming \"" + marker + "\", so"
                                + " this test can no longer say which line it is reading");
                found = node.group(1);
            }
        }
        assertTrue(found != null,
                where + " has no <text> naming \"" + marker + "\" at all — a drift test that"
                        + " cannot find its own subject must go red, not quiet");
        return found;
    }

    /** One markdown chapter: from its heading to the next heading of any level. */
    private static String markdownChapter(String markdown, String heading) {
        int start = markdown.indexOf(heading);
        assertTrue(start >= 0,
                "no \"" + heading + "\" heading in " + README + " — a drift test that cannot"
                        + " find its own subject must go red, not quiet");
        Matcher next = Pattern.compile("(?m)^#{1,6} ").matcher(markdown);
        int end = next.find(start + heading.length()) ? next.start() : markdown.length();
        return markdown.substring(start, end);
    }

    /** The whole line carrying {@code marker}. */
    private static String lineContaining(String text, String marker) {
        int at = text.indexOf(marker);
        assertTrue(at >= 0,
                "nothing in " + ENDPOINTS + " says \"" + marker + "\" any more — a drift test"
                        + " that cannot find its own subject must go red, not quiet");
        int start = text.lastIndexOf('\n', at) + 1;
        int end = text.indexOf('\n', at);
        return text.substring(start, end < 0 ? text.length() : end);
    }

    private static String read(String relative) throws IOException {
        Path file = repoRoot().resolve(relative);
        assertTrue(Files.isRegularFile(file),
                relative + " is gone — it is a tracked artefact this test exists to hold to"
                        + " the config, so its absence is a failure and not a skip");
        return Files.readString(file, StandardCharsets.UTF_8);
    }

    private static boolean sourceCheckout() {
        return Files.isDirectory(repoRoot().resolve("docs/diagrams"));
    }

    private static Path repoRoot() {
        Path here = Path.of("").toAbsolutePath();
        while (here != null && !Files.exists(here.resolve("settings.gradle.kts"))) {
            here = here.getParent();
        }
        return here == null ? Path.of("").toAbsolutePath() : here;
    }
}
