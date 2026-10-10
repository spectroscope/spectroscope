package dev.spectroscope.core.copilot;

import dev.spectroscope.core.provider.CopilotProvider;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.Timeout;
import org.junit.jupiter.api.io.TempDir;

import java.io.IOException;
import java.net.http.HttpClient;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.attribute.PosixFilePermissions;
import java.time.Clock;
import java.time.Instant;
import java.time.ZoneId;
import java.time.ZoneOffset;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicLong;
import java.util.concurrent.atomic.AtomicReference;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNotSame;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertSame;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * Card 495: the sign-in sheet's account. The device flow runs against a fake
 * GitHub, the Copilot CLI side against a fake, and the clock is set by hand, so
 * a token can be made to expire in thirty seconds.
 */
@Timeout(value = 30, threadMode = Timeout.ThreadMode.SEPARATE_THREAD)
class CopilotAccountTest {

    private static final long T0 = 1_800_000_000L;

    @TempDir
    Path home;

    private FakeGitHub github;
    private SetClock clock;
    private final List<Long> sleeps = new CopyOnWriteArrayList<>();
    private CopilotCredentials store;
    private CopilotAccount account;

    /** A clock the test moves. */
    static final class SetClock extends Clock {
        final AtomicLong epochSecond = new AtomicLong(T0);

        @Override
        public ZoneId getZone() {
            return ZoneOffset.UTC;
        }

        @Override
        public Clock withZone(ZoneId zone) {
            return this;
        }

        @Override
        public Instant instant() {
            return Instant.ofEpochSecond(epochSecond.get());
        }
    }

    /** A Copilot CLI side the test scripts. */
    static final class FakeCli implements CopilotAccount.Cli {
        final AtomicReference<CopilotAccount.CliAuth> auth = new AtomicReference<>(
                new CopilotAccount.CliAuth(false, null, null, "Not authenticated"));
        final AtomicInteger logins = new AtomicInteger();
        final AtomicInteger authCalls = new AtomicInteger();
        final CompletableFuture<CopilotCliLogin.Prompt> prompt = new CompletableFuture<>();
        final CompletableFuture<CopilotCliLogin.Outcome> outcome = new CompletableFuture<>();
        volatile boolean cancelled;

        @Override
        public CopilotAccount.CliAuth auth() {
            authCalls.incrementAndGet();
            return auth.get();
        }

        @Override
        public CopilotCliLogin.Run login() {
            logins.incrementAndGet();
            return new CopilotCliLogin.Run() {
                @Override
                public CompletableFuture<CopilotCliLogin.Prompt> prompt() {
                    return prompt;
                }

                @Override
                public CompletableFuture<CopilotCliLogin.Outcome> outcome() {
                    return outcome;
                }

                @Override
                public void cancel() {
                    cancelled = true;
                    outcome.complete(new CopilotCliLogin.Outcome(false, null, "cancelled"));
                }
            };
        }
    }

    @BeforeEach
    void setUp() throws Exception {
        github = new FakeGitHub();
        clock = new SetClock();
        store = new CopilotCredentials(home.resolve(".spectro").resolve("copilot-account.json"));
        account = account(null);
    }

    @AfterEach
    void tearDown() {
        account.cancel();
        github.close();
    }

    private CopilotAccount account(CopilotAccount.Cli cli) {
        DeviceFlow flow = new GitHubDeviceFlow("Iv1.fixtureclient", github.base(), github.base(),
                HttpClient.newHttpClient());
        return new CopilotAccount(store, flow, cli, clock, seconds -> {
            sleeps.add(seconds);
            Thread.sleep(2);
        });
    }

    private CopilotAccount.Status settled() throws InterruptedException {
        long deadline = System.nanoTime() + 5_000_000_000L;
        CopilotAccount.Status status = account.status();
        while (status.state() == CopilotAccount.State.WAITING && System.nanoTime() < deadline) {
            Thread.sleep(5);
            status = account.status();
        }
        return status;
    }

    private void signInAs(String login, String token, long expiresIn, String refresh) throws Exception {
        github.deviceCode("ABCD-1234").granted(token, expiresIn, refresh).login(login);
        account.signInWithGitHub();
        assertEquals(CopilotAccount.State.SIGNED_IN, settled().state());
    }

    // ---- the device flow -------------------------------------------------------------

    @Test
    void nothingStoredIsNotSignedIn() {
        CopilotAccount.Status status = account.status();

        assertEquals(CopilotAccount.State.NOT_SIGNED_IN, status.state());
        assertNull(status.login());
        assertNull(status.method());
    }

    @Test
    void theSheetGetsTheCodeAndTheAddressWhileItWaits() throws Exception {
        github.deviceCode("ABCD-1234").pending();

        CopilotAccount.Status waiting = account.signInWithGitHub();

        assertEquals(CopilotAccount.State.WAITING, waiting.state());
        assertEquals("ABCD-1234", waiting.userCode());
        assertEquals("https://github.com/login/device", waiting.verificationUri());
        assertEquals(T0 + 900, waiting.expiresAt());
        assertEquals("github", waiting.method());
        assertEquals(waiting, account.status(), "status repeats it while the poll goes on");
    }

    @Test
    void aConfirmedCodeSignsInAsTheLoginAndTheFileIsOwnerOnly() throws Exception {
        github.deviceCode("ABCD-1234").pending().granted("gho_" + "fixtureAccess", 0, null).login("octo-fixture");

        account.signInWithGitHub();
        CopilotAccount.Status status = settled();

        assertEquals(CopilotAccount.State.SIGNED_IN, status.state());
        assertEquals("octo-fixture", status.login());
        assertEquals("github", status.method());
        assertNull(status.userCode(), "the code is gone once it was used");
        assertEquals("rw-------", PosixFilePermissions.toString(Files.getPosixFilePermissions(store.path())));
        assertTrue(Files.readString(store.path()).contains("fixtureAccess"));
    }

    @Test
    void thePollWaitsTheIntervalAndSlowsDownWhenGitHubAsks() throws Exception {
        github.deviceCode("ABCD-1234")
                .token(200, Map.of("error", "slow_down", "interval", 10))
                .granted("gho_" + "fixtureAccess", 0, null).login("octo-fixture");

        account.signInWithGitHub();
        settled();

        assertEquals(List.of(5L, 10L), sleeps);
    }

    @Test
    void aRefusalIsReportedInGitHubsWordsAndNothingIsStored() throws Exception {
        for (String[] answer : List.of(
                new String[] {"access_denied", "The authorization request was denied."},
                new String[] {"expired_token", "The device_code has expired."})) {
            github.close();
            github = new FakeGitHub();
            account = account(null);
            github.deviceCode("ABCD-1234").token(200, Map.of("error", answer[0], "error_description", answer[1]));

            account.signInWithGitHub();
            CopilotAccount.Status status = settled();

            assertEquals(CopilotAccount.State.REFUSED, status.state(), answer[0]);
            assertEquals(answer[1], status.message());
            assertFalse(Files.exists(store.path()));
        }
    }

    @Test
    void aRefusedStartIsReportedInGitHubsWords() {
        github.deviceCode(200, Map.of("error", "device_flow_disabled",
                "error_description", "Device flow must be explicitly enabled for this App"));

        CopilotAccount.Status status = account.signInWithGitHub();

        assertEquals(CopilotAccount.State.REFUSED, status.state());
        assertEquals("Device flow must be explicitly enabled for this App", status.message());
    }

    @Test
    void aTokenGitHubRefusesAtUserIsNotStored() throws Exception {
        github.deviceCode("ABCD-1234").granted("gho_" + "fixtureAccess", 0, null)
                .user(401, Map.of("message", "Bad credentials"));

        account.signInWithGitHub();
        CopilotAccount.Status status = settled();

        assertEquals(CopilotAccount.State.REFUSED, status.state());
        assertEquals("Bad credentials", status.message());
        assertFalse(Files.exists(store.path()));
    }

    @Test
    void aCodeGitHubStillCallsPendingAfterItsLifetimeEndsTheWaitInTheAppsOwnWords() throws Exception {
        github.deviceCode("ABCD-1234").pending();
        account = new CopilotAccount(store, new GitHubDeviceFlow("Iv1.fixtureclient", github.base(), github.base(),
                HttpClient.newHttpClient()), null, clock, seconds -> clock.epochSecond.addAndGet(seconds));

        account.signInWithGitHub();
        CopilotAccount.Status status = settled();

        assertEquals(CopilotAccount.State.REFUSED, status.state());
        assertEquals("The code expired before it was confirmed.", status.message());
        assertTrue(clock.epochSecond.get() > T0 + 900, "the clock passed the code's lifetime");
        assertFalse(Files.exists(store.path()));
    }

    @Test
    void cancelStopsTheWaitAndStoresNothing() throws Exception {
        github.deviceCode("ABCD-1234").pending();
        account.signInWithGitHub();

        CopilotAccount.Status status = account.cancel();

        assertEquals(CopilotAccount.State.NOT_SIGNED_IN, status.state());
        Thread.sleep(50);
        assertEquals(CopilotAccount.State.NOT_SIGNED_IN, account.status().state());
        assertFalse(Files.exists(store.path()));
    }

    @Test
    void withoutAnOAuthAppTheGitHubSignInSaysSo() {
        CopilotAccount none = new CopilotAccount(store, null, null, clock, seconds -> { });

        CopilotAccount.Status status = none.signInWithGitHub();

        assertEquals(CopilotAccount.State.REFUSED, status.state());
        assertTrue(status.message().contains("OAuth app"), status.message());
        assertFalse(none.gitHubAvailable());
    }

    // ---- sign out and a second account -----------------------------------------------

    @Test
    void signOutDeletesTheTokensAndTheStatusReturnsToNotSignedIn() throws Exception {
        signInAs("octo-fixture", "gho_" + "fixtureAccess", 0, null);

        CopilotAccount.Status status = account.signOut();

        assertEquals(CopilotAccount.State.NOT_SIGNED_IN, status.state());
        assertFalse(Files.exists(store.path()));
        assertEquals(CopilotAccount.State.NOT_SIGNED_IN, account.status().state());
    }

    @Test
    void aSecondSignInWithAnotherAccountReplacesTheFirst() throws Exception {
        signInAs("octo-fixture", "gho_" + "fixtureFirst", 0, null);
        github.close();
        github = new FakeGitHub();
        account = account(null);

        signInAs("other-fixture", "gho_" + "fixtureSecond", 0, null);

        assertEquals("other-fixture", account.status().login());
        String file = Files.readString(store.path());
        assertTrue(file.contains("fixtureSecond"));
        assertFalse(file.contains("fixtureFirst"));
    }

    // ---- the token source --------------------------------------------------------------

    @Test
    void withNoStoredTokenTheSourceSaysNotSignedInAndAsksNobody() {
        CopilotAccount.NotSignedIn refused = assertThrows(CopilotAccount.NotSignedIn.class,
                () -> account.tokenSource().token("https://github.com", "initial"));

        assertTrue(refused.getMessage().toLowerCase().contains("not signed in"), refused.getMessage());
        assertTrue(github.seen().isEmpty(), "no request went out");
    }

    @Test
    void aTokenThatDoesNotExpireIsHandedOutForEightHours() throws Exception {
        signInAs("octo-fixture", "gho_" + "fixtureAccess", 0, null);

        CopilotProvider.Token token = account.tokenSource().token("https://github.com", "initial");

        assertEquals("gho_fixtureAccess", token.value());
        assertEquals(8 * 60 * 60, token.expiresInSeconds());
    }

    @Test
    void aTokenWithMoreThanAnHourLeftIsNotRefreshed() throws Exception {
        signInAs("octo-fixture", "ghu_" + "fixtureAccess", 28800, "ghr_" + "fixtureRefresh");
        int before = github.seen("/login/oauth/access_token").size();
        clock.epochSecond.addAndGet(28800 - 7200);

        CopilotProvider.Token token = account.tokenSource().token("https://github.com", "refresh");

        assertEquals("ghu_fixtureAccess", token.value());
        assertEquals(7200, token.expiresInSeconds());
        assertEquals(before, github.seen("/login/oauth/access_token").size(), "no refresh was sent");
    }

    @Test
    void aTokenWithExactlyAnHourLeftIsRefreshed() throws Exception {
        signInAs("octo-fixture", "ghu_" + "fixtureAccess", 28800, "ghr_" + "fixtureRefresh");
        clock.epochSecond.addAndGet(28800 - 3600);
        github.granted("ghu_" + "fixtureFresh", 28800, "ghr_" + "fixtureRefresh2");

        CopilotProvider.Token token = account.tokenSource().token("https://github.com", "refresh");

        assertEquals("ghu_fixtureFresh", token.value(), "one hour or less remaining is the refresh mark");
    }

    @Test
    void aShortLivedTokenIsRefreshedBeforeItExpiresAndTheNewOneIsStored() throws Exception {
        signInAs("octo-fixture", "ghu_" + "fixtureShort", 28800, "ghr_" + "fixtureRefresh");
        clock.epochSecond.addAndGet(28800 - 30);
        github.granted("ghu_" + "fixtureFresh", 28800, "ghr_" + "fixtureRefresh2");

        CopilotProvider.Token token = account.tokenSource().token("https://github.com", "refresh");

        assertEquals("ghu_fixtureFresh", token.value());
        assertEquals(28800, token.expiresInSeconds());
        FakeGitHub.Seen refresh = github.seen("/login/oauth/access_token").getLast();
        assertEquals("refresh_token", refresh.form().get("grant_type"));
        assertEquals("ghr_fixtureRefresh", refresh.form().get("refresh_token"));
        CopilotCredentials.Stored stored = store.load().orElseThrow();
        assertEquals("ghu_fixtureFresh", stored.accessToken());
        assertEquals("ghr_fixtureRefresh2", stored.refreshToken());
        assertEquals("octo-fixture", stored.login(), "the login stays");
        assertEquals("rw-------", PosixFilePermissions.toString(Files.getPosixFilePermissions(store.path())));
    }

    @Test
    void anExpiredTokenWhoseRefreshIsRefusedEndsTheSignInWithGitHubsWords() throws Exception {
        signInAs("octo-fixture", "ghu_" + "fixtureShort", 28800, "ghr_" + "fixtureRefresh");
        clock.epochSecond.addAndGet(28800 + 1);
        github.token(200, Map.of("error", "bad_refresh_token",
                "error_description", "The refresh token passed is incorrect or expired."));

        IOException refused = assertThrows(IOException.class,
                () -> account.tokenSource().token("https://github.com", "refresh"));

        assertEquals("The refresh token passed is incorrect or expired.", refused.getMessage());
        CopilotAccount.Status status = account.status();
        assertEquals(CopilotAccount.State.NOT_SIGNED_IN, status.state());
        assertEquals("The refresh token passed is incorrect or expired.", status.message());
    }

    // ---- a refusal that comes with a run -------------------------------------------------

    @Test
    void aRunRefusedForAuthorizationShowsInTheStatusInTheRuntimesWords() throws Exception {
        signInAs("octo-fixture", "gho_" + "fixtureAccess", 0, null);

        account.tokenSource().refused("Words of the runtime about the missing subscription.");
        CopilotAccount.Status status = account.status();

        assertEquals(CopilotAccount.State.REFUSED, status.state());
        assertEquals("github", status.method());
        assertEquals("Words of the runtime about the missing subscription.", status.message());
        assertTrue(Files.exists(store.path()), "the token stays, an SSO authorisation can make it work");
    }

    @Test
    void aSecondSignInOnTheSameAccountClearsTheRunRefusal() throws Exception {
        signInAs("octo-fixture", "gho_" + "fixtureAccess", 0, null);
        account.tokenSource().refused("Words of the runtime.");

        github.deviceCode("EFGH-5678").granted("gho_" + "fixtureAgain", 0, null).login("octo-fixture");
        account.signInWithGitHub();

        assertEquals(CopilotAccount.State.SIGNED_IN, settled().state());
        assertNull(account.status().message());
    }

    @Test
    void signOutClearsARunRefusal() throws Exception {
        signInAs("octo-fixture", "gho_" + "fixtureAccess", 0, null);
        account.tokenSource().refused("Words of the runtime.");

        CopilotAccount.Status status = account.signOut();

        assertEquals(CopilotAccount.State.NOT_SIGNED_IN, status.state());
        assertNull(status.message());
    }

    @Test
    void theMachineHasOneAccountSoTheSheetAndTheProviderShareIt() {
        assertSame(CopilotAccount.forThisMachine(), CopilotAccount.forThisMachine());
    }

    // ---- what the provider is built with -------------------------------------------------

    @Test
    void withNoSignInTheProviderGetsTheSourceAndNeverTheStoredLogin() {
        CopilotProvider.Options options = account.providerOptions("auto", "/opt/homebrew/bin/copilot");

        assertNotNull(options.tokenSource(), "credentials come only through the callback");
        assertFalse(options.useStoredLogin(), "the CLI and gh fallback stay off");
        assertEquals("/opt/homebrew/bin/copilot", options.cliPath());
        assertEquals("auto", options.model());
    }

    @Test
    void aGitHubSignInGivesTheProviderTheSource() throws Exception {
        signInAs("octo-fixture", "gho_" + "fixtureAccess", 0, null);

        CopilotProvider.Options options = account.providerOptions("auto", "/x/copilot");

        assertFalse(options.useStoredLogin());
        assertEquals("gho_fixtureAccess", options.tokenSource().token("https://github.com", "initial").value());
    }

    @Test
    void theAccountBuildsTheProviderWithItsOwnCredentialChoice() throws Exception {
        try (CopilotProvider provider = account.provider("auto", "/x/copilot")) {
            CopilotProvider.Options options = provider.options();

            assertNotNull(options.tokenSource(), "credentials come only through the callback");
            assertFalse(options.useStoredLogin(), "the CLI and gh fallback stay off");
            assertEquals("/x/copilot", options.cliPath());
        }
    }

    // ---- card 496: one provider per model and runtime, and a cheap stored check ---------

    @Test
    void theSharedProviderIsOnePerModelAndRuntime() throws Exception {
        CopilotProvider first = account.shared("auto", "/x/copilot");

        assertSame(first, account.shared("auto", "/x/copilot"), "a second chat reuses the runtime");
        assertNotSame(first, account.shared("claude-sonnet-5", "/x/copilot"));
        assertNotSame(first, account.shared("auto", "/y/copilot"));
        assertNotNull(first.options().tokenSource(), "built with the account's credential choice");
    }

    // ---- review of 2026-10-10: the model list starts no runtime that stays ------------

    @Test
    void aQuestionIsAskedOfARuntimeAChatAlreadyStartedAndNothingIsClosed() {
        CopilotProvider chat = account.shared("claude-sonnet-5", "/x/copilot");
        List<CopilotProvider> closed = new ArrayList<>();

        CopilotProvider asked = account.askRuntime("auto", "/x/copilot", p -> p, closed::add);

        assertSame(chat, asked, "the chat's runtime answers; no second one starts");
        assertEquals(List.of(), closed);
    }

    @Test
    void withNoChatRunningTheQuestionGetsItsOwnProviderWhichIsClosedAfterwards() {
        List<CopilotProvider> closed = new ArrayList<>();

        CopilotProvider asked = account.askRuntime("auto", "/x/copilot", p -> p, closed::add);

        assertEquals("auto", asked.options().model());
        assertEquals(List.of(asked), closed, "the runtime it started goes with the answer");
        assertNotSame(asked, account.shared("auto", "/x/copilot"), "and it is not kept for the chats");
    }

    @Test
    void aRuntimeOfAnotherPathIsNotAsked() {
        CopilotProvider other = account.shared("auto", "/y/copilot");
        List<CopilotProvider> closed = new ArrayList<>();

        CopilotProvider asked = account.askRuntime("auto", "/x/copilot", p -> p, closed::add);

        assertNotSame(other, asked);
        assertEquals(List.of(asked), closed);
    }

    @Test
    void aProviderOfAnEarlierCredentialChoiceIsNotAsked() throws Exception {
        FakeCli cli = new FakeCli();
        cli.auth.set(new CopilotAccount.CliAuth(true, "user", "octo-fixture", null));
        account = account(cli);
        CopilotProvider beforeSignIn = account.shared("auto", "/x/copilot");
        account.signInWithCli();
        List<CopilotProvider> closed = new ArrayList<>();

        CopilotProvider asked = account.askRuntime("auto", "/x/copilot", p -> p, closed::add);

        assertNotSame(beforeSignIn, asked);
        assertTrue(asked.options().useStoredLogin(), "asked under the choice the user holds now");
        assertEquals(List.of(asked), closed);
    }

    @Test
    void aQuestionThatFailsStillClosesTheProviderItStarted() {
        List<CopilotProvider> closed = new ArrayList<>();

        assertThrows(IllegalStateException.class, () -> account.askRuntime("auto", "/x/copilot", p -> {
            throw new IllegalStateException("runtime refused");
        }, closed::add));

        assertEquals(1, closed.size());
    }

    @Test
    void aChangedCredentialChoiceHandsOutANewSharedProvider() throws Exception {
        FakeCli cli = new FakeCli();
        cli.auth.set(new CopilotAccount.CliAuth(true, "user", "octo-fixture", null));
        account = account(cli);
        CopilotProvider beforeSignIn = account.shared("auto", "/x/copilot");

        account.signInWithCli();
        CopilotProvider afterSignIn = account.shared("auto", "/x/copilot");

        assertNotSame(beforeSignIn, afterSignIn, "the CLI choice needs a provider with the stored login");
        assertTrue(afterSignIn.options().useStoredLogin());
        account.signOut();
        CopilotProvider afterSignOut = account.shared("auto", "/x/copilot");
        assertNotSame(afterSignIn, afterSignOut);
        assertFalse(afterSignOut.options().useStoredLogin());
    }

    @Test
    void theStoredSignInIsReadWithoutAskingTheRuntime() throws Exception {
        FakeCli cli = new FakeCli();
        account = account(cli);
        assertFalse(account.hasStoredSignIn(), "nothing stored");

        cli.auth.set(new CopilotAccount.CliAuth(true, "user", "octo-fixture", null));
        account.signInWithCli();
        cli.auth.set(null);
        assertTrue(account.hasStoredSignIn(), "the CLI choice is stored; the runtime is not asked");

        account.signOut();
        assertFalse(account.hasStoredSignIn());
        account = account(null);
        signInAs("octo-fixture", "gho_fixtureAccess", 28_800, null);
        assertTrue(account.hasStoredSignIn());
        clock.epochSecond.addAndGet(28_801);
        assertFalse(account.hasStoredSignIn(), "an expired token without a refresh token is no sign-in");
    }

    // ---- the Copilot CLI's own sign-in ----------------------------------------------------

    @Test
    void anExistingCliSignInIsTakenWithoutANewLogin() throws Exception {
        FakeCli cli = new FakeCli();
        cli.auth.set(new CopilotAccount.CliAuth(true, "user", "octo-fixture", null));
        account = account(cli);

        CopilotAccount.Status status = account.signInWithCli();

        assertEquals(CopilotAccount.State.SIGNED_IN, status.state());
        assertEquals("cli", status.method());
        assertEquals("octo-fixture", status.login());
        assertEquals(0, cli.logins.get());
        assertEquals(CopilotCredentials.Method.CLI, store.load().orElseThrow().method());
        assertNull(store.load().orElseThrow().accessToken(), "no token is copied out of the CLI");
        CopilotProvider.Options options = account.providerOptions("auto", "/x/copilot");
        assertTrue(options.useStoredLogin());
        assertNull(options.tokenSource());
    }

    @Test
    void theGitHubCliFallbackIsNotTakenAsACliSignIn() throws Exception {
        FakeCli cli = new FakeCli();
        cli.auth.set(new CopilotAccount.CliAuth(true, "gh-cli", "octo-fixture", null));
        account = account(cli);
        cli.prompt.complete(new CopilotCliLogin.Prompt("https://github.com/login/device", "2B8A-BAC6"));

        CopilotAccount.Status status = account.signInWithCli();

        assertEquals(CopilotAccount.State.WAITING, status.state());
        assertEquals("2B8A-BAC6", status.userCode());
        assertEquals("https://github.com/login/device", status.verificationUri());
        assertEquals(1, cli.logins.get(), "the CLI's own device flow runs instead");
        assertFalse(Files.exists(store.path()));
    }

    @Test
    void theCliDeviceFlowEndsSignedInAsTheLoginTheRuntimeReports() throws Exception {
        FakeCli cli = new FakeCli();
        account = account(cli);
        cli.prompt.complete(new CopilotCliLogin.Prompt("https://github.com/login/device", "2B8A-BAC6"));
        account.signInWithCli();

        cli.auth.set(new CopilotAccount.CliAuth(true, "user", "octo-fixture", null));
        cli.outcome.complete(new CopilotCliLogin.Outcome(true, "octo-fixture", null));
        CopilotAccount.Status status = settled();

        assertEquals(CopilotAccount.State.SIGNED_IN, status.state());
        assertEquals("octo-fixture", status.login());
        assertEquals("cli", status.method());
    }

    @Test
    void aFailedCliLoginIsReportedInTheCliWords() throws Exception {
        FakeCli cli = new FakeCli();
        account = account(cli);
        cli.prompt.complete(new CopilotCliLogin.Prompt("https://github.com/login/device", "D3CD-CEDC"));
        account.signInWithCli();

        cli.outcome.complete(new CopilotCliLogin.Outcome(false, null,
                "Error: Device code expired before authorization completed"));
        CopilotAccount.Status status = settled();

        assertEquals(CopilotAccount.State.REFUSED, status.state());
        assertEquals("Error: Device code expired before authorization completed", status.message());
    }

    @Test
    void aCliSignInThatTheRuntimeNoLongerReportsIsNotSignedIn() throws Exception {
        FakeCli cli = new FakeCli();
        cli.auth.set(new CopilotAccount.CliAuth(true, "user", "octo-fixture", null));
        account = account(cli);
        account.signInWithCli();

        cli.auth.set(new CopilotAccount.CliAuth(true, "gh-cli", "octo-fixture", null));
        CopilotAccount.Status status = account.recheck();

        assertEquals(CopilotAccount.State.NOT_SIGNED_IN, status.state());
        assertEquals("cli", status.method());
    }

    @Test
    void signingOutOfTheCliChoiceLeavesTheCliAlone() throws Exception {
        FakeCli cli = new FakeCli();
        cli.auth.set(new CopilotAccount.CliAuth(true, "user", "octo-fixture", null));
        account = account(cli);
        account.signInWithCli();

        CopilotAccount.Status status = account.signOut();

        assertEquals(CopilotAccount.State.NOT_SIGNED_IN, status.state());
        assertFalse(Files.exists(store.path()));
        assertEquals(0, cli.logins.get(), "nothing was run against the CLI");
        assertTrue(cli.auth().authenticated(), "the CLI keeps its own sign-in");
        assertFalse(account.providerOptions("auto", "/x/copilot").useStoredLogin());
    }

    @Test
    void withoutARuntimeTheCliSignInSaysSo() {
        CopilotAccount.Status status = account.signInWithCli();

        assertEquals(CopilotAccount.State.REFUSED, status.state());
        assertTrue(status.message().contains("Copilot CLI"), status.message());
    }

    // ---- card 495, final round: the CLI device flow is the shipped sign-in ----

    @Test
    void theCliDeviceFlowShowsTheCodeThenPollsTheRuntimeUntilItReportsTheLogin() throws Exception {
        // The CLI process does not need to end: the runtime's sign-in status decides.
        FakeCli cli = new FakeCli();
        account = account(cli);
        cli.prompt.complete(new CopilotCliLogin.Prompt("https://github.com/login/device", "2B8A-BAC6"));

        CopilotAccount.Status waiting = account.signInWithCli();
        assertEquals(CopilotAccount.State.WAITING, waiting.state());
        assertEquals("2B8A-BAC6", waiting.userCode());
        assertEquals("https://github.com/login/device", waiting.verificationUri());
        assertEquals("cli", waiting.method());
        Thread.sleep(50);
        assertEquals(CopilotAccount.State.WAITING, account.status().state(), "not signed in until the runtime says so");

        cli.auth.set(new CopilotAccount.CliAuth(true, "user", "octo-fixture", null));
        CopilotAccount.Status status = settled();

        assertEquals(CopilotAccount.State.SIGNED_IN, status.state());
        assertEquals("octo-fixture", status.login());
        assertEquals("cli", status.method());
        assertTrue(cli.authCalls.get() >= 2, "the runtime was asked more than once: " + cli.authCalls.get());
        assertTrue(sleeps.contains(CopilotAccount.CLI_POLL_S), sleeps.toString());
        assertEquals(CopilotCredentials.Method.CLI, store.load().orElseThrow().method());
    }

    @Test
    void theCliDeviceFlowNeverTakesTheGitHubCliAccountWhileItPolls() throws Exception {
        FakeCli cli = new FakeCli();
        account = account(cli);
        cli.prompt.complete(new CopilotCliLogin.Prompt("https://github.com/login/device", "2B8A-BAC6"));
        account.signInWithCli();

        cli.auth.set(new CopilotAccount.CliAuth(true, "gh-cli", "octo-fixture", null));
        Thread.sleep(100);
        assertEquals(CopilotAccount.State.WAITING, account.status().state(), "gh-cli is not the CLI's sign-in");
        assertFalse(Files.exists(store.path()));

        cli.auth.set(new CopilotAccount.CliAuth(true, "user", "octo-fixture", null));
        assertEquals(CopilotAccount.State.SIGNED_IN, settled().state());
    }

    @Test
    void closingTheSheetWhileTheCliWaitsStopsTheLoginAndThePolling() throws Exception {
        FakeCli cli = new FakeCli();
        account = account(cli);
        cli.prompt.complete(new CopilotCliLogin.Prompt("https://github.com/login/device", "2B8A-BAC6"));
        account.signInWithCli();

        CopilotAccount.Status after = account.cancel();
        assertTrue(cli.cancelled, "the copilot login process is stopped");
        assertEquals(CopilotAccount.State.NOT_SIGNED_IN, after.state());
        int asked = cli.authCalls.get();

        cli.auth.set(new CopilotAccount.CliAuth(true, "user", "octo-fixture", null));
        Thread.sleep(100);
        assertEquals(asked, cli.authCalls.get(), "no poll after the cancel");
        assertFalse(Files.exists(store.path()), "nothing is stored after a cancel");
    }

    @Test
    void aCodeThatExpiresWhileTheCliWaitsEndsTheFlowInWords() throws Exception {
        FakeCli cli = new FakeCli();
        account = account(cli);
        cli.prompt.complete(new CopilotCliLogin.Prompt("https://github.com/login/device", "2B8A-BAC6"));
        account.signInWithCli();

        clock.epochSecond.addAndGet(CopilotAccount.DEFAULT_CODE_LIFETIME_S + 1);
        CopilotAccount.Status status = settled();

        assertEquals(CopilotAccount.State.REFUSED, status.state());
        assertTrue(status.message().contains("expired"), status.message());
        assertTrue(cli.cancelled);
    }

    @Test
    void aRunTheRuntimeRefusesUnderTheCliChoiceIsShownAsRefusedAndTheChoiceStays() throws Exception {
        FakeCli cli = new FakeCli();
        cli.auth.set(new CopilotAccount.CliAuth(true, "user", "octo-fixture", null));
        account = account(cli);
        assertEquals(CopilotAccount.State.SIGNED_IN, account.signInWithCli().state());

        CopilotProvider.Options options = account.providerOptions("claude-sonnet-5", "/opt/homebrew/bin/copilot");
        assertTrue(options.useStoredLogin());
        assertNull(options.tokenSource(), "the CLI choice hands the runtime no token");
        options.refusals().accept("You have no Copilot seat.");

        CopilotAccount.Status refused = account.status();
        assertEquals(CopilotAccount.State.REFUSED, refused.state());
        assertEquals("cli", refused.method(), "the choice is still stored, so the sheet can offer sign out");
        assertEquals("You have no Copilot seat.", refused.message());

        assertEquals(CopilotAccount.State.NOT_SIGNED_IN, account.signOut().state());
    }
}
