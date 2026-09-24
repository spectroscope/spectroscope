package dev.spectroscope.server.session;

import org.springframework.http.HttpHeaders;
import org.springframework.web.socket.BinaryMessage;
import org.springframework.web.socket.CloseStatus;
import org.springframework.web.socket.TextMessage;
import org.springframework.web.socket.WebSocketExtension;
import org.springframework.web.socket.WebSocketMessage;
import org.springframework.web.socket.WebSocketSession;

import java.io.ByteArrayOutputStream;
import java.net.InetSocketAddress;
import java.net.URI;
import java.security.Principal;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;

/** A WebSocketSession that records instead of transmitting. */
public final class FakeSocket implements WebSocketSession {

    private final String id;
    private final URI uri;
    private final ByteArrayOutputStream binary = new ByteArrayOutputStream();
    final List<String> text = new ArrayList<>();
    /** Card 395: System.nanoTime() when each text frame was recorded, index for index with {@link #text}. */
    final List<Long> textArrivedAt = new ArrayList<>();
    public final AtomicReference<CloseStatus> closed = new AtomicReference<>();

    /** Card 395: what one frame costs the modelled client, in nanoseconds. Zero records at once. */
    private volatile long frameCostNanos;
    /** Card 395: a frame in its paced wait gives up the wait when the socket closes. */
    private final Object pacing = new Object();

    public FakeSocket(String id, String uri) {
        this.id = id;
        this.uri = URI.create(uri);
    }

    /** Everything the server sent as binary, concatenated. */
    synchronized String binaryText() {
        return binary.toString();
    }

    public synchronized String textJoined() {
        return String.join("\n", text);
    }

    /**
     * Card 395: models a client that needs this long per frame before it takes
     * the next one, the way a browser tab behind on its own rendering holds a
     * blocking server send. The wait happens outside this socket's monitor, so
     * a test reading the recorded frames is never held up by it, and it ends
     * early when the socket closes.
     *
     * @param perFrame the time one frame costs; zero turns pacing off again
     */
    public void costPerFrame(java.time.Duration perFrame) {
        frameCostNanos = perFrame.toNanos();
        synchronized (pacing) {
            pacing.notifyAll();
        }
    }

    /**
     * A copy of the recorded text frames and their arrival times.
     *
     * @return the frames in arrival order, each with its System.nanoTime() stamp
     */
    public synchronized List<Frame> frames() {
        List<Frame> out = new ArrayList<>(text.size());
        for (int i = 0; i < text.size(); i++) {
            out.add(new Frame(text.get(i), textArrivedAt.get(i)));
        }
        return out;
    }

    /**
     * One recorded text frame.
     *
     * @param payload   the frame text as the server sent it
     * @param arrivedAt System.nanoTime() once the modelled client had taken it
     */
    public record Frame(String payload, long arrivedAt) {}

    @Override
    public void sendMessage(WebSocketMessage<?> message) {
        pace();
        synchronized (this) {
            if (message instanceof BinaryMessage bin) {
                byte[] bytes = new byte[bin.getPayload().remaining()];
                bin.getPayload().get(bytes);
                binary.write(bytes, 0, bytes.length);
            } else if (message instanceof TextMessage txt) {
                text.add(txt.getPayload());
                textArrivedAt.add(System.nanoTime());
            }
        }
    }

    /** Waits out the modelled per-frame cost; returns early when pacing is switched off or the socket closes. */
    private void pace() {
        long cost = frameCostNanos;
        if (cost <= 0) {
            return;
        }
        long until = System.nanoTime() + cost;
        synchronized (pacing) {
            long left;
            while (frameCostNanos > 0 && isOpen() && (left = until - System.nanoTime()) > 0) {
                try {
                    TimeUnit.NANOSECONDS.timedWait(pacing, left);
                } catch (InterruptedException interrupted) {
                    Thread.currentThread().interrupt();
                    return;
                }
            }
        }
    }

    @Override
    public String getId() {
        return id;
    }

    @Override
    public URI getUri() {
        return uri;
    }

    @Override
    public HttpHeaders getHandshakeHeaders() {
        return new HttpHeaders();
    }

    @Override
    public Map<String, Object> getAttributes() {
        return new HashMap<>();
    }

    @Override
    public Principal getPrincipal() {
        return null;
    }

    @Override
    public InetSocketAddress getLocalAddress() {
        return new InetSocketAddress("127.0.0.1", 8302);
    }

    @Override
    public InetSocketAddress getRemoteAddress() {
        return new InetSocketAddress("127.0.0.1", 51234);
    }

    @Override
    public String getAcceptedProtocol() {
        return null;
    }

    @Override
    public void setTextMessageSizeLimit(int messageSizeLimit) {
    }

    @Override
    public int getTextMessageSizeLimit() {
        return 0;
    }

    @Override
    public void setBinaryMessageSizeLimit(int messageSizeLimit) {
    }

    @Override
    public int getBinaryMessageSizeLimit() {
        return 0;
    }

    @Override
    public List<WebSocketExtension> getExtensions() {
        return List.of();
    }

    @Override
    public boolean isOpen() {
        return closed.get() == null;
    }

    @Override
    public void close() {
        close(CloseStatus.NORMAL);
    }

    @Override
    public void close(CloseStatus status) {
        closed.compareAndSet(null, status);
        synchronized (pacing) {
            pacing.notifyAll();
        }
    }
}
