package dev.spectroscope.core.config;

import org.junit.jupiter.api.Test;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;

import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.junit.jupiter.api.Assumptions.assumeTrue;

/**
 * Card 453, criterion 9: the user guide names every permission mode where it
 * lists them, and says that a workspace scope may not set {@code extended}.
 * The mode list comes from {@link SpectroConfig#knownPermissionModes()}; the
 * built editions are checked too, because the reader opens those.
 */
class ExtendedModeDocDriftTest {

    private static final String PARTS = "docs/guide-assets/parts/";

    private static Path repoRoot() {
        for (Path candidate = Path.of("").toAbsolutePath();
                candidate != null; candidate = candidate.getParent()) {
            if (Files.isRegularFile(candidate.resolve("settings.gradle.kts"))) {
                return candidate;
            }
        }
        return null;
    }

    private static String read(String relative) throws IOException {
        Path root = repoRoot();
        assumeTrue(root != null, "not running from a source checkout");
        return Files.readString(root.resolve(relative));
    }

    /** The slice of {@code html} from {@code anchor} to the end of the next table. */
    private static String tableAfter(String html, String anchor) {
        int at = html.indexOf(anchor);
        assertTrue(at >= 0, "anchor " + anchor + " has moved");
        int end = html.indexOf("</table>", at);
        assertTrue(end > at, "no table after " + anchor);
        return html.substring(at, end);
    }

    @Test
    void theModeTableOfChapterThirteenListsEveryKnownMode() throws IOException {
        String table = tableAfter(read(PARTS + "10-control.html"), "id=\"ch-control-modes\"");
        for (String mode : SpectroConfig.knownPermissionModes()) {
            assertTrue(table.contains("<tr><td><code>" + mode + "</code></td>"),
                    "the mode table has no row for " + mode);
        }
    }

    @Test
    void theConfigReferenceRowNamesEveryModeAndTheWorkspaceRefusal() throws IOException {
        String html = read(PARTS + "18-ref-config-build.html");
        int cell = html.indexOf("<tr><td><code>permissionMode</code></td>");
        assertTrue(cell > 0, "no permissionMode row");
        String row = html.substring(cell, html.indexOf("</tr>", cell));
        for (String mode : SpectroConfig.knownPermissionModes()) {
            assertTrue(row.contains("<code>" + mode + "</code>"), "the row does not name " + mode);
        }
        assertTrue(row.contains("workspace scope"),
                "the row must say a workspace scope may not set extended: " + row);
    }

    @Test
    void theCommandLineChaptersNameExtended() throws IOException {
        assertTrue(read(PARTS + "03-cli.html").contains("--permissions readonly|auto|extended"));
        assertTrue(read(PARTS + "11b-fleet.html").contains("<code>extended</code>"));
        assertTrue(read(PARTS + "12-providers-senses.html").contains("readonly (default) | auto | extended"));
    }

    @Test
    void theBuiltEditionsCarryTheExtendedRow() throws IOException {
        for (String edition : List.of("docs/USER-GUIDE.html", "docs/USER-GUIDE-LIGHT.html")) {
            assertTrue(read(edition).contains("<tr><td><code>extended</code></td>"),
                    edition + " lags the parts; rebuild it with docs/guide-assets/build_user_guide.py");
        }
    }

    @Test
    void theToolsChapterSaysWhatTheLaunchFileRefusalDoesInExtended() throws IOException {
        // Review finding 4: in extended the refusal covers any folder's launch
        // file, subfolders of cwd included, which is wider than in auto.
        String tools = read(PARTS + "09-tools.html");
        assertTrue(!tools.contains("the launch file refusal stay as they are"),
                "the chapter still claims the launch file refusal is unchanged");
        assertTrue(tools.contains("any folder"), "the chapter must say the refusal covers any folder");
    }
}
