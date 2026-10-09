package dev.spectroscope.server.copilot;

import dev.spectroscope.core.copilot.CopilotAccount;
import dev.spectroscope.core.copilot.CopilotCredentials;
import dev.spectroscope.core.copilot.DeviceFlow;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.setup.MockMvcBuilders;

import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Clock;
import java.time.Instant;
import java.time.ZoneOffset;
import java.util.concurrent.atomic.AtomicInteger;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

/**
 * Card 495: the sign-in sheet's endpoints. The writes wear the same two fences
 * as the key writer ({@code /api/onboarding/key}): a local Host, and an Origin
 * that is loopback or absent. A foreign origin is refused with 404.
 */
class CopilotAccountControllerTest {

    private static final String TOKEN = "gho_" + "fixtureControllerToken";

    @TempDir
    Path dir;

    private final AtomicInteger starts = new AtomicInteger();
    private CopilotCredentials store;
    private MockMvc mvc;

    /** A device flow that hands out a code and then waits forever. */
    private final class WaitingFlow implements DeviceFlow {
        @Override
        public DeviceCode start() {
            starts.incrementAndGet();
            return new DeviceCode("dc_" + "fixture", "WXYZ-9876", "https://github.com/login/device", 900, 5);
        }

        @Override
        public Poll poll(DeviceCode code) {
            return new Pending();
        }

        @Override
        public Grant refresh(String refreshToken) {
            throw new AssertionError("no refresh here");
        }

        @Override
        public String login(String accessToken) {
            return "octo-fixture";
        }
    }

    @BeforeEach
    void setUp() {
        store = new CopilotCredentials(dir.resolve("copilot-account.json"));
        CopilotAccount account = new CopilotAccount(store, new WaitingFlow(), null,
                Clock.fixed(Instant.ofEpochSecond(1_800_000_000L), ZoneOffset.UTC), seconds -> Thread.sleep(1_000));
        mvc = MockMvcBuilders.standaloneSetup(new CopilotAccountController(account)).build();
    }

    private static String body(String method) {
        return "{\"method\":\"" + method + "\"}";
    }

    @Test
    void theStatusSaysNotSignedInAndWhichWaysInExist() throws Exception {
        mvc.perform(get("http://127.0.0.1/api/copilot/account"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.state").value("NOT_SIGNED_IN"))
                .andExpect(jsonPath("$.github").value(true))
                .andExpect(jsonPath("$.cli").value(false));
    }

    @Test
    void aSignInAnswersWithTheCodeAndTheAddressAndNoDeviceCode() throws Exception {
        String answer = mvc.perform(post("http://127.0.0.1/api/copilot/account/sign-in")
                        .contentType("application/json").content(body("github")))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.state").value("WAITING"))
                .andExpect(jsonPath("$.userCode").value("WXYZ-9876"))
                .andExpect(jsonPath("$.verificationUri").value("https://github.com/login/device"))
                .andReturn().getResponse().getContentAsString();

        assertFalse(answer.contains("dc_fixture"), answer);
        mvc.perform(post("http://127.0.0.1/api/copilot/account/cancel").contentType("application/json").content("{}"))
                .andExpect(jsonPath("$.state").value("NOT_SIGNED_IN"));
    }

    @Test
    void aForeignOriginIsRefusedAndStartsNothing() throws Exception {
        mvc.perform(post("http://127.0.0.1/api/copilot/account/sign-in")
                        .header("Origin", "https://evil.example")
                        .contentType("application/json").content(body("github")))
                .andExpect(status().isNotFound());
        mvc.perform(post("http://127.0.0.1/api/copilot/account/sign-out")
                        .header("Origin", "https://evil.example")
                        .contentType("application/json").content("{}"))
                .andExpect(status().isNotFound());

        assertEquals(0, starts.get());
    }

    @Test
    void aReboundHostIsRefusedForReadsAndWrites() throws Exception {
        mvc.perform(get("http://evil.example/api/copilot/account")).andExpect(status().isNotFound());
        mvc.perform(post("http://evil.example/api/copilot/account/sign-in")
                        .contentType("application/json").content(body("github")))
                .andExpect(status().isNotFound());

        assertEquals(0, starts.get());
    }

    @Test
    void aFormPostIsNotAccepted() throws Exception {
        mvc.perform(post("http://127.0.0.1/api/copilot/account/sign-in")
                        .contentType("application/x-www-form-urlencoded").content("method=github"))
                .andExpect(status().isUnsupportedMediaType());

        assertEquals(0, starts.get());
    }

    @Test
    void anUnknownMethodIsABadRequest() throws Exception {
        mvc.perform(post("http://127.0.0.1/api/copilot/account/sign-in")
                        .contentType("application/json").content(body("password")))
                .andExpect(status().isBadRequest());
    }

    @Test
    void aSignedInStatusNamesTheLoginAndNeverTheToken() throws Exception {
        store.save(new CopilotCredentials.Stored(CopilotCredentials.Method.GITHUB, "octo-fixture", TOKEN, 0, null, 0));

        String answer = mvc.perform(get("http://127.0.0.1/api/copilot/account"))
                .andExpect(jsonPath("$.state").value("SIGNED_IN"))
                .andExpect(jsonPath("$.login").value("octo-fixture"))
                .andExpect(jsonPath("$.method").value("github"))
                .andReturn().getResponse().getContentAsString();

        assertFalse(answer.contains("fixtureControllerToken"), answer);
    }

    @Test
    void signOutDeletesTheStoredTokens() throws Exception {
        store.save(new CopilotCredentials.Stored(CopilotCredentials.Method.GITHUB, "octo-fixture", TOKEN, 0, null, 0));

        mvc.perform(post("http://127.0.0.1/api/copilot/account/sign-out")
                        .contentType("application/json").content("{}"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.state").value("NOT_SIGNED_IN"));

        assertFalse(Files.exists(store.path()));
        assertTrue(store.load().isEmpty());
    }
}
