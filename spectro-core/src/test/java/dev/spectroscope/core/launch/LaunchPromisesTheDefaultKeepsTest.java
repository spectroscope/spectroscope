package dev.spectroscope.core.launch;

import dev.spectroscope.core.browser.BrowserFace;
import dev.spectroscope.core.net.NetFence;
import dev.spectroscope.core.tools.Tool;
import org.junit.jupiter.api.Test;

import java.io.IOException;
import java.net.InetAddress;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.junit.jupiter.api.Assumptions.assumeTrue;

/**
 * Shipped text against shipped behaviour (card 202, house rule from cards 193
 * and 203).
 *
 * <p>This is not a nit. {@code launch_start} points the browser at the address
 * it started — except on loopback, which every launch configuration measured on
 * this machine produces, 58 of 58, because the net fence refuses localhost until
 * {@code allowLocalhost} is opted into. Three shipped sentences promised the
 * page anyway: the model-facing description of {@code launch_start}, the line in
 * {@code docs/BROWSER.md} that sends a reader here, and the opening paragraph of
 * {@code docs/LAUNCH.md} — which then explains the fence honestly four sections
 * further down, four sections too late. A model that believes the first reports
 * a page it never saw; a reader who believes the others files a bug against a
 * working fence.
 *
 * <p>The rule the tests below enforce is one rule: <b>wherever the text promises
 * the browser follows, the same breath names the condition.</b> Removing a
 * qualifier turns them red; rewording a promise does not slip past, because the
 * promise is matched by pattern rather than by literal.
 */
class LaunchPromisesTheDefaultKeepsTest {

    /** Any way the docs have phrased "and then you are looking at the app". */
    private static final Pattern PROMISE = Pattern.compile(
            "browser\\b[^.]{0,90}?(?:is already looking at it|looking at it|looks at it"
                    + "|opens on it|opens on the port)");

    /** The words that turn a promise into a true one. */
    private static final Pattern CONDITION = Pattern.compile(
            "allowLocalhost|opted into|opt-in|opt into|fence");

    /** How far from a promise the condition still counts as the same breath. */
    private static final int SAME_BREATH = 250;

    // ---- the premise ---------------------------------------------------------

    /** The verdict a fresh install actually gives the address a launch file produces. */
    @Test
    void theShippedDefaultReallyDoesRefuseTheAddressALaunchFileProduces() throws Exception {
        NetFence shipped = new NetFence(false,
                host -> List.of(InetAddress.getByName("127.0.0.1")));
        String address = new LaunchEntry("web", 5173, "npm", List.of("run", "dev"), null, List.of())
                .address();
        assertNotNull(shipped.refuse(address),
                "the premise of this whole class: the fence refuses " + address
                        + " under the shipped allowLocalhost default, so any text that promises "
                        + "a page without naming the opt-in is false out of the box");
    }

    // ---- what the model is told ----------------------------------------------

    /** The model plans against this description, so it carries the condition. */
    @Test
    void theStartDescriptionNamesTheOptInItDependsOn() {
        LaunchSupervisor supervisor = new LaunchSupervisor((host, port) -> true);
        String description = new LaunchTools(supervisor, BrowserFace::none,
                () -> new NetFence(false, host -> List.of()))
                .all().stream()
                .filter(tool -> tool.name().equals("launch_start"))
                .map(Tool::description)
                .findFirst().orElseThrow();
        supervisor.close();

        assertTrue(description.contains("allowLocalhost"),
                "launch_start tells the model the browser follows, so it must name the setting "
                        + "that decides whether it does: " + description);
        assertTrue(description.contains("localhost") || description.contains("loopback"),
                "and which addresses that applies to: " + description);
    }

    // ---- what the reader is told ---------------------------------------------

    /**
     * {@code docs/BROWSER.md} sends a reader to the launch page in one line, and
     * that line used to end "and the browser opens on it" with nothing on it.
     */
    @Test
    void theBrowserPageDoesNotPromiseAPageTheFenceWillRefuse() throws IOException {
        assertEveryPromiseCarriesItsCondition("docs/BROWSER.md");
    }

    /** The same rule on the launch page, including its opening paragraph. */
    @Test
    void theLaunchPageIsHonestWhereItPromisesAndNotOnlyInItsFenceSection() throws IOException {
        assertEveryPromiseCarriesItsCondition("docs/LAUNCH.md");
    }

    /** Every promise in one page, each measured against the text around it. */
    private static void assertEveryPromiseCarriesItsCondition(String relative) throws IOException {
        Path page = repoRoot() == null ? null : repoRoot().resolve(relative);
        assumeTrue(page != null && Files.isRegularFile(page), "not running from a source checkout");

        String text = unwrapped(Files.readString(page));
        Matcher promises = PROMISE.matcher(text);
        while (promises.find()) {
            String breath = text.substring(Math.max(0, promises.start() - SAME_BREATH),
                    Math.min(text.length(), promises.end() + SAME_BREATH));
            assertTrue(CONDITION.matcher(breath).find(),
                    relative + " promises the browser ends up on the app and does not name the "
                            + "condition anywhere near it. Every address a launch configuration "
                            + "produces is loopback and allowLocalhost defaults to false, so out "
                            + "of the box this does not happen: …" + breath.strip() + "…");
        }
    }

    /** The document on one line, so a sentence broken by wrapping reads as one sentence. */
    private static String unwrapped(String markdown) {
        return markdown.replaceAll("\\s*\\n\\s*", " ").replace("**", "");
    }

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
