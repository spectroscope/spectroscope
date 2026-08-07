package dev.spectroscope.server;

import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.Timeout;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.web.server.LocalServerPort;
import org.springframework.boot.web.servlet.FilterRegistrationBean;
import org.springframework.context.ApplicationContext;

import java.io.BufferedReader;
import java.io.IOException;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.net.InetAddress;
import java.net.Socket;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.TimeUnit;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * Proof that {@link ApiLocalFence} is <em>registered</em>, as opposed to
 * correct. {@code ApiLocalFenceTest} already covers the logic, and it does so by
 * constructing the filter itself — so it stays green through a total
 * deregistration, which is the one failure this class exists to catch.
 *
 * <p>Why that matters now: the package split (card 186) moves fifty-odd classes,
 * and the fence is discovered by component scan alone. Nothing in the compiler
 * notices a bean that stopped being found. The symptom would be every
 * {@code /api} path answering a rebound {@code Host} again — the v0.6.1 hole
 * verbatim — while the suite stayed green.</p>
 *
 * <h2>Why a raw socket and not MockMvc or a REST client</h2>
 *
 * <p>Two of the three requests here cannot be staged any other way:</p>
 * <ul>
 *   <li>{@code MockMvc}'s standalone setup never decodes the target, so it
 *       cannot pose {@code /%61pi/config} at all — the same blind spot that let
 *       the v0.6.1 bypass survive a green suite.</li>
 *   <li>A {@code RestTemplate} or {@code java.net.http.HttpClient} normalises
 *       the path, so the percent-escape would not survive to the container.
 *       {@code HttpClient} additionally refuses to set {@code Host}, which is
 *       a restricted header — and {@code Host} is the whole attack.</li>
 * </ul>
 *
 * <p>Writing the request line onto a socket is the only form where the bytes
 * the container reads are the bytes this test wrote.</p>
 */
@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT,
        // Pinned blank for the same reason SpectroServerIntegrationTest pins it:
        // an inlined property beats the OS environment, so a shell exporting
        // SPECTRO_HUB_PORT cannot turn the hub on underneath this test.
        properties = {"server.address=127.0.0.1", "SPECTRO_HUB_PORT="})
@Timeout(value = 30, unit = TimeUnit.SECONDS)
class ApiLocalFenceRegistrationTest {

    @Autowired
    private ApplicationContext context;

    @LocalServerPort
    private int port;

    @Test
    void theContextHoldsExactlyOneFence() {
        assertEquals(1, context.getBeansOfType(ApiLocalFence.class).size(),
                "the fence must be discovered by component scan exactly once — zero means every"
                        + " /api path answers a rebound Host again");
    }

    @Test
    void noFilterRegistrationBeanWrapsTheFence() {
        // The standing rule, asserted rather than written down: Boot registers any
        // Filter bean at /* on its own. Adding a FilterRegistrationBean "to be safe"
        // during the move is the tempting mistake, and a bean COUNT does not catch
        // it — Boot suppresses its own auto-registration when a registration bean
        // references the filter, so getBeansOfType still answers 1 either way.
        boolean wrapped = context.getBeansOfType(FilterRegistrationBean.class).values().stream()
                .anyMatch(registration -> registration.getFilter() instanceof ApiLocalFence);
        assertTrue(!wrapped,
                "ApiLocalFence must be registered by component scan alone; an explicit"
                        + " FilterRegistrationBean risks running it twice, and the second"
                        + " chain.doFilter on an already-committed 404 throws an"
                        + " IllegalStateException that the container swallows");
    }

    @Test
    void aReboundHostIsRefused() throws IOException {
        assertEquals(404, statusOf("/api/config", "evil.example.com"),
                "a loopback peer carrying an attacker's Host is the DNS-rebinding shape");
    }

    @Test
    void anEncodedPrefixFromAReboundHostIsRefused() throws IOException {
        // /%61pi/ carries no literal "/api/". A fence matching the raw target waves
        // it through while the container dispatches on the decoded path and hands
        // it to the handler. Measured live against the first cut of the filter:
        // 200 with the full config body, and a DELETE that took a session off disk.
        assertEquals(404, statusOf("/%61pi/config", "evil.example.com"),
                "the fence must read the path the MAPPING reads, not the raw target");
    }

    @Test
    void aLocalhostHostStillReachesTheHandler() throws IOException {
        // Without this, the two 404s above prove nothing: a 404 is also what a
        // route that does not exist answers, so a typo in the path would read as
        // a working fence.
        assertEquals(200, statusOf("/api/config", "localhost:" + port),
                "the fence must refuse the rebound Host and only the rebound Host");
    }

    /**
     * Sends one HTTP/1.1 request over a loopback socket with the target and Host
     * exactly as given, and returns the status code.
     *
     * @param rawTarget the request target, written verbatim — never normalised
     * @param host      the Host header value
     * @return the status code from the response line
     * @throws IOException if the exchange fails
     */
    private int statusOf(String rawTarget, String host) throws IOException {
        try (Socket socket = new Socket(InetAddress.getLoopbackAddress(), port)) {
            socket.setSoTimeout(10_000);
            String request = "GET " + rawTarget + " HTTP/1.1\r\n"
                    + "Host: " + host + "\r\n"
                    + "Connection: close\r\n"
                    + "\r\n";
            OutputStream out = socket.getOutputStream();
            out.write(request.getBytes(StandardCharsets.US_ASCII));
            out.flush();

            BufferedReader in = new BufferedReader(
                    new InputStreamReader(socket.getInputStream(), StandardCharsets.US_ASCII));
            String responseLine = in.readLine();
            assertNotNull(responseLine, "the server closed without a response line");
            String[] parts = responseLine.split(" ", 3);
            assertEquals(3, parts.length >= 3 ? 3 : parts.length,
                    "unexpected response line: " + responseLine);
            return Integer.parseInt(parts[1]);
        }
    }
}
