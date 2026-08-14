package dev.spectroscope.server.browser;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import dev.spectroscope.core.browser.BrowserFace;
import dev.spectroscope.core.browser.BrowserFaces;
import dev.spectroscope.core.browser.headless.HeadlessBrowserFace;
import dev.spectroscope.core.browser.headless.HeadlessBrowserFaces;
import dev.spectroscope.server.session.FakeSocket;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.nio.file.Path;
import java.util.List;
import java.util.Optional;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.function.Consumer;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * One browser per session, never two engines racing (card 226, criterion 5).
 *
 * <p>The desktop pane and the headless engine are two implementations of one
 * seam, and a session must see exactly one of them. The rule is the owner's
 * shape of it: when the desktop pane IS attached, it wins — the web engine
 * serves only readers the desktop cannot reach.
 */
class PrecedenceBrowserFacesTest {

    private static final ObjectMapper JSON = new ObjectMapper();

    /** A CDP endpoint that answers every call with an empty object. */
    static final class QuietCdp implements HeadlessBrowserFace.Cdp {
        final List<String> called = new CopyOnWriteArrayList<>();
        final java.util.Map<String, List<Consumer<JsonNode>>> listeners =
                new java.util.concurrent.ConcurrentHashMap<>();

        @Override
        public JsonNode call(String method, JsonNode params) {
            called.add(method);
            if ("Page.navigate".equals(method)) {
                listeners.getOrDefault("Page.loadEventFired", List.of())
                        .forEach(l -> l.accept(JSON.createObjectNode()));
            }
            return JSON.createObjectNode();
        }

        @Override
        public void on(String method, Consumer<JsonNode> listener) {
            listeners.computeIfAbsent(method, unused -> new CopyOnWriteArrayList<>())
                    .add(listener);
        }

        @Override
        public void close() {
        }
    }

    private static HeadlessBrowserFaces headless(Path base, List<Path> killed) {
        return new HeadlessBrowserFaces(() -> Optional.of(Path.of("/usr/bin/true")), base,
                url -> null, (sessionId, profileDir) -> new HeadlessBrowserFaces.Engine() {
                    @Override
                    public HeadlessBrowserFace.Cdp cdp() {
                        return new QuietCdp();
                    }

                    @Override
                    public void kill() {
                        killed.add(profileDir);
                    }
                });
    }

    /** A desktop directory whose faces are recognisable by their error text. */
    private static BrowserFaces desktopStub() {
        return new BrowserFaces() {
            @Override
            public boolean attached() {
                return true;
            }

            @Override
            public BrowserFace forSession(String sessionId) {
                return new BrowserFace() {
                    @Override
                    public boolean attached() {
                        return true;
                    }

                    @Override
                    public String pageUrl() {
                        return "desktop://" + sessionId;
                    }

                    @Override
                    public Reply send(String verb, JsonNode args) {
                        return Reply.ok(JSON.createObjectNode().put("face", "desktop"), null);
                    }
                };
            }

            @Override
            public void closeSession(String sessionId) {
            }
        };
    }

    @Test
    void theDesktopWinsWheneverItsShellIsAttached(@TempDir Path base) {
        AtomicBoolean shellUp = new AtomicBoolean(true);
        PrecedenceBrowserFaces faces = new PrecedenceBrowserFaces(
                desktopStub(), shellUp::get, headless(base, new CopyOnWriteArrayList<>()));
        assertEquals("desktop://s-1", faces.forSession("s-1").pageUrl());
        assertEquals("desktop", faces.live());

        shellUp.set(false);
        BrowserFace.Reply reply = faces.forSession("s-1").send("navigate",
                JSON.createObjectNode().put("url", "http://dev.example.com/"));
        assertTrue(reply.ok(), () -> String.valueOf(reply.error()));
        assertEquals("web", faces.live(), "no shell means the web engine serves");
    }

    @Test
    void liveSaysNoneWhenNeitherFaceCanServe(@TempDir Path base) {
        HeadlessBrowserFaces chromeless = new HeadlessBrowserFaces(Optional::empty, base,
                url -> null, (sessionId, profileDir) -> {
                    throw new IllegalStateException("never");
                });
        PrecedenceBrowserFaces faces =
                new PrecedenceBrowserFaces(desktopStub(), () -> false, chromeless);
        assertEquals("none", faces.live());
        assertFalse(faces.attached());
        assertFalse(faces.forSession("s-1").attached());
    }

    @Test
    void closingASessionReachesBothFaces(@TempDir Path base) {
        List<Path> killed = new CopyOnWriteArrayList<>();
        List<String> desktopClosed = new CopyOnWriteArrayList<>();
        BrowserFaces desktop = new BrowserFaces() {
            @Override
            public boolean attached() {
                return false;
            }

            @Override
            public BrowserFace forSession(String sessionId) {
                return BrowserFace.none();
            }

            @Override
            public void closeSession(String sessionId) {
                desktopClosed.add(sessionId);
            }
        };
        HeadlessBrowserFaces web = headless(base, killed);
        PrecedenceBrowserFaces faces = new PrecedenceBrowserFaces(desktop, () -> false, web);
        faces.forSession("s-1").send("navigate",
                JSON.createObjectNode().put("url", "http://dev.example.com/"));
        faces.closeSession("s-1");
        assertEquals(List.of("s-1"), desktopClosed,
                "a session can have lived on either face; both must be told");
        waitUntil(() -> killed.size() == 1, "the web engine must be killed too");
    }

    @Test
    void aShellAttachingClosesEveryHeadlessBrowser(@TempDir Path base) {
        List<Path> killed = new CopyOnWriteArrayList<>();
        BrowserControlSocket control = new BrowserControlSocket();
        HeadlessBrowserFaces web = headless(base, killed);
        PrecedenceBrowserFaces faces = new PrecedenceBrowserFaces(control, web);
        faces.forSession("s-1").send("navigate",
                JSON.createObjectNode().put("url", "http://dev.example.com/"));
        assertEquals("web", faces.live());

        control.afterConnectionEstablished(
                new FakeSocket("shell-1", "ws://127.0.0.1:8746/ws/browser"));

        waitUntil(() -> killed.size() == 1,
                "one browser per session, never two engines racing: the desktop "
                        + "attaching must kill the headless Chrome");
        assertEquals("desktop", faces.live());
    }

    @Test
    void aFlipListenerHearsAttachAndDetach(@TempDir Path base) {
        List<String> flips = new CopyOnWriteArrayList<>();
        BrowserControlSocket control = new BrowserControlSocket();
        PrecedenceBrowserFaces faces =
                new PrecedenceBrowserFaces(control, headless(base, new CopyOnWriteArrayList<>()));
        faces.onFlip(() -> flips.add(faces.live()));

        FakeSocket shell = new FakeSocket("shell-1", "ws://127.0.0.1:8746/ws/browser");
        control.afterConnectionEstablished(shell);
        control.afterConnectionClosed(shell,
                org.springframework.web.socket.CloseStatus.NORMAL);

        waitUntil(() -> flips.size() == 2, "attach and detach both flip the live face");
        assertEquals("desktop", flips.get(0));
        assertEquals("web", flips.get(1),
                "after the shell goes, the web engine serves again");
    }

    private static void waitUntil(java.util.function.BooleanSupplier condition, String what) {
        long deadline = System.currentTimeMillis() + 5_000;
        while (!condition.getAsBoolean() && System.currentTimeMillis() < deadline) {
            try {
                Thread.sleep(10);
            } catch (InterruptedException interrupted) {
                Thread.currentThread().interrupt();
                break;
            }
        }
        assertTrue(condition.getAsBoolean(), what);
    }
}
