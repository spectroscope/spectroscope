package dev.spectroscope.core.browser;

import com.fasterxml.jackson.databind.JsonNode;

/**
 * The browser, as the tools are allowed to know it — the seam card 200 section 5
 * asks for, and the reason the engine decision is reversible.
 *
 * <p>The verdict of card 200 is <b>Electron's {@code WebContentsView}, on the
 * desktop face</b>, driven by the Java server over a control channel the main
 * process opens back to it. That is one implementation of this interface, not
 * the contract. Everything the model can reach — the seven tools, the net fence
 * policy, the tier entries, the sentence shapes — sits above this line.
 *
 * <p><b>The reversibility was cashed in (card 226):</b> the owner reversed the
 * desktop-only trade, and the promised later implementation exists —
 * {@code dev.spectroscope.core.browser.headless.HeadlessBrowserFace}, a
 * headless Chrome the server spawns, driven over CDP, serving the
 * {@code spectro web} face. Which one answers a given session is the
 * server's precedence rule (the desktop wins while its shell is attached),
 * and nothing above this line changed for it, which is what the seam was for.
 *
 * <p><b>Verbs on the wire.</b> One string per verb, arguments as a JSON object,
 * one JSON reply. Deliberately not a typed method per tool: the wire is the
 * thing two languages have to agree on, and a fake in a test is then a map from
 * verb to reply rather than a mock of nine methods.
 *
 * <ul>
 *   <li>{@code navigate} — {@code {url, tabId?}}</li>
 *   <li>{@code eval} — {@code {text, tabId?}}, the four pinned semantics</li>
 *   <li>{@code screenshot} — {@code {tabId?}} → {@code {mediaType, dataBase64, width, height}}</li>
 *   <li>{@code input} — {@code {action, coordinate?, ref?, text?, ...}}</li>
 *   <li>{@code read_page} — {@code {filter?, maxChars?, tabId?}}</li>
 *   <li>{@code find} — {@code {query, tabId?}}</li>
 *   <li>{@code console} — {@code {limit?, onlyErrors?, pattern?, tabId?}}</li>
 *   <li>{@code resize} — {@code {width, height, tabId?}}</li>
 * </ul>
 *
 * <p><b>Two more the OPERATOR has and the model does not</b> (cards 344 and
 * 346), reached only from the toolbar over {@code /ws/browser-view}, like
 * {@code back} and {@code forward} before them:
 *
 * <ul>
 *   <li>{@code reload} — no arguments, deliberately. Chromium's own reload, so
 *       what was typed into a form survives and nothing is re-posted; a
 *       navigate to the remembered address is what this verb exists to stop
 *       being.</li>
 *   <li>{@code close_page} — drops the page and keeps the Chromium session, its
 *       cookies and its cache. {@code closeSession} on {@link BrowserFaces} is
 *       the destructive neighbour; this one is closing a tab.</li>
 * </ul>
 */
public interface BrowserFace {

    /**
     * Whether a browser pane is attached and drivable at this instant.
     *
     * <p>Asked per call, never cached: the desktop shell can close, restart or
     * lose its control channel between two tool calls, and a tool that assumed
     * otherwise would hang instead of saying so.
     *
     * @return true when a pane is attached
     */
    boolean attached();

    /**
     * The address the pane is showing, for a failure sentence to name.
     *
     * <p>House rule from cards 193 and 203: a failure names what it tried. For
     * {@code browser_navigate} that is its own argument; for the six tools that
     * act on whatever is already open, it is this.
     *
     * @return the current page URL, or null when nothing is open
     */
    String pageUrl();

    /**
     * Runs one command against the pane. Never throws — a transport failure, a
     * timeout and a page error all come back as a failed {@link Reply}.
     *
     * @param verb the verb, from the list in this interface's own documentation
     * @param args the arguments object, exactly as the verb expects it
     * @return the reply, ok or failed
     */
    Reply send(String verb, JsonNode args);

    /**
     * Where this browser's history can go, for a toolbar to grey out what is
     * not there (card 344, criterion 3).
     *
     * <p>The default is {@link History#UNKNOWN}, and that default is the point.
     * A face that cannot answer FRESHLY must say nothing rather than guess:
     * an unknown leaves the control alone and the operator learns by pressing
     * it, which is exactly today's behaviour, while a wrong {@code false} is a
     * dead button over a working page. The desktop shell pushes no navigation
     * up its control channel, so its answer would be a cache that goes stale
     * the moment the operator clicks a link on the real pane — it keeps the
     * default deliberately.
     *
     * @return what is known about this browser's history right now
     */
    default History history() {
        return History.UNKNOWN;
    }

    /**
     * What a face knows about its own history.
     *
     * <p>Boxed on purpose: {@code null} is a THIRD state, "not known right
     * now", and it must not be collapsed into {@code false}. See
     * {@link #history()}.
     *
     * @param back    whether there is an entry earlier, or null when unknown
     * @param forward whether there is one later, or null when unknown
     */
    record History(Boolean back, Boolean forward) {

        /** A face that cannot answer. Never disables a control. */
        public static final History UNKNOWN = new History(null, null);

        /** A browser holding no page: provably nowhere to go, either way. */
        public static final History NOWHERE = new History(false, false);
    }

    /**
     * One reply from the browser.
     *
     * @param ok      whether the verb did what it was asked
     * @param value   the verb's result object when ok, else null
     * @param error   the failure sentence when not ok, else null
     * @param pageUrl the address this happened on, so the caller can name it
     */
    record Reply(boolean ok, JsonNode value, String error, String pageUrl) {

        /**
         * A verb that worked.
         *
         * @param value   the verb's result object
         * @param pageUrl the address it happened on
         * @return the reply
         */
        public static Reply ok(JsonNode value, String pageUrl) {
            return new Reply(true, value, null, pageUrl);
        }

        /**
         * A verb that did not.
         *
         * @param error   what went wrong, in one sentence
         * @param pageUrl the address it happened on, or null when none is open
         * @return the reply
         */
        public static Reply failed(String error, String pageUrl) {
            return new Reply(false, null, error, pageUrl);
        }
    }

    /**
     * The face a {@code spectro web} reader has: none.
     *
     * <p>Not null and not an exception — a real object that answers every call
     * with the honest sentence. The tools then need no null check and no second
     * code path, and the sentence a web reader sees is written in one place.
     *
     * @return a face that is never attached
     */
    static BrowserFace none() {
        return new BrowserFace() {
            @Override
            public boolean attached() {
                return false;
            }

            @Override
            public String pageUrl() {
                return null;
            }

            @Override
            public Reply send(String verb, JsonNode args) {
                return Reply.failed(DETACHED, null);
            }
        };
    }

    /**
     * Why no browser answered — the one sentence, so every tool says it the same
     * way and a reader can search for it.
     */
    String DETACHED = "no browser is attached: this run reaches neither the desktop app's "
            + "browser pane nor a server-side Chrome for the web face (open the desktop "
            + "app, or install Chrome/Chromium or set SPECTRO_CHROME on the server — "
            + "see docs/BROWSER.md)";
}
