package dev.spectroscope.server.browser;

import dev.spectroscope.core.browser.BrowserFace;
import dev.spectroscope.core.browser.BrowserFaces;
import dev.spectroscope.core.browser.headless.HeadlessBrowserFace;
import dev.spectroscope.core.browser.headless.HeadlessBrowserFaces;
import dev.spectroscope.core.browser.headless.HeadlessFence;
import dev.spectroscope.core.net.NetFence;
import dev.spectroscope.core.web.BrowsePageTool;

import org.springframework.stereotype.Component;

import java.util.List;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.function.BooleanSupplier;
import java.util.function.Function;

/**
 * One browser per session, resolved between two engines (card 226,
 * criterion 5): the desktop pane and the server's headless Chrome.
 *
 * <p><b>The desktop wins, always.</b> The owner's rule is one browser per
 * session, never two engines racing — and the desktop pane is the one the
 * operator is physically looking at, so when its shell holds the control
 * channel, every session's verbs go there. The headless engine serves exactly
 * the readers the desktop cannot: someone on {@code spectro web} in their own
 * browser, which is the reversal card 226 was cut from.
 *
 * <p>The flip is enforced, not hoped for: a shell ATTACHING kills every
 * headless engine on the spot ({@code closeAllSessions}), because a Chrome
 * kept running behind a pane the operator now watches is an orphan holding a
 * cookie jar — card 221's lesson applied before it can repeat. A shell
 * detaching flips the answer back; the next verb lazily opens a fresh
 * headless browser, logged out, exactly as a resume does.
 *
 * <p>{@link #live()} is the sentence the UI builds on: which face would serve
 * a verb arriving now — {@code "desktop"}, {@code "web"} or {@code "none"}.
 */
@Component
public class PrecedenceBrowserFaces implements BrowserFaces {

    private final BrowserFaces desktop;
    private final BooleanSupplier desktopAttached;
    private final HeadlessBrowserFaces web;
    private final Function<String, NetFence.Refusal> judge;
    private final List<Runnable> flipListeners = new CopyOnWriteArrayList<>();

    /**
     * The Spring wiring: the desktop channel that already exists, and a
     * production headless directory whose fence reads the {@code
     * allowLocalhost} opt-in fresh per judgment — the same source both other
     * fence halves read.
     *
     * @param desktop the desktop shell's control channel
     */
    @org.springframework.beans.factory.annotation.Autowired
    public PrecedenceBrowserFaces(BrowserControlSocket desktop) {
        this(desktop, HeadlessBrowserFaces.production(
                () -> BrowsePageTool.findChrome(System.getenv()),
                new HeadlessFence(() -> dev.spectroscope.core.config.SpectroConfig
                        .load(dev.spectroscope.core.config.SpectroConfig.Overrides.none())
                        .allowLocalhost())::judge));
    }

    /**
     * The hook-wired form: desktop precedence plus the attach/detach flips.
     *
     * @param desktop the desktop control channel, listened to
     * @param web     the headless directory
     */
    public PrecedenceBrowserFaces(BrowserControlSocket desktop, HeadlessBrowserFaces web) {
        this(desktop, desktop::attached, web);
        desktop.onShellAttached(() -> {
            // The desktop face wins NOW — no headless engine may keep racing it.
            web.closeAllSessions();
            flipListeners.forEach(Runnable::run);
        });
        desktop.onShellDetached(() -> flipListeners.forEach(Runnable::run));
    }

    /**
     * The seam the suite drives: precedence logic with everything injectable
     * and no hooks registered.
     *
     * @param desktop         the desktop directory
     * @param desktopAttached whether the desktop shell holds its channel
     * @param web             the headless directory
     */
    PrecedenceBrowserFaces(BrowserFaces desktop, BooleanSupplier desktopAttached,
            HeadlessBrowserFaces web) {
        this(desktop, desktopAttached, web, url -> null);
    }

    /**
     * The full seam, with the navigate fence the view socket runs.
     *
     * @param desktop         the desktop directory
     * @param desktopAttached whether the desktop shell holds its channel
     * @param web             the headless directory
     * @param judge           the entry fence for operator-typed addresses
     */
    PrecedenceBrowserFaces(BrowserFaces desktop, BooleanSupplier desktopAttached,
            HeadlessBrowserFaces web, Function<String, NetFence.Refusal> judge) {
        this.desktop = desktop;
        this.desktopAttached = desktopAttached;
        this.web = web;
        this.judge = judge;
    }

    /** @return whether ANY face could serve a browser right now */
    @Override
    public boolean attached() {
        return desktopAttached.getAsBoolean() || web.attached();
    }

    /**
     * Which face serves a verb arriving now.
     *
     * @return {@code "desktop"}, {@code "web"} or {@code "none"}
     */
    public String live() {
        if (desktopAttached.getAsBoolean()) {
            return "desktop";
        }
        return web.attached() ? "web" : "none";
    }

    /**
     * The browser of one session, on whichever face is live for THIS call —
     * read per call, like everything else about the browser, because the shell
     * can attach and detach between two tool calls.
     *
     * @param sessionId the session's store id
     * @return that session's face
     */
    @Override
    public BrowserFace forSession(String sessionId) {
        if (desktopAttached.getAsBoolean()) {
            return desktop.forSession(sessionId);
        }
        return web.forSession(sessionId);
    }

    /**
     * The headless face of one session, typed — for the view socket's cast.
     * Empty whenever the desktop is live: the picture then belongs to the pane.
     *
     * @param sessionId the session's store id
     * @return the face, or null when the web engine is not the live face
     */
    public HeadlessBrowserFace webFace(String sessionId) {
        if (desktopAttached.getAsBoolean()) {
            return null;
        }
        return web.headlessForSession(sessionId);
    }

    /**
     * The entry fence for an address the OPERATOR typed into the segment's URL
     * bar. The hop fence inside the engine judges the journey either way; this
     * one exists so a refused address is refused with a sentence before any
     * engine is spawned for it.
     *
     * @param url the address as typed
     * @return the refusal, or null when it passes
     */
    public NetFence.Refusal judgeNavigate(String url) {
        return judge.apply(url);
    }

    /**
     * Registers a listener for the live face flipping (shell attach/detach).
     *
     * @param listener runs after the flip is in force
     */
    public void onFlip(Runnable listener) {
        flipListeners.add(listener);
    }

    /**
     * Ends one session's browser on BOTH faces. Closing is not routed by
     * precedence: the session may have lived on either face (the shell can
     * have attached mid-session), and closing what does not exist is free.
     *
     * @param sessionId the session that closed
     */
    @Override
    public void closeSession(String sessionId) {
        desktop.closeSession(sessionId);
        web.closeSession(sessionId);
    }
}
