package dev.spectroscope.core.wire;

import com.fasterxml.jackson.databind.JsonNode;

import java.util.UUID;

/**
 * The seam the seven browser tools record through (card 204) — the browser twin
 * of {@link LlmWireTap}.
 *
 * <p><b>What crosses this line, and what deliberately does not.</b> A call is
 * announced with exactly what the model wrote (the tool name and its arguments)
 * and closed with exactly what the model read back (the tool result string).
 * The {@link dev.spectroscope.core.browser.BrowserFace.Reply} itself never
 * appears in any signature here, and that is the security criterion of this card
 * expressed as a type rather than as a rule somebody keeps: a reply holds the
 * screenshot's raw payload and whatever else the pane chose to answer with, and
 * a recorder that could see it could record it. A picture arrives instead as
 * {@link Call#image} — a reference into the image store, the way card 198's
 * {@code image_generated} carries one.
 *
 * <p>Cookies, {@code localStorage} and the credentials the page holds are
 * therefore not "filtered out" of the record. They never reach it.
 */
public interface BrowserWireTap {

    /**
     * The actor marker for a call a HUMAN made (card 227): the operator's own
     * hand on the segment's controls — a typed address, back, forward, a play
     * button. Recorded as an additive {@code actor} field on the call line;
     * an agent's call carries no marker at all, so every sidecar written
     * before this card reads exactly as it did, and absent means agent —
     * which for those files is simply true.
     */
    String OPERATOR = "operator";

    /**
     * Announces one browser tool call, before it has an outcome.
     *
     * <p>Announced rather than reported afterwards, for the same reason the
     * llm-wire persists its request at send time: the call that never returns —
     * a navigate into a page that hangs, a shell killed mid-verb — is exactly
     * the one a replay is wanted for, and a recorder that writes only on
     * completion loses it.
     *
     * @param tool    the wire name of the tool ({@code browser_navigate}, …)
     * @param agentId the calling agent
     * @param callId  the provider's tool_use id, or null where none exists
     * @param input   the model's arguments, verbatim — redaction is the
     *                recorder's job, not the caller's
     * @param pageUrl what the pane was showing when the call started, or null
     * @return the handle that closes the record, never null
     */
    default Call open(String tool, String agentId, String callId, JsonNode input, String pageUrl) {
        return open(tool, agentId, callId, input, pageUrl, null);
    }

    /**
     * Announces one call together with who drove it — the form card 227 adds.
     *
     * @param tool    the wire name of the tool, or the bare verb for an
     *                operator-driven call ({@code navigate}, {@code back}, …)
     * @param agentId the calling agent, or null for an operator call
     * @param callId  the provider's tool_use id, or null where none exists
     * @param input   the arguments, verbatim
     * @param pageUrl what the pane was showing when the call started, or null
     * @param actor   {@link #OPERATOR} for a human's own action, or null for
     *                the agent — null keeps the line's card-204 shape
     * @return the handle that closes the record, never null
     */
    Call open(String tool, String agentId, String callId, JsonNode input, String pageUrl,
              String actor);

    /** One announced call, waiting for its outcome. */
    interface Call {

        /**
         * This call's own id — what pairs its two lines in the sidecar and what
         * the {@code browser_action} event carries so a row can be drilled into.
         *
         * @return the id, never null and never blank
         */
        String cid();

        /**
         * Which browser this call drove, counted within the session.
         *
         * <p>A session can outlive its browser: closing the session retires it
         * (card 218), and a resume opens a fresh one with fresh cookies under the
         * same session id, appending to the same sidecar. The epoch is what keeps
         * a replay from stitching two logins into one story.
         *
         * @return the 1-based browser number, or 0 when nothing is recording
         */
        int epoch();

        /**
         * The screenshot this call produced, as a reference.
         *
         * @param mediaType the stored blob's IANA type
         * @param blobPath  the reference into the store, relative to {@code ~/.spectro}
         * @param sha256    the store's content hash — pairs with {@code image_generated}
         * @param width     the picture's width in pixels, as the pane measured it
         * @param height    the picture's height in pixels
         * @param bytes     the decoded size of the stored blob
         */
        void image(String mediaType, String blobPath, String sha256, int width, int height, long bytes);

        /**
         * The hash of the blob {@link #image} named, so the {@code browser_action}
         * event can carry the same key the {@code image_generated} event does and
         * a replay can load exactly the picture the model was shown.
         *
         * @return the content hash, or null for a call that took no picture
         */
        String imageSha256();

        /**
         * Closes the record with what the model read back.
         *
         * @param ok      whether the tool answered rather than refused
         * @param result  the tool result string exactly as the model received it
         * @param pageUrl the address the call ended on, or null when none is open
         */
        void end(boolean ok, String result, String pageUrl);
    }

    /**
     * The tap for a run with no sidecar: the CLI, a subagent, every test that
     * builds tools without a session.
     *
     * <p>Not null and not a branch at the call site — a real handle that records
     * nothing and still names the call, so the {@code browser_action} event a
     * tool emits is self-consistent whether or not anything is being written.
     * Epoch 0 is the honest number there: no browser was counted.
     *
     * @return a tap that writes nothing
     */
    static BrowserWireTap none() {
        return (tool, agentId, callId, input, pageUrl, actor) -> new Call() {
            private final String cid = UUID.randomUUID().toString();
            private String sha;

            @Override
            public String cid() {
                return cid;
            }

            @Override
            public int epoch() {
                return 0;
            }

            @Override
            public void image(String mediaType, String blobPath, String sha256,
                              int width, int height, long bytes) {
                // Nothing is recording the picture, but the event still names it:
                // the blob is in the store either way, and a hash that went
                // missing here would make the two events disagree.
                sha = sha256;
            }

            @Override
            public String imageSha256() {
                return sha;
            }

            @Override
            public void end(boolean ok, String result, String pageUrl) {
                // Same.
            }
        };
    }
}
