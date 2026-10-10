package dev.spectroscope.core.copilot;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpServer;

import java.io.IOException;
import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.net.URI;
import java.net.URLDecoder;
import java.nio.charset.StandardCharsets;
import java.util.ArrayDeque;
import java.util.Deque;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CopyOnWriteArrayList;

/**
 * A loopback stand-in for github.com and api.github.com, with the device flow's
 * three endpoints. Each answer is queued by the test; the shapes follow
 * docs.github.com (Device flow and refreshing user access tokens, read 2026-10-10).
 */
final class FakeGitHub implements AutoCloseable {

    private static final ObjectMapper JSON = new ObjectMapper();

    /** One request as the fake saw it. */
    record Seen(String method, String path, Map<String, String> form, Map<String, List<String>> headers) {
    }

    /** One queued answer. The last one in a queue is repeated until a new one is queued behind it. */
    static final class Answer {
        final int status;
        final Map<String, Object> body;
        volatile boolean served;

        Answer(int status, Map<String, Object> body) {
            this.status = status;
            this.body = body;
        }
    }

    private final HttpServer server;
    private final Deque<Answer> deviceCode = new ArrayDeque<>();
    private final Deque<Answer> accessToken = new ArrayDeque<>();
    private final Deque<Answer> user = new ArrayDeque<>();
    private final List<Seen> seen = new CopyOnWriteArrayList<>();

    FakeGitHub() throws IOException {
        server = HttpServer.create(new InetSocketAddress(InetAddress.getLoopbackAddress(), 0), 0);
        server.createContext("/login/device/code", ex -> answer(ex, deviceCode));
        server.createContext("/login/oauth/access_token", ex -> answer(ex, accessToken));
        server.createContext("/user", ex -> answer(ex, user));
        server.start();
    }

    URI base() {
        return URI.create("http://127.0.0.1:" + server.getAddress().getPort());
    }

    FakeGitHub deviceCode(int status, Map<String, Object> body) {
        queue(deviceCode, new Answer(status, body));
        return this;
    }

    FakeGitHub deviceCode(String userCode) {
        return deviceCode(200, Map.of("device_code", "dc_" + "fixtureDeviceCode", "user_code", userCode,
                "verification_uri", "https://github.com/login/device", "expires_in", 900, "interval", 5));
    }

    FakeGitHub token(int status, Map<String, Object> body) {
        queue(accessToken, new Answer(status, body));
        return this;
    }

    FakeGitHub pending() {
        return token(200, Map.of("error", "authorization_pending",
                "error_description", "The authorization request is still pending."));
    }

    FakeGitHub granted(String token, long expiresIn, String refresh) {
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("access_token", token);
        body.put("token_type", "bearer");
        body.put("scope", "");
        if (expiresIn > 0) {
            body.put("expires_in", expiresIn);
            body.put("refresh_token", refresh);
            body.put("refresh_token_expires_in", 15897600);
        }
        return token(200, body);
    }

    FakeGitHub user(int status, Map<String, Object> body) {
        queue(user, new Answer(status, body));
        return this;
    }

    FakeGitHub login(String login) {
        return user(200, Map.of("login", login, "id", 1));
    }

    private static void queue(Deque<Answer> queue, Answer answer) {
        synchronized (queue) {
            if (queue.size() == 1 && queue.peek().served) {
                queue.poll();
            }
            queue.add(answer);
        }
    }

    List<Seen> seen() {
        return seen;
    }

    List<Seen> seen(String path) {
        return seen.stream().filter(s -> s.path().equals(path)).toList();
    }

    private void answer(HttpExchange ex, Deque<Answer> queue) throws IOException {
        String body = new String(ex.getRequestBody().readAllBytes(), StandardCharsets.UTF_8);
        seen.add(new Seen(ex.getRequestMethod(), ex.getRequestURI().getPath(), form(body),
                Map.copyOf(ex.getRequestHeaders())));
        Answer answer;
        synchronized (queue) {
            answer = queue.size() > 1 ? queue.poll() : queue.peek();
            if (answer != null) {
                answer.served = true;
            }
        }
        if (answer == null) {
            answer = new Answer(500, Map.of("message", "nothing queued"));
        }
        byte[] out = JSON.writeValueAsBytes(answer.body);
        ex.getResponseHeaders().add("Content-Type", "application/json; charset=utf-8");
        ex.sendResponseHeaders(answer.status, out.length);
        ex.getResponseBody().write(out);
        ex.close();
    }

    private static Map<String, String> form(String body) {
        Map<String, String> out = new LinkedHashMap<>();
        if (body.isBlank()) {
            return out;
        }
        if (body.strip().startsWith("{")) {
            try {
                JSON.readTree(body).fields().forEachRemaining(e -> out.put(e.getKey(), e.getValue().asText()));
            } catch (IOException unreadable) {
                out.put("<body>", body);
            }
            return out;
        }
        for (String pair : body.split("&")) {
            int eq = pair.indexOf('=');
            String key = URLDecoder.decode(eq < 0 ? pair : pair.substring(0, eq), StandardCharsets.UTF_8);
            String value = eq < 0 ? "" : URLDecoder.decode(pair.substring(eq + 1), StandardCharsets.UTF_8);
            out.put(key, value);
        }
        return out;
    }

    @Override
    public void close() {
        server.stop(0);
    }
}
