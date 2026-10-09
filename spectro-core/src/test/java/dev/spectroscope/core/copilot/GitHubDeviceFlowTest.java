package dev.spectroscope.core.copilot;

import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.Timeout;

import java.net.http.HttpClient;
import java.util.List;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertInstanceOf;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

/** Card 495: the device flow speaks GitHub's documented shapes and passes GitHub's words on. */
@Timeout(value = 30, threadMode = Timeout.ThreadMode.SEPARATE_THREAD)
class GitHubDeviceFlowTest {

    private static final String CLIENT = "Iv1.fixtureclient";

    private FakeGitHub github;
    private GitHubDeviceFlow flow;

    @BeforeEach
    void setUp() throws Exception {
        github = new FakeGitHub();
        flow = new GitHubDeviceFlow(CLIENT, github.base(), github.base(), HttpClient.newHttpClient());
    }

    @AfterEach
    void tearDown() {
        github.close();
    }

    @Test
    void startAsksWithTheClientIdAndReadsTheCodes() throws Exception {
        github.deviceCode("ABCD-1234");

        DeviceFlow.DeviceCode code = flow.start();

        assertEquals("ABCD-1234", code.userCode());
        assertEquals("https://github.com/login/device", code.verificationUri());
        assertEquals(900, code.expiresInSeconds());
        assertEquals(5, code.intervalSeconds());
        FakeGitHub.Seen seen = github.seen("/login/device/code").getFirst();
        assertEquals("POST", seen.method());
        assertEquals(CLIENT, seen.form().get("client_id"));
        assertFalse(seen.form().containsKey("client_secret"), "the device flow sends no secret");
        assertTrue(seen.headers().get("Accept").getFirst().contains("application/json"), seen.headers().toString());
        assertFalse(code.toString().contains("ABCD-1234"), "the user code stays out of toString");
        assertFalse(code.toString().contains("fixtureDeviceCode"), "the device code stays out of toString");
    }

    @Test
    void pollSendsTheDeviceCodeGrantAndReadsPending() throws Exception {
        github.deviceCode("ABCD-1234").pending();

        DeviceFlow.Poll poll = flow.poll(flow.start());

        assertInstanceOf(DeviceFlow.Pending.class, poll);
        Map<String, String> form = github.seen("/login/oauth/access_token").getFirst().form();
        assertEquals("urn:ietf:params:oauth:grant-type:device_code", form.get("grant_type"));
        assertEquals("dc_fixtureDeviceCode", form.get("device_code"));
        assertEquals(CLIENT, form.get("client_id"));
        assertFalse(form.containsKey("client_secret"));
    }

    @Test
    void slowDownCarriesTheNewInterval() throws Exception {
        github.deviceCode("ABCD-1234").token(200, Map.of("error", "slow_down", "interval", 10,
                "error_description", "Too many requests have been made in the same timeframe."));

        DeviceFlow.Poll poll = flow.poll(flow.start());

        assertEquals(new DeviceFlow.SlowDown(10), poll);
    }

    @Test
    void slowDownWithoutAnIntervalAddsFiveSeconds() throws Exception {
        github.deviceCode("ABCD-1234").token(200, Map.of("error", "slow_down"));

        assertEquals(new DeviceFlow.SlowDown(10), flow.poll(flow.start()));
    }

    @Test
    void aGrantCarriesBothTokensAndTheirLifetimes() throws Exception {
        github.deviceCode("ABCD-1234").granted("ghu_" + "fixtureAccess", 28800, "ghr_" + "fixtureRefresh");

        DeviceFlow.Granted granted = assertInstanceOf(DeviceFlow.Granted.class, flow.poll(flow.start()));

        assertEquals("ghu_fixtureAccess", granted.grant().accessToken());
        assertEquals(28800, granted.grant().expiresInSeconds());
        assertEquals("ghr_fixtureRefresh", granted.grant().refreshToken());
        assertEquals(15897600, granted.grant().refreshExpiresInSeconds());
        assertFalse(granted.grant().toString().contains("fixtureAccess"));
        assertFalse(granted.grant().toString().contains("fixtureRefresh"));
    }

    @Test
    void aTokenThatDoesNotExpireHasNoRefreshToken() throws Exception {
        github.deviceCode("ABCD-1234").granted("gho_" + "fixtureAccess", 0, null);

        DeviceFlow.Granted granted = assertInstanceOf(DeviceFlow.Granted.class, flow.poll(flow.start()));

        assertEquals(0, granted.grant().expiresInSeconds());
        assertNull(granted.grant().refreshToken());
    }

    @Test
    void aRefusalKeepsGitHubsCodeAndWords() throws Exception {
        for (String[] answer : List.of(
                new String[] {"access_denied", "The authorization request was denied."},
                new String[] {"expired_token", "The device_code has expired."},
                new String[] {"device_flow_disabled", "Device flow must be explicitly enabled for this App"})) {
            github.close();
            github = new FakeGitHub();
            flow = new GitHubDeviceFlow(CLIENT, github.base(), github.base(), HttpClient.newHttpClient());
            github.deviceCode("ABCD-1234").token(200, Map.of("error", answer[0], "error_description", answer[1]));

            DeviceFlow.Poll poll = flow.poll(flow.start());

            assertEquals(new DeviceFlow.Denied(answer[0], answer[1]), poll);
        }
    }

    @Test
    void aStartRefusalIsThrownWithGitHubsWords() throws Exception {
        github.deviceCode(400, Map.of("error", "unauthorized_client",
                "error_description", "The client is not authorized to request a device code."));

        DeviceFlow.Refused refused = assertThrows(DeviceFlow.Refused.class, () -> flow.start());

        assertEquals("unauthorized_client", refused.error());
        assertEquals("The client is not authorized to request a device code.", refused.getMessage());
    }

    @Test
    void refreshSendsTheRefreshGrantWithoutASecret() throws Exception {
        github.granted("ghu_" + "fixtureNew", 28800, "ghr_" + "fixtureNewRefresh");

        DeviceFlow.Grant grant = flow.refresh("ghr_fixtureOld");

        assertEquals("ghu_fixtureNew", grant.accessToken());
        assertEquals("ghr_fixtureNewRefresh", grant.refreshToken());
        Map<String, String> form = github.seen("/login/oauth/access_token").getFirst().form();
        assertEquals("refresh_token", form.get("grant_type"));
        assertEquals("ghr_fixtureOld", form.get("refresh_token"));
        assertEquals(CLIENT, form.get("client_id"));
        assertFalse(form.containsKey("client_secret"));
    }

    @Test
    void aRefusedRefreshIsThrownWithGitHubsWords() throws Exception {
        github.token(200, Map.of("error", "bad_refresh_token",
                "error_description", "The refresh token passed is incorrect or expired."));

        DeviceFlow.Refused refused = assertThrows(DeviceFlow.Refused.class, () -> flow.refresh("ghr_x"));

        assertEquals("bad_refresh_token", refused.error());
        assertEquals("The refresh token passed is incorrect or expired.", refused.getMessage());
    }

    @Test
    void loginReadsTheUserWithTheTokenInTheHeaderOnly() throws Exception {
        github.login("octo-fixture");

        assertEquals("octo-fixture", flow.login("ghu_" + "fixtureAccess"));

        FakeGitHub.Seen seen = github.seen("/user").getFirst();
        assertEquals("GET", seen.method());
        assertEquals("Bearer ghu_fixtureAccess", seen.headers().get("Authorization").getFirst());
        assertTrue(seen.form().isEmpty());
    }

    @Test
    void aRefusedTokenAtUserIsThrownWithGitHubsMessage() throws Exception {
        github.user(401, Map.of("message", "Bad credentials", "status", "401"));

        DeviceFlow.Refused refused = assertThrows(DeviceFlow.Refused.class, () -> flow.login("ghu_x"));

        assertEquals("Bad credentials", refused.getMessage());
        assertFalse(refused.getMessage().contains("ghu_x"));
    }
}
