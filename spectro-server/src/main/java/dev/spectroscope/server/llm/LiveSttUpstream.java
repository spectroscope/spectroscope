package dev.spectroscope.server.llm;

import java.io.IOException;

/**
 * The connection to the transcription provider, as a seam.
 *
 * <p>Same reason {@link HostedStt} and {@code CommandRunner} are seams: a test
 * that needs a key, a network and a provider is a test nobody runs, and the
 * behaviour worth pinning here — what is refused, what is held, what is taken
 * down with the browser — has nothing to do with sockets.</p>
 */
public interface LiveSttUpstream {

    /**
     * Open a session.
     *
     * @param listener where frames and the close arrive
     * @return the handle to send on and to close
     * @throws IOException when the connection cannot be made at all
     */
    Link open(Listener listener) throws IOException;

    /** An open upstream session. */
    interface Link {
        /** Send one frame, already serialised by {@link LiveSttProtocol}. */
        void send(String frame);

        /** Close it. Called exactly once, and always — see the handler. */
        void close();
    }

    /** What the provider says back. */
    interface Listener {
        /** One raw frame, unparsed. */
        void onFrame(String raw);

        /** The upstream ended, with whatever reason there was. */
        void onClosed(String reason);
    }
}
