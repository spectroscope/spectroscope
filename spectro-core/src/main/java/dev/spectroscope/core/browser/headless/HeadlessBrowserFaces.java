package dev.spectroscope.core.browser.headless;

import dev.spectroscope.core.browser.BrowserFace;
import dev.spectroscope.core.browser.BrowserFaces;
import dev.spectroscope.core.net.NetFence;

import java.io.IOException;
import java.io.UncheckedIOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Duration;
import java.util.Comparator;
import java.util.Map;
import java.util.Optional;
import java.util.concurrent.ConcurrentHashMap;
import java.util.function.Function;
import java.util.function.Supplier;
import java.util.stream.Stream;

/**
 * Every session's WEB-face browser, keyed by session id (card 226) — the
 * headless twin of the desktop's {@code BrowserControlSocket} directory.
 *
 * <p><b>Card 218's isolation, carried by the profile directory.</b> Where the
 * desktop keys an Electron partition per session, this face keys a Chrome
 * {@code --user-data-dir}: cookie jar, localStorage, cache and credential store
 * all live under that directory and two directories share none of it. The name
 * carries a fingerprint of the RAW id because sanitising is lossy ({@code ab/c}
 * and {@code ab:c} both flatten to {@code ab_c}), and an OPENING counter
 * because a resumed session must get a fresh browser, never the cookies of a
 * run that ended — both rules measured and paid for on the desktop face.
 *
 * <p><b>The lifetime is the session's.</b> {@code closeSession} kills the whole
 * process tree (card 221: an orphaned child costs a day — kill the TREE, count
 * it twice) and deletes the profile directory, so nothing outlives the session
 * on disk or in the process table. A shutdown hook does the same for every
 * engine still open when the JVM goes down.
 */
public final class HeadlessBrowserFaces implements BrowserFaces {

    /** One spawned engine: the CDP endpoint and the kill switch. */
    public interface Engine {
        /** @return the CDP endpoint of this engine's one page */
        HeadlessBrowserFace.Cdp cdp();

        /** Kills the engine's whole process tree and removes its profile. */
        void kill();
    }

    /** How an engine comes to be — the seam the suite fakes. */
    @FunctionalInterface
    public interface EngineOpener {
        /**
         * Spawns one engine on one profile directory.
         *
         * @param sessionId  whose browser this is, for diagnostics only
         * @param profileDir the profile directory, this session's own
         * @return the running engine
         */
        Engine open(String sessionId, Path profileDir);
    }

    /** One session's entry: its face and, once booted, its engine. */
    private static final class Entry {
        final HeadlessBrowserFace face;
        volatile Engine engine;

        Entry(HeadlessBrowserFace face) {
            this.face = face;
        }
    }

    private final Supplier<Optional<Path>> chromeLocator;
    private final Path profileBase;
    private final Function<String, NetFence.Refusal> judge;
    private final EngineOpener engines;
    private final Map<String, Entry> sessions = new ConcurrentHashMap<>();
    private final Map<String, Integer> openings = new ConcurrentHashMap<>();

    /**
     * @param chromeLocator where the browser binary is, asked per call so a
     *                      Chrome installed mid-session is found
     * @param profileBase   the directory profiles are created under
     * @param judge         the navigation fence every document hop passes
     * @param engines       how an engine is spawned
     */
    public HeadlessBrowserFaces(Supplier<Optional<Path>> chromeLocator, Path profileBase,
            Function<String, NetFence.Refusal> judge, EngineOpener engines) {
        this.chromeLocator = chromeLocator;
        this.profileBase = profileBase;
        this.judge = judge;
        this.engines = engines;
    }

    /**
     * The production directory: real Chrome, real CDP, profiles under the
     * system temp directory, and a JVM shutdown hook that kills every engine
     * still open — the same insurance {@code LaunchSupervisor} carries, for the
     * same reason.
     *
     * @param chromeLocator where the browser binary is
     * @param judge         the navigation fence
     * @return the wired directory
     */
    public static HeadlessBrowserFaces production(Supplier<Optional<Path>> chromeLocator,
            Function<String, NetFence.Refusal> judge) {
        Path base = Path.of(System.getProperty("java.io.tmpdir"), "spectro-headless");
        HeadlessBrowserFaces faces = new HeadlessBrowserFaces(chromeLocator, base, judge,
                realEngines(chromeLocator));
        Runtime.getRuntime().addShutdownHook(
                new Thread(faces::closeAllSessions, "spectro-headless-reaper"));
        return faces;
    }

    /**
     * The real engine opener: spawn a Chrome, dial its page target, and on
     * kill take the whole tree and the profile directory with it.
     *
     * @param chromeLocator where the browser binary is
     * @return the opener the production directory (and the live suite) uses
     */
    public static EngineOpener realEngines(Supplier<Optional<Path>> chromeLocator) {
        return (sessionId, profileDir) -> {
            Path binary = chromeLocator.get().orElseThrow(() -> new IllegalStateException(
                    "no Chrome/Chromium was found for the web-face browser — install "
                            + "Google Chrome, or point SPECTRO_CHROME at a binary"));
            HeadlessChrome chrome;
            try {
                chrome = HeadlessChrome.spawn(binary, profileDir, 1280, 800);
            } catch (IOException cannotSpawn) {
                throw new UncheckedIOException(cannotSpawn);
            }
            CdpConnection cdp;
            try {
                cdp = CdpConnection.connect(chrome.pageWebSocketUrl(), Duration.ofSeconds(30));
            } catch (RuntimeException cannotDial) {
                chrome.kill();
                deleteRecursively(profileDir);
                throw cannotDial;
            }
            return new Engine() {
                @Override
                public HeadlessBrowserFace.Cdp cdp() {
                    return cdp;
                }

                @Override
                public void kill() {
                    cdp.close();
                    chrome.kill();
                    deleteRecursively(profileDir);
                }
            };
        };
    }

    /** @return whether an engine could be opened at all on this machine */
    @Override
    public boolean attached() {
        return chromeLocator.get().isPresent();
    }

    /**
     * The browser belonging to one session, created lazily — the ENGINE is only
     * spawned when the first verb arrives.
     *
     * @param sessionId the session's store id
     * @return that session's face; a machine with no Chrome gets the honest
     *         never-attached face
     */
    @Override
    public BrowserFace forSession(String sessionId) {
        HeadlessBrowserFace face = headlessForSession(sessionId);
        return face == null ? BrowserFace.none() : face;
    }

    /**
     * The same face, in its own type — for the view socket, which needs the
     * screencast and {@code hasPage()} beside the seven verbs.
     *
     * @param sessionId the session's store id
     * @return the face, or null on a machine with no Chrome
     */
    public HeadlessBrowserFace headlessForSession(String sessionId) {
        if (!attached()) {
            return null;
        }
        return sessions.computeIfAbsent(sessionId,
                id -> new Entry(new HeadlessBrowserFace(id, () -> boot(id), judge))).face;
    }

    /** Spawns the engine for one session and remembers it for the kill. */
    private HeadlessBrowserFace.Cdp boot(String sessionId) {
        Entry entry = sessions.get(sessionId);
        Engine opened = engines.open(sessionId, profileDirFor(sessionId));
        if (entry != null) {
            entry.engine = opened;
        }
        return opened.cdp();
    }

    /**
     * This session's profile directory for its CURRENT opening.
     *
     * @param sessionId the session's store id
     * @return the directory the next (or current) engine of this session uses
     */
    public Path profileDirFor(String sessionId) {
        String safe = sessionId.replaceAll("[^A-Za-z0-9._-]", "_");
        int opening = openings.getOrDefault(sessionId, 0);
        return profileBase.resolve(safe + "-" + fingerprint(sessionId) + "-" + opening);
    }

    /** FNV-1a over the RAW id, base 36 — not a security hash, just the belt
     *  that keeps two ids apart after lossy sanitising. */
    private static String fingerprint(String sessionId) {
        int hash = 0x811c9dc5;
        for (int i = 0; i < sessionId.length(); i++) {
            hash ^= sessionId.charAt(i);
            hash *= 0x01000193;
        }
        return Integer.toUnsignedString(hash, 36);
    }

    /**
     * Ends one session's browser: its process tree, its profile, its cookies.
     *
     * <p>Fire and forget on a named thread — this runs on the socket teardown
     * path, and a kill that waits on a wedged Chrome must not hold it.
     *
     * @param sessionId the session that closed
     */
    @Override
    public void closeSession(String sessionId) {
        Entry entry = sessions.remove(sessionId);
        if (entry == null) {
            return;
        }
        openings.merge(sessionId, 1, Integer::sum);
        Thread.ofVirtual().name("spectro-headless-close").start(() -> retire(entry));
    }

    /**
     * Kills every open engine, synchronously — the shutdown hook's path, and
     * the desktop shell's: when a pane attaches, the desktop face wins and no
     * headless Chrome may keep racing it (card 226, criterion 5).
     */
    public void closeAllSessions() {
        sessions.keySet().forEach(id -> {
            Entry entry = sessions.remove(id);
            if (entry != null) {
                openings.merge(id, 1, Integer::sum);
                retire(entry);
            }
        });
    }

    private static void retire(Entry entry) {
        entry.face.close();
        Engine engine = entry.engine;
        if (engine != null) {
            try {
                engine.kill();
            } catch (RuntimeException alreadyDead) {
                // A tree that is already down needs no second felling.
            }
        }
    }

    /** Removes one profile directory, tolerating the files a dying Chrome
     *  still holds for a moment — one retry after a settle.
     *  @param dir the profile directory */
    static void deleteRecursively(Path dir) {
        if (!Files.exists(dir)) {
            return;
        }
        if (!tryDelete(dir)) {
            try {
                Thread.sleep(300);
            } catch (InterruptedException interrupted) {
                Thread.currentThread().interrupt();
            }
            tryDelete(dir);
        }
    }

    private static boolean tryDelete(Path dir) {
        try (Stream<Path> walk = Files.walk(dir)) {
            walk.sorted(Comparator.reverseOrder()).forEach(path -> {
                try {
                    Files.deleteIfExists(path);
                } catch (IOException held) {
                    throw new UncheckedIOException(held);
                }
            });
            return true;
        } catch (IOException | UncheckedIOException stillHeld) {
            return false;
        }
    }
}
