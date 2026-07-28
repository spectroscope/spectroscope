package dev.spectroscope.server;

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
import java.util.concurrent.atomic.AtomicReference;

/** A WebSocketSession that records instead of transmitting. */
final class FakeSocket implements WebSocketSession {

    private final String id;
    private final URI uri;
    private final ByteArrayOutputStream binary = new ByteArrayOutputStream();
    final List<String> text = new ArrayList<>();
    final AtomicReference<CloseStatus> closed = new AtomicReference<>();

    FakeSocket(String id, String uri) {
        this.id = id;
        this.uri = URI.create(uri);
    }

    /** Everything the server sent as binary, concatenated. */
    synchronized String binaryText() {
        return binary.toString();
    }

    synchronized String textJoined() {
        return String.join("\n", text);
    }

    @Override
    public synchronized void sendMessage(WebSocketMessage<?> message) {
        if (message instanceof BinaryMessage bin) {
            byte[] bytes = new byte[bin.getPayload().remaining()];
            bin.getPayload().get(bytes);
            binary.write(bytes, 0, bytes.length);
        } else if (message instanceof TextMessage txt) {
            text.add(txt.getPayload());
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
        closed.compareAndSet(null, CloseStatus.NORMAL);
    }

    @Override
    public void close(CloseStatus status) {
        closed.compareAndSet(null, status);
    }
}
