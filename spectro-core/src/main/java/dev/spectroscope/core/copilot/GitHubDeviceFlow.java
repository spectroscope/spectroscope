package dev.spectroscope.core.copilot;

import dev.spectroscope.core.config.governing.Governs;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;

import java.io.IOException;
import java.net.URI;
import java.net.URLEncoder;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.stream.Collectors;

/**
 * The device flow against github.com, or a GitHub host given for tests.
 *
 * <p>Three endpoints, as docs.github.com describes them (read 2026-10-10):
 * {@code POST /login/device/code} for the codes, {@code POST
 * /login/oauth/access_token} for polling and for refreshing, and {@code GET
 * /user} on the API host for the login. Every request asks for JSON. No client
 * secret is sent: the device flow takes none, and a token it produced is
 * refreshed without one. Tokens travel in request bodies and in the
 * {@code Authorization} header, never in a URL.
 */
public final class GitHubDeviceFlow implements DeviceFlow {

    /** github.com, the host of the device flow. */
    public static final URI GITHUB_WEB = URI.create("https://github.com");

    /** api.github.com, the host of the user lookup. */
    public static final URI GITHUB_API = URI.create("https://api.github.com");

    /** The scope asked for: the profile, for the login. Copilot itself needs no scope on the token. */
    public static final String SCOPE = "read:user";

    /** The grant type of a device flow poll. */
    static final String DEVICE_GRANT = "urn:ietf:params:oauth:grant-type:device_code";

    /** GitHub adds five seconds to the interval on every {@code slow_down}. */
    @Governs(kind = Governs.Kind.FOREIGN_CONTRACT, unit = Governs.Unit.SECONDS)
    static final long SLOW_DOWN_STEP_S = 5;

    private static final ObjectMapper JSON = new ObjectMapper();
    /** How long one request to GitHub may take, connecting included, before the sign-in reports it unreachable. */
    @Governs(kind = Governs.Kind.UNEXAMINED, unit = Governs.Unit.SECONDS)
    private static final Duration TIMEOUT = Duration.ofSeconds(30);

    private final String clientId;
    private final URI web;
    private final URI api;
    private final HttpClient http;
    private volatile long interval = 5;

    /**
     * A flow against the given hosts.
     *
     * @param clientId the OAuth app's client id
     * @param web      the web host, {@link #GITHUB_WEB}
     * @param api      the API host, {@link #GITHUB_API}
     * @param http     the client to send with
     */
    public GitHubDeviceFlow(String clientId, URI web, URI api, HttpClient http) {
        if (clientId == null || clientId.isBlank()) {
            throw new IllegalArgumentException("a client id is required");
        }
        this.clientId = clientId;
        this.web = web;
        this.api = api;
        this.http = http;
    }

    /**
     * The flow against github.com.
     *
     * @param clientId the OAuth app's client id
     * @return the flow against github.com
     */
    public static GitHubDeviceFlow forGitHub(String clientId) {
        return new GitHubDeviceFlow(clientId, GITHUB_WEB, GITHUB_API,
                HttpClient.newBuilder().connectTimeout(TIMEOUT).build());
    }

    @Override
    public DeviceCode start() throws IOException {
        Map<String, String> form = new LinkedHashMap<>();
        form.put("client_id", clientId);
        form.put("scope", SCOPE);
        JsonNode body = post("/login/device/code", form);
        refusal(body);
        long seconds = body.path("interval").asLong(5);
        interval = seconds;
        return new DeviceCode(text(body, "device_code"), text(body, "user_code"), text(body, "verification_uri"),
                body.path("expires_in").asLong(900), seconds);
    }

    @Override
    public Poll poll(DeviceCode code) throws IOException {
        Map<String, String> form = new LinkedHashMap<>();
        form.put("client_id", clientId);
        form.put("device_code", code.deviceCode());
        form.put("grant_type", DEVICE_GRANT);
        JsonNode body = post("/login/oauth/access_token", form);
        String error = body.path("error").asText(null);
        if (error == null) {
            return new Granted(grant(body));
        }
        return switch (error) {
            case "authorization_pending" -> new Pending();
            case "slow_down" -> {
                long next = body.hasNonNull("interval")
                        ? body.path("interval").asLong()
                        : Math.max(interval, code.intervalSeconds()) + SLOW_DOWN_STEP_S;
                interval = next;
                yield new SlowDown(next);
            }
            default -> new Denied(error, body.path("error_description").asText(null));
        };
    }

    @Override
    public Grant refresh(String refreshToken) throws IOException {
        Map<String, String> form = new LinkedHashMap<>();
        form.put("client_id", clientId);
        form.put("grant_type", "refresh_token");
        form.put("refresh_token", refreshToken);
        JsonNode body = post("/login/oauth/access_token", form);
        refusal(body);
        return grant(body);
    }

    @Override
    public String login(String accessToken) throws IOException {
        HttpRequest request = HttpRequest.newBuilder(api.resolve("/user"))
                .timeout(TIMEOUT)
                .header("Accept", "application/vnd.github+json")
                .header("Authorization", "Bearer " + accessToken)
                .header("User-Agent", "spectroscope")
                .GET()
                .build();
        HttpResponse<String> response = send(request);
        JsonNode body = parse(response.body());
        if (response.statusCode() / 100 != 2) {
            String message = body.path("message").asText(null);
            throw new Refused("HTTP " + response.statusCode(), message);
        }
        String login = body.path("login").asText(null);
        if (login == null || login.isBlank()) {
            throw new Refused("no_login", "GitHub answered without a login");
        }
        return login;
    }

    // ---- the wire -------------------------------------------------------------------------

    private JsonNode post(String path, Map<String, String> form) throws IOException {
        String encoded = form.entrySet().stream()
                .map(e -> URLEncoder.encode(e.getKey(), StandardCharsets.UTF_8) + "="
                        + URLEncoder.encode(e.getValue(), StandardCharsets.UTF_8))
                .collect(Collectors.joining("&"));
        HttpRequest request = HttpRequest.newBuilder(web.resolve(path))
                .timeout(TIMEOUT)
                .header("Accept", "application/json")
                .header("Content-Type", "application/x-www-form-urlencoded")
                .header("User-Agent", "spectroscope")
                .POST(HttpRequest.BodyPublishers.ofString(encoded))
                .build();
        HttpResponse<String> response = send(request);
        JsonNode body = parse(response.body());
        if (response.statusCode() / 100 != 2 && !body.has("error")) {
            throw new Refused("HTTP " + response.statusCode(), body.path("message").asText(null));
        }
        return body;
    }

    private HttpResponse<String> send(HttpRequest request) throws IOException {
        try {
            return http.send(request, HttpResponse.BodyHandlers.ofString(StandardCharsets.UTF_8));
        } catch (InterruptedException interrupted) {
            Thread.currentThread().interrupt();
            throw new IOException("interrupted while talking to GitHub", interrupted);
        }
    }

    private static JsonNode parse(String body) {
        try {
            JsonNode node = JSON.readTree(body == null ? "" : body);
            return node == null || node.isMissingNode() ? JSON.createObjectNode() : node;
        } catch (IOException notJson) {
            return JSON.createObjectNode();
        }
    }

    private static void refusal(JsonNode body) throws Refused {
        if (body.hasNonNull("error")) {
            throw new Refused(body.path("error").asText(), body.path("error_description").asText(null));
        }
    }

    private static Grant grant(JsonNode body) throws Refused {
        String token = body.path("access_token").asText(null);
        if (token == null || token.isBlank()) {
            throw new Refused("no_token", "GitHub answered without a token");
        }
        String refresh = body.path("refresh_token").asText(null);
        return new Grant(token, body.path("expires_in").asLong(0), refresh == null || refresh.isBlank() ? null : refresh,
                body.path("refresh_token_expires_in").asLong(0));
    }

    private static String text(JsonNode body, String field) throws Refused {
        String value = body.path(field).asText(null);
        if (value == null || value.isBlank()) {
            throw new Refused("missing_" + field, "GitHub answered without " + field);
        }
        return value;
    }
}
