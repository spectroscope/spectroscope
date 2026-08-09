package dev.spectroscope.server.web;

import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.Timeout;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.web.server.LocalServerPort;

import java.io.BufferedReader;
import java.io.IOException;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.net.InetAddress;
import java.net.Socket;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.TimeUnit;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;

/**
 * Proof that {@code /ws/stt} is <em>fenced</em>, as opposed to correct.
 *
 * <p>{@code LiveSttSocketHandlerTest} covers the handler's behaviour by
 * constructing it directly, so it stays green if somebody registers the endpoint
 * without {@link LocalOriginHandshakeInterceptor} — which is exactly the hole
 * card 92 was opened for, reopened on a newer endpoint. And this one is worse
 * than {@code /ws} was: an unfenced live transcription socket lets any page the
 * operator has open turn on their microphone pipeline and spend their API key.</p>
 *
 * <p>Raw socket, for the reason {@code ApiLocalFenceRegistrationTest} gives at
 * length: {@code java.net.http}'s clients refuse to set {@code Origin} and
 * {@code Host}, and those headers are the whole test.</p>
 */
@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT,
        properties = {"server.address=127.0.0.1", "SPECTRO_HUB_PORT="})
@Timeout(value = 30, unit = TimeUnit.SECONDS)
class LiveSttSocketRegistrationTest {

    @LocalServerPort
    private int port;

    @Test
    void aForeignOriginCannotOpenTheLiveTranscriptionSocket() throws IOException {
        assertEquals(403, handshakeStatus("https://evil.example.com"),
                "any page the operator has open could otherwise drive the microphone"
                        + " pipeline and spend the API key behind it");
    }

    @Test
    void aReboundHostIsRefusedOnTheHandshakeToo() throws IOException {
        assertEquals(403, handshakeStatus("http://localhost:" + port, "evil.example.com"),
                "the fence keys on the Host as well, which is the DNS-rebinding shape");
    }

    @Test
    void theLocalPageStillGetsThroughTheFence() throws IOException {
        // Without this the two refusals prove nothing: 403 is also what a
        // mistyped path would produce, so a typo would read as a working fence.
        assertNotEquals(403, handshakeStatus("http://localhost:" + port),
                "the fence must refuse foreign origins and only foreign origins");
    }

    private int handshakeStatus(String origin) throws IOException {
        return handshakeStatus(origin, "localhost:" + port);
    }

    /**
     * Opens one WebSocket handshake with the Origin and Host exactly as given.
     *
     * @param origin the Origin header value
     * @param host the Host header value
     * @return the status code from the response line — 101 when the upgrade is
     *         accepted, 403 when the fence refuses it
     * @throws IOException if the exchange fails
     */
    private int handshakeStatus(String origin, String host) throws IOException {
        try (Socket socket = new Socket(InetAddress.getLoopbackAddress(), port)) {
            socket.setSoTimeout(10_000);
            String request = "GET /ws/stt HTTP/1.1\r\n"
                    + "Host: " + host + "\r\n"
                    + "Origin: " + origin + "\r\n"
                    + "Upgrade: websocket\r\n"
                    + "Connection: Upgrade\r\n"
                    // Any 16 base64-encoded bytes; the container only echoes it back.
                    + "Sec-WebSocket-Key: c3BlY3Ryb3Njb3BlMTIzNA==\r\n"
                    + "Sec-WebSocket-Version: 13\r\n"
                    + "\r\n";
            OutputStream out = socket.getOutputStream();
            out.write(request.getBytes(StandardCharsets.US_ASCII));
            out.flush();

            BufferedReader in = new BufferedReader(
                    new InputStreamReader(socket.getInputStream(), StandardCharsets.US_ASCII));
            String responseLine = in.readLine();
            assertNotNull(responseLine, "the server closed without a response line");
            String[] parts = responseLine.split(" ", 3);
            return Integer.parseInt(parts[1]);
        }
    }
}
