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
 * policy, the tier entries, the sentence shapes — sits above this line. A later
 * CDP implementation for the {@code spectro web} face would land underneath it
 * and change none of those.
 *
 * <p><b>The trade the owner ratified is real and is stated here rather than
 * hidden:</b> a reader who runs {@code spectro web} and points their own browser
 * at the server gets no browser from this card. {@link #attached()} is false for
 * them, and every tool answers with a sentence that says so and names the
 * address it was asked for. Card 200 section 5 names the price of flipping that.
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
    String DETACHED = "no browser pane is attached: the visible browser is a pane in the "
            + "spectroscope desktop app, and this run is not connected to one "
            + "(open the desktop app and its browser segment, or see docs/BROWSER.md)";
}
