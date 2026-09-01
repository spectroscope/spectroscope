package dev.spectroscope.server.browser;

import org.junit.jupiter.api.Test;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * Card 337, as a guard over the source rather than a rule somebody remembers.
 *
 * <p><b>The defect this exists to stop coming back.</b> Nine branches of {@code
 * launchPlay}/{@code runPlay} each ended in {@code send(socket, played(…))} and
 * nothing else, so a failed launch was a frame on one socket and nowhere else:
 * not a {@code RunEvent}, not the session file, not the sidecar. Card 337 gave
 * the press one exit — {@code answer(…)} — that does all three. A tenth branch
 * written next to the nine would reopen the hole silently, and the behavioural
 * tests next door cannot see a branch nobody wrote a case for.
 *
 * <p><b>What this measures, stated narrowly.</b> It counts how many places in
 * the file BUILD a {@code launch_played} frame. That is a proxy for "every
 * outcome is recorded", not the thing itself: a line could call {@code answer}
 * with the wrong facts, and this would not notice. What it does catch is the
 * shape the defect actually had — a {@code played(…)} handed straight to {@code
 * send} — and it catches it at the moment somebody writes it.
 */
class BrowserViewSocketSourceTest {

    private static final String SOCKET =
            "spectro-server/src/main/java/dev/spectroscope/server/browser/BrowserViewSocket.java";

    /** {@code played(} wherever the source spells it, declaration included. */
    private static final Pattern BUILDS_A_FRAME =
            Pattern.compile("(?<![A-Za-z0-9_$])played\\s*\\(");

    /**
     * Three mentions and no more, and each one is accounted for: the method that
     * declares the frame, the single branch where there is no session on this
     * server to record against, and the ONE exit that records and sends it.
     *
     * <p>The middle one is not an exemption granted to make the count work. {@code
     * bridge.live(sessionId) == null} means the session is not open here at all —
     * no store, no sidecar, no {@code emit} — so the frame is the only place its
     * sentence can go, and a test that pretended otherwise would be demanding a
     * recording into nothing.
     */
    @Test
    void everyLaunchPlayedFrameComesFromTheOneExitOrTheOneBranchWithNothingToRecordInto()
            throws IOException {
        String code = stripComments(source());
        int mentions = 0;
        Matcher found = BUILDS_A_FRAME.matcher(code);
        while (found.find()) {
            mentions++;
        }
        assertEquals(3, mentions,
                "a launch_played frame is built in " + mentions + " places. Card 337 gave"
                        + " the play button one exit — answer(…) — which sends the frame,"
                        + " closes the sidecar line AND emits the run event. A frame built"
                        + " anywhere but there and the live == null branch is an outcome"
                        + " the work panel, the trace and the session file will never hear"
                        + " about, which is the defect this card was cut for");
        assertTrue(code.contains("private static ObjectNode played("),
                "the declaration is one of the three; if it were renamed this count would"
                        + " be measuring something else entirely");
        String guards = methodBody(code, "private void launchPlay(");
        assertEquals(1, framesBuiltIn(guards),
                "the second is the one branch with no session to record into: " + guards);
        assertTrue(guards.contains("this session is not open on this server"),
                "and it is THAT branch — a frame built in launchPlay for any other reason"
                        + " has a live session to record against and must use the exit: "
                        + guards);
        assertEquals(1, framesBuiltIn(methodBody(code, "private void answer(Play play")),
                "and the third is the single exit");
    }

    /**
     * And the exit really does all three things, so the count above is a proxy
     * for something rather than for nothing.
     *
     * <p>A count of three would still be three if {@code answer} had quietly lost its
     * emit — the branch guard and the behaviour it guards are different claims,
     * and this is the cheap half of the second one. {@code
     * BrowserViewSocketTest} measures it by running a play.
     */
    @Test
    void theOneExitSendsTheFrameClosesTheRecordAndEmitsTheEvent() throws IOException {
        String body = methodBody(stripComments(source()), "private void answer(Play play");
        assertTrue(body.contains("played("), "the operator's frame: " + body);
        assertTrue(body.contains(".record().end("), "the sidecar line: " + body);
        assertTrue(body.contains(".emit().accept("), "the run event: " + body);
    }

    /** How many {@code played(…)} frames one stretch of source builds. */
    private static int framesBuiltIn(String region) {
        int built = 0;
        Matcher found = BUILDS_A_FRAME.matcher(region);
        while (found.find()) {
            built++;
        }
        return built;
    }

    /**
     * One method's body, from its signature to the first brace closed at class
     * indentation.
     *
     * <p>Crude on purpose and stated as such: it would end early on a nested
     * class or a text block that opens a line with four spaces and a brace, and
     * this file carries neither. What it must not be is a search for a LINE —
     * two methods here open a {@code live == null} branch, and a reader that
     * took the first found the wrong one and read a region with no frame in it
     * at all.
     *
     * @param code      the source with comments stripped
     * @param signature the method's declaration, as the source spells it
     * @return everything from the signature to the closing brace
     */
    private static String methodBody(String code, String signature) {
        int at = code.indexOf(signature);
        assertTrue(at > 0, signature + " is gone or renamed; this file guards nothing");
        int end = code.indexOf("\n    }", at);
        assertTrue(end > at, signature + " never closes at class indentation");
        return code.substring(at, end);
    }

    /** The source of the class under guard. */
    private static String source() throws IOException {
        Path file = repoRoot().resolve(SOCKET);
        assertTrue(Files.isRegularFile(file), "not where this test looks: " + file);
        return Files.readString(file, StandardCharsets.UTF_8);
    }

    /** Comments stripped, so prose about {@code played(…)} cannot pass or fail this. */
    private static String stripComments(String source) {
        return source.replaceAll("(?s)/\\*.*?\\*/", "").replaceAll("(?m)//.*$", "");
    }

    /** The repository root, found by the file that only it carries. */
    private static Path repoRoot() {
        Path dir = Path.of(System.getProperty("user.dir")).toAbsolutePath();
        while (dir != null && !Files.isRegularFile(dir.resolve("settings.gradle.kts"))) {
            dir = dir.getParent();
        }
        assertTrue(dir != null, "no settings.gradle.kts above " + System.getProperty("user.dir"));
        return dir;
    }
}
