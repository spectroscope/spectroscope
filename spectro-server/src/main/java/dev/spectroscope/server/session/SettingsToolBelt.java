package dev.spectroscope.server.session;

import dev.spectroscope.core.browser.BrowserFace;
import dev.spectroscope.core.browser.BrowserTools;
import dev.spectroscope.core.config.SpectroConfig;
import dev.spectroscope.core.image.GenerateImageTool;
import dev.spectroscope.core.image.ImageProvider;
import dev.spectroscope.core.image.ImageStore;
import dev.spectroscope.core.launch.LaunchSupervisor;
import dev.spectroscope.core.launch.LaunchTools;
import dev.spectroscope.core.net.NetFence;
import dev.spectroscope.core.tools.HttpFetcher;
import dev.spectroscope.core.tools.Tool;
import dev.spectroscope.core.tools.WebFetchTool;
import dev.spectroscope.core.web.BrowsePageTool;
import dev.spectroscope.core.web.WebSearchTool;
import dev.spectroscope.core.wire.BrowserWireTap;
import dev.spectroscope.core.wire.LlmWireRecorder;

import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.Optional;
import java.util.function.Supplier;

/**
 * The ONE assembly of the settings-reading tool belt (card 231, criterion 3).
 *
 * <p>Membership and order used to live twice: once in
 * {@link SessionConnection#registerSettingsTools} for the live registry, once in
 * {@link ContextDescriber} for the introspection answer — and the copies
 * drifted twice, each time silently: card 201's seven browser tools were
 * missing from the describer for as long as nobody looked, and card 202's five
 * launch tools were missing until this class. A family added here appears on
 * BOTH faces or on neither; there is no second list to forget.</p>
 *
 * <p><b>Every configuration-shaped seam is a SUPPLIER, not a value.</b> That is
 * card 222's law and the belt's whole point: the live face passes readers over
 * {@code liveConfig()} so a setting saved mid-session reaches the very next
 * call, and the describe face passes constant stand-ins because describing a
 * tool is not driving one. Freezing any supplier into a value at assembly time
 * re-opens card 222 — {@code SessionSettingsReachTheBeltTest} goes red when
 * that happens, measured, which is what keeps this sentence honest.</p>
 */
final class SettingsToolBelt {

    /** Static assembly only — never instantiated. */
    private SettingsToolBelt() {
    }

    /**
     * Everything the belt reads, live or stand-in — one labeled slot per seam.
     *
     * @param imageBackend  the image provider for the call being made, resolved per call
     * @param imageStore    the content-addressed store screenshots and images land in
     * @param llmWire       the session's recorder image calls land on (card 184);
     *                      null keeps image calls unrecorded (describe face)
     * @param fetcher       the HTTP seam behind {@code web_fetch}
     * @param config        the settings as they stand at CALL time (card 222)
     * @param fence         the net fence, read per call (card 199/222)
     * @param chromeLocator yields the Chrome binary per call, settings overlay included
     * @param chromeRunner  the process seam behind {@code browse_page}
     * @param browser       this session's browser face, read per call (card 201)
     * @param browserTap    the browser sidecar recorder, read per call (card 204/227)
     * @param launches      what this session has running — one supervisor per session (card 202)
     */
    record Seams(
            Supplier<ImageProvider> imageBackend,
            ImageStore imageStore,
            LlmWireRecorder llmWire,
            HttpFetcher fetcher,
            Supplier<SpectroConfig> config,
            Supplier<NetFence> fence,
            Supplier<Optional<Path>> chromeLocator,
            BrowsePageTool.ChromeRunner chromeRunner,
            Supplier<BrowserFace> browser,
            Supplier<BrowserWireTap> browserTap,
            LaunchSupervisor launches) {
    }

    /**
     * The assembled belt.
     *
     * @param tools    every settings-reading tool, in registration order
     * @param webGrant the three web tools in the card-205 order — the research
     *                 role's grant, the SAME instances the belt carries
     */
    record Belt(List<Tool> tools, List<Tool> webGrant) {
    }

    /**
     * Builds the belt: generate_image, web_fetch, web_search, browse_page, the
     * seven browser tools (card 201), the five launch tools (card 202) — the
     * order both the live registry and the introspection list promise.
     *
     * @param seams the wiring, live or describe-time
     * @return the ordered belt plus the card-205 web grant out of it
     */
    static Belt assemble(Seams seams) {
        Tool generateImage = new GenerateImageTool(
                seams.imageBackend(), seams.imageStore(), seams.llmWire());
        Tool webFetch = new WebFetchTool(seams.fetcher(), seams.fence());
        Tool webSearch = WebSearchTool.fromConfig(seams.config());
        Tool browsePage = new BrowsePageTool(
                seams.chromeLocator(), seams.chromeRunner(), seams.fence());
        List<Tool> tools = new ArrayList<>(List.of(generateImage, webFetch, webSearch, browsePage));
        tools.addAll(new BrowserTools(
                seams.browser(), seams.fence(), seams.imageStore(), seams.browserTap()).all());
        tools.addAll(new LaunchTools(seams.launches(), seams.browser(), seams.fence()).all());
        return new Belt(List.copyOf(tools), List.of(webSearch, webFetch, browsePage));
    }

    /**
     * The describe-time seams: honest stand-ins for a stateless endpoint. No
     * session exists, so nothing here can act — {@link BrowserFace#none()} is
     * the "nothing is attached" face, the fences and backends answer nothing,
     * and the supervisor has never started a process and never will (it holds
     * no OS resource until something is started through it, so there is nothing
     * to close). Describing a tool is not driving one; name, description and
     * gate flag are the real tool objects' own.
     *
     * @param config the SAME resolved configuration the caller is describing —
     *               web_search must name the ACTIVE tier of exactly this config
     *               (card 203), so it rides in as a constant supplier
     * @return the stand-in seams for {@link #assemble}
     */
    static Seams describeSeams(SpectroConfig config) {
        return new Seams(
                () -> null,
                null,
                null,
                url -> null,
                () -> config,
                () -> null,
                Optional::empty,
                null,
                BrowserFace::none,
                BrowserWireTap::none,
                new LaunchSupervisor((host, port) -> false));
    }
}
