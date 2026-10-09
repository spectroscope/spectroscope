package dev.spectroscope.core.provider;

import com.fasterxml.jackson.databind.JsonNode;
import dev.spectroscope.core.CancelSignal;
import dev.spectroscope.core.copilot.CopilotAccount;
import dev.spectroscope.core.copilot.CopilotCredentials;
import dev.spectroscope.core.copilot.DeviceFlow;
import dev.spectroscope.core.provider.LlmProvider.ProviderEvent;
import dev.spectroscope.core.provider.LlmProvider.ProviderMessage;
import dev.spectroscope.core.provider.LlmProvider.ProviderRequest;
import dev.spectroscope.core.provider.LlmProvider.TextContent;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.Timeout;
import org.junit.jupiter.api.io.TempDir;

import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.attribute.PosixFilePermissions;
import java.time.Clock;
import java.time.Instant;
import java.time.ZoneOffset;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.atomic.AtomicInteger;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * Card 495 at the provider: what the SDK is started with for each sign-in
 * choice, and the token callback fed by the stored sign-in.
 */
@Timeout(value = 30, threadMode = Timeout.ThreadMode.SEPARATE_THREAD)
class CopilotSignInProviderTest {

    private static final String MAC = "Mac OS X";
    private static final long T0 = 1_800_000_000L;

    @TempDir
    Path dir;

    private FakeCopilotRuntime runtime;
    private CopilotProvider provider;

    @AfterEach
    void tearDown() throws Exception {
        if (provider != null) {
            provider.close();
        }
        if (runtime != null) {
            runtime.close();
        }
    }

    /** A device flow that only refreshes, and counts. */
    private static final class Refresher implements DeviceFlow {
        final AtomicInteger refreshes = new AtomicInteger();

        @Override
        public DeviceCode start() {
            throw new AssertionError("no sign-in here");
        }

        @Override
        public Poll poll(DeviceCode code) {
            throw new AssertionError("no sign-in here");
        }

        @Override
        public Grant refresh(String refreshToken) {
            refreshes.incrementAndGet();
            return new Grant("ghu_" + "fixtureFresh", 28800, "ghr_" + "fixtureNext", 15897600);
        }

        @Override
        public String login(String accessToken) {
            return "octo-fixture";
        }
    }

    private CopilotAccount account(DeviceFlow flow, CopilotAccount.Cli cli) {
        return new CopilotAccount(new CopilotCredentials(dir.resolve("copilot-account.json")), flow, cli,
                Clock.fixed(Instant.ofEpochSecond(T0), ZoneOffset.UTC), seconds -> { });
    }

    private static ProviderRequest ask(String text) {
        return new ProviderRequest("You are a test assistant.",
                List.of(new ProviderMessage(ProviderMessage.Role.USER, List.of(new TextContent(text)))),
                List.of(), 4096, new CancelSignal());
    }

    private static List<ProviderEvent> drain(Iterable<ProviderEvent> stream) {
        List<ProviderEvent> events = new ArrayList<>();
        stream.forEach(events::add);
        return events;
    }

    /** A stand-in runtime that writes down how the SDK started it, then exits. */
    private Path recordingCli() throws Exception {
        Path cli = dir.resolve("copilot");
        Files.writeString(cli, "#!/bin/sh\n"
                + "printf '%s\\n' \"$@\" > '" + dir.resolve("args") + "'\n"
                + "env > '" + dir.resolve("env") + "'\n"
                + "exit 1\n");
        Files.setPosixFilePermissions(cli, PosixFilePermissions.fromString("rwx------"));
        return cli;
    }

    @Test
    void withNoStoredTokenTheRuntimeStartsWithoutTheStoredLoginAndWithoutTokenVariables() throws Exception {
        CopilotAccount account = account(new Refresher(), null);
        provider = new CopilotProvider(account.providerOptions("auto", recordingCli().toString()), MAC, null);

        assertThrows(RuntimeException.class, () -> drain(provider.stream(ask("hi"))));

        List<String> args = Files.readAllLines(dir.resolve("args"));
        assertTrue(args.contains("--no-auto-login"), "the stored CLI login and gh stay off: " + args);
        String env = Files.readString(dir.resolve("env"));
        for (String variable : List.of("COPILOT_GITHUB_TOKEN=", "GH_TOKEN=", "GITHUB_TOKEN=",
                "COPILOT_SDK_AUTH_TOKEN=")) {
            assertFalse(env.lines().anyMatch(l -> l.startsWith(variable)), variable);
        }
        assertEquals(CopilotAccount.State.NOT_SIGNED_IN, account.status().state());
    }

    @Test
    void theCliChoiceStartsTheRuntimeWithTheStoredLogin() throws Exception {
        CopilotAccount.Cli cli = new CopilotAccount.Cli() {
            @Override
            public CopilotAccount.CliAuth auth() {
                return new CopilotAccount.CliAuth(true, "user", "octo-fixture", null);
            }

            @Override
            public dev.spectroscope.core.copilot.CopilotCliLogin.Run login() {
                throw new AssertionError("already signed in");
            }
        };
        CopilotAccount account = account(null, cli);
        account.signInWithCli();
        provider = new CopilotProvider(account.providerOptions("auto", recordingCli().toString()), MAC, null);

        assertThrows(RuntimeException.class, () -> drain(provider.stream(ask("hi"))));

        assertFalse(Files.readAllLines(dir.resolve("args")).contains("--no-auto-login"));
    }

    @Test
    void withNoStoredTokenTheRuntimeIsToldNotSignedInAndGetsNoToken() throws Exception {
        runtime = new FakeCopilotRuntime();
        CopilotAccount account = account(new Refresher(), null);
        provider = new CopilotProvider(account.providerOptions("claude-sonnet-5", null), MAC,
                runtime.cliUrl());
        List<JsonNode> answers = new CopyOnWriteArrayList<>();
        runtime.onSend(turn -> {
            answers.add(turn.callClient("gitHubToken.getToken", FakeCopilotRuntime.object(Map.of(
                    "registrationId", runtime.createParams().path("gitHubTokenProviderRegistrationId").asText(),
                    "host", "https://github.com", "sessionId", turn.sessionId(), "reason", "initial"))));
            turn.delta("ok");
            turn.usage(10, 1, 0, 0, "stop");
            turn.idle();
        });

        drain(provider.stream(ask("hi")));

        JsonNode answer = answers.getFirst();
        assertTrue(answer.path("error").path("message").asText().contains("not signed in"), answer.toString());
        assertFalse(answer.toString().contains("gh"+ "o_"), answer.toString());
    }

    @Test
    void aRefreshTheRuntimeAsksForReachesItThroughTheCallback() throws Exception {
        runtime = new FakeCopilotRuntime();
        new CopilotCredentials(dir.resolve("copilot-account.json")).save(new CopilotCredentials.Stored(
                CopilotCredentials.Method.GITHUB, "octo-fixture", "ghu_" + "fixtureShort", T0 + 30,
                "ghr_" + "fixtureRefresh", T0 + 15897600));
        Refresher flow = new Refresher();
        CopilotAccount account = account(flow, null);
        provider = new CopilotProvider(account.providerOptions("claude-sonnet-5", null), MAC,
                runtime.cliUrl());
        List<JsonNode> answers = new CopyOnWriteArrayList<>();
        runtime.onSend(turn -> {
            answers.add(turn.callClient("gitHubToken.getToken", FakeCopilotRuntime.object(Map.of(
                    "registrationId", runtime.createParams().path("gitHubTokenProviderRegistrationId").asText(),
                    "host", "https://github.com", "sessionId", turn.sessionId(), "reason", "refresh"))));
            turn.delta("ok");
            turn.usage(10, 1, 0, 0, "stop");
            turn.idle();
        });

        drain(provider.stream(ask("hi")));

        assertEquals(1, flow.refreshes.get());
        String answer = answers.getFirst().toString();
        assertTrue(answer.contains("fixtureFresh"), answer);
        assertFalse(answer.contains("fixtureShort"), answer);
    }

    private CopilotAccount signedInAccount() throws Exception {
        new CopilotCredentials(dir.resolve("copilot-account.json")).save(new CopilotCredentials.Stored(
                CopilotCredentials.Method.GITHUB, "octo-fixture", "gho_" + "fixtureAccess", 0, null, 0));
        return account(new Refresher(), null);
    }

    @Test
    void anAuthorizationErrorOfARunReachesTheAccountInTheRuntimesWords() throws Exception {
        for (String kind : List.of("authorization", "authentication")) {
            runtime = new FakeCopilotRuntime();
            CopilotAccount account = signedInAccount();
            provider = new CopilotProvider(account.providerOptions("claude-sonnet-5", null), MAC, runtime.cliUrl());
            runtime.onSend(turn -> turn.event("session.error", FakeCopilotRuntime.object(Map.of(
                    "errorType", kind, "message", "Words of the runtime for " + kind + "."))));

            assertThrows(RuntimeException.class, () -> drain(provider.stream(ask("hi"))));

            CopilotAccount.Status status = account.status();
            assertEquals(CopilotAccount.State.REFUSED, status.state(), kind);
            assertEquals("Words of the runtime for " + kind + ".", status.message(), kind);
            provider.close();
            runtime.close();
        }
        provider = null;
        runtime = null;
    }

    @Test
    void anErrorOfAnotherKindLeavesTheSignInAlone() throws Exception {
        runtime = new FakeCopilotRuntime();
        CopilotAccount account = signedInAccount();
        provider = new CopilotProvider(account.providerOptions("claude-sonnet-5", null), MAC, runtime.cliUrl());
        runtime.onSend(turn -> turn.event("session.error", FakeCopilotRuntime.object(Map.of(
                "errorType", "quota", "message", "You have no AI credits left."))));

        assertThrows(RuntimeException.class, () -> drain(provider.stream(ask("hi"))));

        assertEquals(CopilotAccount.State.SIGNED_IN, account.status().state());
    }

    @Test
    void theProviderReadsTheRuntimesAuthStatus() throws Exception {
        runtime = new FakeCopilotRuntime().authStatus(Map.of("isAuthenticated", true, "authType", "user",
                "login", "octo-fixture", "host", "https://github.com"));
        provider = new CopilotProvider(new CopilotProvider.Options("auto", null, null, false), MAC,
                runtime.cliUrl());

        CopilotProvider.AuthStatus status = provider.authStatus();

        assertEquals(new CopilotProvider.AuthStatus(true, "user", "octo-fixture", null), status);
    }

    @Test
    void theCliChoiceRefusesARuntimeThatWouldUseTheGitHubCliAccount() throws Exception {
        runtime = new FakeCopilotRuntime().authStatus(Map.of("isAuthenticated", true, "authType", "gh-cli",
                "login", "octo-fixture"));
        provider = new CopilotProvider(new CopilotProvider.Options("claude-sonnet-5", null, null, true), MAC,
                runtime.cliUrl());

        IllegalStateException refused = assertThrows(IllegalStateException.class,
                () -> drain(provider.stream(ask("hi"))));

        assertTrue(refused.getMessage().contains("not signed in"), refused.getMessage());
        assertTrue(runtime.requests("session.create").isEmpty(), "no session was opened");
    }

    @Test
    void theCliChoiceRunsWhenTheRuntimeHasItsOwnStoredLogin() throws Exception {
        runtime = new FakeCopilotRuntime().authStatus(Map.of("isAuthenticated", true, "authType", "user",
                "login", "octo-fixture"));
        provider = new CopilotProvider(new CopilotProvider.Options("claude-sonnet-5", null, null, true), MAC,
                runtime.cliUrl());
        runtime.onSend(turn -> {
            turn.delta("ok");
            turn.usage(10, 1, 0, 0, "stop");
            turn.idle();
        });

        List<ProviderEvent> events = drain(provider.stream(ask("hi")));

        assertEquals(new LlmProvider.PTextDelta("ok"), events.getFirst());
    }

    @Test
    void neitherATokenSourceNorTheStoredLoginIsNotSignedInBeforeAnythingStarts() {
        provider = new CopilotProvider(new CopilotProvider.Options("auto", dir.resolve("never-run").toString(),
                null, false), MAC, null);

        IllegalStateException refused = assertThrows(IllegalStateException.class,
                () -> drain(provider.stream(ask("hi"))));

        assertTrue(refused.getMessage().contains("not signed in"), refused.getMessage());
    }
}
