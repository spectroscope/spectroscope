package dev.spectroscope.server.session;

import com.fasterxml.jackson.databind.ObjectMapper;
import dev.spectroscope.core.browser.BrowserFace;
import dev.spectroscope.core.browser.BrowserFaces;
import dev.spectroscope.core.config.SpectroConfig;
import dev.spectroscope.core.events.RunEvent;
import dev.spectroscope.core.session.SessionStore;
import dev.spectroscope.core.wire.BrowserWireRecorder;

import org.junit.jupiter.api.Test;

import java.util.ArrayList;
import java.util.List;
import java.util.UUID;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * What "closed" means for a session's browser (card 218).
 *
 * <p>The owner's rule is "es lebt bis die session geschlossen wird", and this
 * file is where the product answers WHICH event that is: the session's socket
 * going away — the same event that already cancels its run, releases its parked
 * permission questions and lets its live-session id go. The stored transcript
 * survives it and so does the session id; the browser does not, because a
 * browser is live state — a logged-in page, a cookie jar, a scroll position —
 * and not a record.
 *
 * <p>The Gradle test task points {@code user.home} into the build directory, so
 * the session files below never touch the real home.</p>
 */
class SessionBrowserLifetimeTest {

    private static final ObjectMapper JSON = new ObjectMapper();

    @Test
    void closingASessionClosesItsOwnBrowser() {
        String id = storedSession();
        Directory browsers = new Directory();
        SessionConnection connection = new SessionConnection(
                new FakeSocket("ws-1", "ws://localhost/ws?resume=" + id),
                JSON, config(), id, null, null);
        connection.useBrowser(browsers);
        connection.start();

        connection.onClose();

        assertThat(browsers.closed)
                .as("the session's browser is closed with the session, by its own id")
                .containsExactly(id);
    }

    @Test
    void aSessionThatNeverStartedHasNoBrowserToClose() {
        // The store is minted on the first prompt. A socket that opened, showed
        // the rail and closed again never had an id, so there is nothing to name
        // — and naming something would mean guessing.
        Directory browsers = new Directory();
        SessionConnection connection = new SessionConnection(
                new FakeSocket("ws-2", "ws://localhost/ws"), JSON, config(), null, null, null);
        connection.useBrowser(browsers);
        connection.start();

        connection.onClose();

        assertThat(browsers.closed).isEmpty();
    }

    @Test
    void aConnectionWithNoDirectoryBehavesAsThoughTheBrowserNeverExisted() {
        String id = storedSession();
        SessionConnection connection = new SessionConnection(
                new FakeSocket("ws-3", "ws://localhost/ws?resume=" + id),
                JSON, config(), id, null, null);
        connection.useBrowser(null);
        connection.start();

        connection.onClose();   // the empty directory closes nothing and throws nothing
    }

    @Test
    void aResumedSessionRecordsUnderTheSameIdAndTheNextBrowserEpoch() {
        // Card 204's half of card 218's rule. The browser is retired when the
        // session closes and a resume opens a new one — under the SAME session
        // id, appending to the SAME sidecar. The recorder therefore has to claim
        // the next epoch, or a replay would narrate two logins as one.
        String id = storedSession();
        Directory browsers = new Directory();

        SessionConnection first = new SessionConnection(
                new FakeSocket("ws-4", "ws://localhost/ws?resume=" + id),
                JSON, config(), id, null, null);
        first.useBrowser(browsers);
        first.start();
        BrowserWireRecorder firstRecorder = first.browserWire();
        assertThat(firstRecorder).as("a resumed session opens its browser record too").isNotNull();
        assertThat(firstRecorder.file()).isEqualTo(BrowserWireRecorder.fileFor(id));
        firstRecorder.open("browser_navigate", "main", "t1",
                JSON.createObjectNode().put("url", "https://one.example"), null)
                .end(true, "Opened https://one.example.", "https://one.example");
        assertThat(firstRecorder.epoch()).isEqualTo(1);
        first.onClose();

        SessionConnection second = new SessionConnection(
                new FakeSocket("ws-5", "ws://localhost/ws?resume=" + id),
                JSON, config(), id, null, null);
        second.useBrowser(browsers);
        second.start();
        BrowserWireRecorder secondRecorder = second.browserWire();
        assertThat(secondRecorder).isNotNull();
        secondRecorder.open("browser_navigate", "main", "t2",
                JSON.createObjectNode().put("url", "https://two.example"), null)
                .end(true, "Opened https://two.example.", "https://two.example");
        assertThat(secondRecorder.epoch())
                .as("the second browser of one session's life is the second epoch")
                .isEqualTo(2);
        second.onClose();
    }

    @Test
    void aSessionThatNeverStartedOpensNoBrowserRecord() {
        SessionConnection connection = new SessionConnection(
                new FakeSocket("ws-6", "ws://localhost/ws"), JSON, config(), null, null, null);
        connection.start();
        assertThat(connection.browserWire())
                .as("no id yet means no file to write under")
                .isNull();
        connection.onClose();
    }

    /** A BrowserFaces that records instead of driving anything. */
    private static final class Directory implements BrowserFaces {
        private final List<String> closed = new ArrayList<>();

        @Override
        public boolean attached() {
            return true;
        }

        @Override
        public BrowserFace forSession(String sessionId) {
            return BrowserFace.none();
        }

        @Override
        public void closeSession(String sessionId) {
            closed.add(sessionId);
        }
    }

    /** A stored session on disk, so {@code ?resume=} has something to load. */
    private static String storedSession() {
        String id = "test-" + UUID.randomUUID().toString().substring(0, 8);
        SessionStore store = new SessionStore(id);
        store.append(new RunEvent.RunStart("r1", "main", null, "hi", null, null, 1L));
        store.append(new RunEvent.RunEnd("r1", "end_turn", 2L));
        return id;
    }

    private static SpectroConfig config() {
        return SpectroConfig.load(SpectroConfig.Overrides.none());
    }
}
