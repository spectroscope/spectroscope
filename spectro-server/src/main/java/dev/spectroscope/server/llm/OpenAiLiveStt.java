package dev.spectroscope.server.llm;

import dev.spectroscope.core.config.SpectroConfig;

import java.io.IOException;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.WebSocket;
import java.time.Duration;
import java.util.concurrent.CompletionStage;
import java.util.function.Supplier;

/**
 * The real connection to the provider's realtime transcription session.
 *
 * <p>Everything protocol-shaped lives in {@link LiveSttProtocol}; this is only
 * the socket, and it exists behind {@link LiveSttUpstream} so the handler's
 * behaviour can be tested without a key or a network.</p>
 *
 * <p>The key is read here, per connection, and never travels to the browser —
 * which is the reason the page talks to us instead of to the provider. A page
 * holding an API key is a page that can spend money in a tab the operator
 * forgot about.</p>
 */
public final class OpenAiLiveStt implements LiveSttUpstream {

    /** One client for every session, like {@code HostedTranscriber}'s: a fresh
     *  HttpClient per connection brings its own selector thread with it. */
    private static final HttpClient SHARED =
            HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(15)).build();

    private final Supplier<String> key;

    /** Production: the key comes from the settings hierarchy and the .env. */
    public OpenAiLiveStt() {
        this(() -> {
            String found = SpectroConfig.resolveApiKey(HostedTranscriber.KEY_ENV);
            return found == null ? "" : found;
        });
    }

    /** Seam for tests that want to drive the real socket against a fake server. */
    OpenAiLiveStt(Supplier<String> key) {
        this.key = key;
    }

    @Override
    public Link open(Listener listener) throws IOException {
        WebSocket socket;
        try {
            socket = SHARED.newWebSocketBuilder()
                    .header("Authorization", "Bearer " + key.get())
                    // No OpenAI-Beta header on purpose: it answers
                    // beta_api_shape_disabled since the GA cutover.
                    .connectTimeout(Duration.ofSeconds(15))
                    .buildAsync(URI.create(LiveSttProtocol.URL), new Frames(listener))
                    .join();
        } catch (RuntimeException unreachable) {
            throw new IOException("the live transcription session could not be opened", unreachable);
        }
        return new Link() {
            @Override
            public void send(String frame) {
                socket.sendText(frame, true);
            }

            @Override
            public void close() {
                // Abort rather than a courteous close: the caller is cleaning up
                // after a browser that has already gone, and a half-closed
                // metered socket waiting for a reply helps nobody.
                socket.abort();
            }
        };
    }

    /** Reassembles the provider's frames, which arrive in fragments. */
    private static final class Frames implements WebSocket.Listener {
        private final Listener listener;
        private final StringBuilder partial = new StringBuilder();

        Frames(Listener listener) {
            this.listener = listener;
        }

        @Override
        public CompletionStage<?> onText(WebSocket socket, CharSequence data, boolean last) {
            // A big transcript arrives in pieces. Handing a fragment to the JSON
            // reader would produce a parse failure that looks like a protocol
            // change; the frames are only whole when `last` says so.
            partial.append(data);
            if (last) {
                String whole = partial.toString();
                partial.setLength(0);
                listener.onFrame(whole);
            }
            socket.request(1);
            return null;
        }

        @Override
        public CompletionStage<?> onClose(WebSocket socket, int status, String reason) {
            listener.onClosed(reason == null || reason.isBlank() ? "closed " + status : reason);
            return null;
        }

        @Override
        public void onError(WebSocket socket, Throwable error) {
            listener.onClosed(error.getMessage() == null ? "connection failed" : error.getMessage());
        }
    }
}
