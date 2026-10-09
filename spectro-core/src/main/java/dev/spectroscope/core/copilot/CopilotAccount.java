package dev.spectroscope.core.copilot;

import dev.spectroscope.core.config.governing.Governs;
import dev.spectroscope.core.config.SpectroConfig;
import dev.spectroscope.core.provider.CopilotProvider;

import java.io.IOException;
import java.nio.file.Path;
import java.time.Clock;
import java.util.Map;
import java.util.Optional;
import java.util.concurrent.TimeUnit;

/**
 * The Copilot sign-in of card 495: what the sign-in sheet shows and what the
 * provider is built with.
 *
 * <p>Two ways in, both a device flow the user confirms in the browser:
 * <ul>
 *   <li><b>github</b>: spectroscope's own device flow against GitHub with the
 *       client id of a registered OAuth app ({@value #CLIENT_ID_VARIABLE}). The
 *       token lands in {@link CopilotCredentials} (mode 0600) and reaches the
 *       runtime only through the SDK's token callback ({@link #tokenSource()}),
 *       refreshed when an hour or less remains, the margin at which the SDK
 *       itself asks again (docs.github.com, Copilot SDK authentication, read
 *       2026-10-10).</li>
 *   <li><b>cli</b>: the Copilot CLI's own stored sign-in, taken only when the
 *       user chose it. When the CLI has none, its own device flow runs
 *       ({@code copilot login --device-code}). The credential stays in the
 *       CLI's store; this file records only the choice. A runtime that would
 *       fall back to the GitHub CLI's account ({@code gh-cli}) or to anything
 *       other than the CLI's stored sign-in ({@code user}) counts as not signed
 *       in.</li>
 * </ul>
 *
 * <p>Without a stored choice the provider gets the token callback and the
 * stored-login fallback switched off, so a run never picks up an account the
 * user did not sign in with here. Refusals carry the words they came in: GitHub's
 * {@code error_description}, the CLI's "Login failed" text, the runtime's status
 * message. A token, a device code and a user code never reach a log or an
 * exception message from this class.
 */
public final class CopilotAccount {

    /** The variable that names the OAuth app's client id; read from the environment, then {@code ~/.spectro/.env}. */
    public static final String CLIENT_ID_VARIABLE = "SPECTRO_COPILOT_CLIENT_ID";

    /** The SDK asks for a new token when this many seconds or fewer remain; the refresh happens at the same mark. */
    @Governs(kind = Governs.Kind.FOREIGN_CONTRACT, unit = Governs.Unit.SECONDS)
    static final long REFRESH_MARGIN_S = 60 * 60;

    /** The lifetime reported for a token that does not expire; the SDK docs name eight hours as the common value. */
    @Governs(kind = Governs.Kind.FOREIGN_CONTRACT, unit = Governs.Unit.SECONDS)
    static final long NO_EXPIRY_LIFETIME_S = 8 * 60 * 60;

    /** How long a runtime's answer about the CLI sign-in is reused before it is asked again. */
    @Governs(kind = Governs.Kind.UNEXAMINED, unit = Governs.Unit.MILLISECONDS)
    static final long CLI_CACHE_MS = 30_000;

    /** How long to wait for {@code copilot login} to print its code. */
    @Governs(kind = Governs.Kind.UNEXAMINED, unit = Governs.Unit.SECONDS)
    static final long CLI_PROMPT_TIMEOUT_S = 30;

    /** GitHub's default code lifetime, used for the CLI's flow, which prints none. */
    @Governs(kind = Governs.Kind.FOREIGN_CONTRACT, unit = Governs.Unit.SECONDS)
    static final long DEFAULT_CODE_LIFETIME_S = 900;

    /** Where a sign-in stands. */
    public enum State {
        /** Nothing usable is stored. */
        NOT_SIGNED_IN,
        /** A device flow waits for the user to confirm the code in the browser. */
        WAITING,
        /** A sign-in is stored and usable. */
        SIGNED_IN,
        /** The last sign-in was refused; the message says why, in the words it came in. */
        REFUSED
    }

    /**
     * What the sheet shows.
     *
     * @param state           where the sign-in stands
     * @param method          {@code github} or {@code cli}, or null
     * @param login           the GitHub login when signed in
     * @param userCode        the code to type, only while waiting
     * @param verificationUri the address to open, only while waiting
     * @param expiresAt       epoch second the code expires, only while waiting
     * @param message         the last refusal or note, in the words it came in
     */
    public record Status(State state, String method, String login, String userCode, String verificationUri,
                         long expiresAt, String message) {
        @Override
        public String toString() {
            return "Status[state=" + state + ", method=" + method + ", signedIn=" + (login != null)
                    + ", waiting=" + (userCode != null) + "]";
        }
    }

    /**
     * What the runtime says about the Copilot CLI's stored sign-in.
     *
     * @param authenticated whether the runtime is signed in
     * @param authType      the runtime's auth type, such as {@code user} or {@code gh-cli}
     * @param login         the login, or null
     * @param message       the runtime's status message, or null
     */
    public record CliAuth(boolean authenticated, String authType, String login, String message) {
    }

    /** The Copilot CLI side: its stored sign-in and its own device flow. */
    public interface Cli {
        /**
         * Asks the runtime about the CLI's stored sign-in.
         *
         * @return what the runtime reports for the CLI's stored sign-in
         * @throws Exception when the runtime cannot answer
         */
        CliAuth auth() throws Exception;

        /**
         * Starts the CLI's own device flow.
         *
         * @return a running {@code copilot login --device-code}
         * @throws IOException when it cannot be started
         */
        CopilotCliLogin.Run login() throws IOException;

        /** {@return whether a runtime is there to ask} */
        default boolean available() {
            return true;
        }
    }

    /** Waits between two polls; a test passes one that does not sleep. */
    public interface Sleeper {
        /**
         * Waits before the next poll.
         *
         * @param seconds how long to wait
         * @throws InterruptedException when the wait is cut short
         */
        void sleep(long seconds) throws InterruptedException;
    }

    /** Thrown by the token source when there is no usable sign-in; its message is for the user. */
    public static final class NotSignedIn extends CopilotProvider.NotSignedIn {
        private static final long serialVersionUID = 1L;

        /**
         * A refusal for lack of a sign-in.
         *
         * @param message why
         */
        public NotSignedIn(String message) {
            super(message);
        }
    }

    /** A sign-in in progress. */
    private static final class Pending {
        final String method;
        final String userCode;
        final String verificationUri;
        final long expiresAt;
        final CopilotCliLogin.Run run;
        volatile boolean cancelled;
        volatile Thread worker;

        Pending(String method, String userCode, String verificationUri, long expiresAt, CopilotCliLogin.Run run) {
            this.method = method;
            this.userCode = userCode;
            this.verificationUri = verificationUri;
            this.expiresAt = expiresAt;
            this.run = run;
        }
    }

    private static final String NOT_SIGNED_IN = "Not signed in to GitHub Copilot. Sign in from the Copilot provider.";
    private static final String NO_APP = "spectroscope's own GitHub sign-in needs a registered GitHub OAuth app,"
            + " and none is configured (" + CLIENT_ID_VARIABLE + "). Use the Copilot CLI sign-in instead.";
    private static final String NO_CLI = "No Copilot CLI was found on this Mac. Install it with "
            + CopilotRuntime.INSTALL_LINE + ".";
    private static final String CLI_LEFT = "spectroscope no longer uses the Copilot CLI sign-in."
            + " The Copilot CLI itself stays signed in.";

    private final CopilotCredentials store;
    private final DeviceFlow github;
    private final Cli cli;
    private final Clock clock;
    private final Sleeper sleeper;
    private final Object tokenLock = new Object();

    private volatile Pending pending;
    private volatile String note;
    private volatile boolean refused;
    private volatile CliAuth cliAuth;
    private volatile long cliAuthAt;
    private volatile String runRefusal;

    /**
     * An account over the given parts.
     *
     * @param store   the stored sign-in
     * @param github  spectroscope's device flow, or null when no OAuth app is configured
     * @param cli     the Copilot CLI side, or null when there is none
     * @param clock   the clock for expiry
     * @param sleeper waits between polls
     */
    public CopilotAccount(CopilotCredentials store, DeviceFlow github, Cli cli, Clock clock, Sleeper sleeper) {
        this.store = store;
        this.github = github;
        this.cli = cli;
        this.clock = clock;
        this.sleeper = sleeper;
    }

    /**
     * The account of this machine: the file under {@code ~/.spectro}, the OAuth
     * app named by {@value #CLIENT_ID_VARIABLE} when one is set, and the
     * Copilot runtime the lookup of card 497 finds. It is one object per
     * process, so the sign-in sheet and the provider share its state.
     *
     * @return the account
     */
    public static CopilotAccount forThisMachine() {
        return Machine.ACCOUNT;
    }

    /** Holds the one account of this machine, built on first use. */
    private static final class Machine {
        static final CopilotAccount ACCOUNT = build();
    }

    private static CopilotAccount build() {
        String clientId = SpectroConfig.resolveApiKey(CLIENT_ID_VARIABLE);
        DeviceFlow flow = clientId == null || clientId.isBlank() ? null : GitHubDeviceFlow.forGitHub(clientId.trim());
        return new CopilotAccount(new CopilotCredentials(CopilotCredentials.defaultPath()), flow, machineCli(),
                Clock.systemUTC(), seconds -> TimeUnit.SECONDS.sleep(seconds));
    }

    /** {@return the CLI side that looks the runtime up on every use} */
    static Cli machineCli() {
        return new Cli() {
            private Optional<Path> runtime() {
                CopilotRuntime.Lookup lookup = CopilotRuntime.find(null);
                return lookup.isFound() ? Optional.of(lookup.path()) : Optional.empty();
            }

            @Override
            public CliAuth auth() {
                Path path = runtime().orElseThrow(() -> new IllegalStateException(NO_CLI));
                try (CopilotProvider provider = new CopilotProvider(
                        new CopilotProvider.Options("auto", path.toString(), null, true))) {
                    CopilotProvider.AuthStatus status = provider.authStatus();
                    return new CliAuth(status.authenticated(), status.authType(), status.login(), status.message());
                }
            }

            @Override
            public CopilotCliLogin.Run login() throws IOException {
                Path path = runtime().orElseThrow(() -> new IOException(NO_CLI));
                Map<String, String> env = CopilotRuntime.launch(path, System.getenv(),
                        Path.of(System.getProperty("user.home"))).environment();
                return new CopilotCliLogin(path, env).start();
            }

            @Override
            public boolean available() {
                return runtime().isPresent();
            }
        };
    }

    /** {@return whether spectroscope's own device flow is configured} */
    public boolean gitHubAvailable() {
        return github != null;
    }

    /** {@return whether a Copilot runtime is there for the CLI sign-in} */
    public boolean cliAvailable() {
        return cli != null && cli.available();
    }

    // ---- status ---------------------------------------------------------------------------

    /** {@return where the sign-in stands} */
    public Status status() {
        Pending p = pending;
        if (p != null) {
            return new Status(State.WAITING, p.method, null, p.userCode, p.verificationUri, p.expiresAt, null);
        }
        Optional<CopilotCredentials.Stored> stored = loaded();
        if (stored.isEmpty()) {
            return new Status(refused ? State.REFUSED : State.NOT_SIGNED_IN, null, null, null, null, 0, note);
        }
        CopilotCredentials.Stored s = stored.get();
        if (s.method() == CopilotCredentials.Method.CLI) {
            return cliStatus(false);
        }
        long now = clock.instant().getEpochSecond();
        boolean expired = s.accessExpiresAt() != 0 && s.accessExpiresAt() <= now;
        if (s.accessToken() == null || (expired && !refreshable(s, now))) {
            return new Status(State.NOT_SIGNED_IN, "github", null, null, null, 0,
                    s.accessToken() == null ? note : "The GitHub sign-in expired. Sign in again.");
        }
        String refusal = runRefusal;
        if (refusal != null) {
            return new Status(State.REFUSED, "github", null, null, null, 0, refusal);
        }
        return new Status(State.SIGNED_IN, "github", s.login(), null, null, 0, note);
    }

    /** {@return the status with the runtime asked again instead of the 30 s cache; tests use it} */
    Status recheck() {
        cliAuth = null;
        return status();
    }

    private Status cliStatus(boolean fresh) {
        if (cli == null) {
            return new Status(State.NOT_SIGNED_IN, "cli", null, null, null, 0, NO_CLI);
        }
        CliAuth auth;
        try {
            auth = cliAuth(fresh);
        } catch (Exception failure) {
            return new Status(State.NOT_SIGNED_IN, "cli", null, null, null, 0, runtimeSilent(failure));
        }
        if (cliUsable(auth)) {
            return new Status(State.SIGNED_IN, "cli", auth.login(), null, null, 0, note);
        }
        return new Status(State.NOT_SIGNED_IN, "cli", null, null, null, 0, cliRefusal(auth));
    }

    private CliAuth cliAuth(boolean fresh) throws Exception {
        CliAuth cached = cliAuth;
        if (!fresh && cached != null && System.currentTimeMillis() - cliAuthAt < CLI_CACHE_MS) {
            return cached;
        }
        CliAuth answer = cli.auth();
        cliAuth = answer;
        cliAuthAt = System.currentTimeMillis();
        return answer;
    }

    /** Only the CLI's own stored sign-in counts; {@code gh-cli}, {@code env} and the rest do not. */
    private static boolean cliUsable(CliAuth auth) {
        return auth != null && auth.authenticated() && "user".equals(auth.authType());
    }

    private static String cliRefusal(CliAuth auth) {
        if (auth != null && auth.authenticated() && "gh-cli".equals(auth.authType())) {
            return "The Copilot CLI has no sign-in of its own; the runtime would use the GitHub CLI's account,"
                    + " which spectroscope does not use.";
        }
        if (auth != null && auth.authenticated()) {
            return "The Copilot runtime is signed in through " + auth.authType()
                    + ", not through the Copilot CLI's own sign-in, which spectroscope does not use.";
        }
        String message = auth == null ? null : auth.message();
        return message == null || message.isBlank() ? "The Copilot CLI is not signed in." : message;
    }

    private static String runtimeSilent(Exception failure) {
        String message = failure.getMessage();
        return "The Copilot runtime did not answer" + (message == null || message.isBlank() ? "." : ": " + message);
    }

    private Optional<CopilotCredentials.Stored> loaded() {
        try {
            return store.load();
        } catch (IOException unreadable) {
            return Optional.empty();
        }
    }

    private boolean refreshable(CopilotCredentials.Stored s, long now) {
        return github != null && s.refreshToken() != null
                && (s.refreshExpiresAt() == 0 || s.refreshExpiresAt() > now);
    }

    // ---- spectroscope's own device flow ------------------------------------------------------

    /**
     * Starts spectroscope's own device flow against GitHub.
     *
     * @return the waiting status with the code to type, or a refusal
     */
    public Status signInWithGitHub() {
        cancel();
        runRefusal = null;
        if (github == null) {
            return refuse(NO_APP);
        }
        DeviceFlow.DeviceCode code;
        try {
            code = github.start();
        } catch (DeviceFlow.Refused refusal) {
            return refuse(refusal.getMessage());
        } catch (IOException unreachable) {
            return refuse("GitHub could not be reached: " + unreachable.getMessage());
        }
        long now = clock.instant().getEpochSecond();
        Pending p = new Pending("github", code.userCode(), code.verificationUri(), now + code.expiresInSeconds(), null);
        note = null;
        refused = false;
        pending = p;
        p.worker = Thread.ofVirtual().name("copilot-sign-in").start(() -> pollGitHub(p, code));
        return status();
    }

    private void pollGitHub(Pending p, DeviceFlow.DeviceCode code) {
        long interval = Math.max(1, code.intervalSeconds());
        try {
            while (!p.cancelled) {
                sleeper.sleep(interval);
                if (p.cancelled) {
                    return;
                }
                DeviceFlow.Poll poll = github.poll(code);
                switch (poll) {
                    case DeviceFlow.Pending ignored -> {
                        if (clock.instant().getEpochSecond() > p.expiresAt + interval) {
                            finish(p, "The code expired before it was confirmed.", true);
                            return;
                        }
                    }
                    case DeviceFlow.SlowDown slow -> interval = Math.max(interval, slow.intervalSeconds());
                    case DeviceFlow.Denied denied -> {
                        finish(p, denied.description() == null || denied.description().isBlank()
                                ? denied.error() : denied.description(), true);
                        return;
                    }
                    case DeviceFlow.Granted granted -> {
                        granted(p, granted.grant());
                        return;
                    }
                }
            }
        } catch (InterruptedException stopped) {
            Thread.currentThread().interrupt();
        } catch (DeviceFlow.Refused refusal) {
            finish(p, refusal.getMessage(), true);
        } catch (IOException unreachable) {
            finish(p, "GitHub could not be reached: " + unreachable.getMessage(), true);
        }
    }

    private void granted(Pending p, DeviceFlow.Grant grant) {
        try {
            String login = github.login(grant.accessToken());
            if (p.cancelled) {
                return;
            }
            long now = clock.instant().getEpochSecond();
            store.save(new CopilotCredentials.Stored(CopilotCredentials.Method.GITHUB, login, grant.accessToken(),
                    grant.expiresInSeconds() > 0 ? now + grant.expiresInSeconds() : 0, grant.refreshToken(),
                    grant.refreshExpiresInSeconds() > 0 ? now + grant.refreshExpiresInSeconds() : 0));
            cliAuth = null;
            finish(p, null, false);
        } catch (DeviceFlow.Refused refusal) {
            finish(p, refusal.getMessage(), true);
        } catch (IOException failure) {
            finish(p, "The sign-in could not be completed: " + failure.getMessage(), true);
        }
    }

    /** Ends a sign-in; the words are set before the waiting state goes, so no reader sees a gap. */
    private void finish(Pending p, String message, boolean refusal) {
        synchronized (this) {
            if (pending != p) {
                return;
            }
            note = message;
            refused = refusal;
            pending = null;
        }
    }

    private Status refuse(String message) {
        note = message;
        refused = true;
        Status now = status();
        return now.state() == State.SIGNED_IN || now.state() == State.WAITING
                ? now
                : new Status(State.REFUSED, now.method(), null, null, null, 0, message);
    }

    // ---- the Copilot CLI's sign-in --------------------------------------------------------------

    /**
     * Takes the Copilot CLI's stored sign-in, or starts the CLI's own device flow when it has none.
     *
     * @return signed in through the CLI's stored sign-in, or waiting for the CLI's device flow
     */
    public Status signInWithCli() {
        cancel();
        runRefusal = null;
        if (cli == null || !cli.available()) {
            return refuse(NO_CLI);
        }
        CliAuth auth;
        try {
            auth = cliAuth(true);
        } catch (Exception failure) {
            return refuse(runtimeSilent(failure));
        }
        if (cliUsable(auth)) {
            return chooseCli();
        }
        CopilotCliLogin.Run run;
        CopilotCliLogin.Prompt prompt;
        try {
            run = cli.login();
        } catch (IOException notStarted) {
            return refuse("copilot login could not be started: " + notStarted.getMessage());
        }
        try {
            prompt = run.prompt().get(CLI_PROMPT_TIMEOUT_S, TimeUnit.SECONDS);
        } catch (Exception noPrompt) {
            run.cancel();
            CopilotCliLogin.Outcome outcome = run.outcome().getNow(null);
            return refuse(outcome != null && outcome.message() != null
                    ? outcome.message() : "copilot login printed no code.");
        }
        long now = clock.instant().getEpochSecond();
        Pending p = new Pending("cli", prompt.userCode(), prompt.verificationUri(), now + DEFAULT_CODE_LIFETIME_S, run);
        note = null;
        refused = false;
        pending = p;
        p.worker = Thread.ofVirtual().name("copilot-cli-sign-in").start(() -> awaitCli(p, run));
        return status();
    }

    private void awaitCli(Pending p, CopilotCliLogin.Run run) {
        CopilotCliLogin.Outcome outcome;
        try {
            outcome = run.outcome().get();
        } catch (InterruptedException stopped) {
            Thread.currentThread().interrupt();
            return;
        } catch (Exception broken) {
            finish(p, "copilot login ended without an answer.", true);
            return;
        }
        if (p.cancelled) {
            return;
        }
        if (!outcome.signedIn()) {
            finish(p, outcome.message(), true);
            return;
        }
        CliAuth auth;
        try {
            auth = cliAuth(true);
        } catch (Exception failure) {
            finish(p, runtimeSilent(failure), true);
            return;
        }
        if (!cliUsable(auth)) {
            finish(p, cliRefusal(auth), true);
            return;
        }
        try {
            store.save(new CopilotCredentials.Stored(CopilotCredentials.Method.CLI, auth.login(), null, 0, null, 0));
            finish(p, null, false);
        } catch (IOException failure) {
            finish(p, "The choice could not be saved: " + failure.getMessage(), true);
        }
    }

    private Status chooseCli() {
        try {
            CliAuth auth = cliAuth;
            store.save(new CopilotCredentials.Stored(CopilotCredentials.Method.CLI,
                    auth == null ? null : auth.login(), null, 0, null, 0));
        } catch (IOException failure) {
            return refuse("The choice could not be saved: " + failure.getMessage());
        }
        note = null;
        refused = false;
        return status();
    }

    // ---- cancel and sign out ----------------------------------------------------------------------

    /**
     * Stops a running sign-in.
     *
     * @return the status afterwards
     */
    public Status cancel() {
        Pending p;
        synchronized (this) {
            p = pending;
            pending = null;
            if (p != null) {
                note = null;
                refused = false;
            }
        }
        if (p != null) {
            p.cancelled = true;
            if (p.run != null) {
                p.run.cancel();
            }
            Thread worker = p.worker;
            if (worker != null) {
                worker.interrupt();
            }
        }
        return status();
    }

    /**
     * Deletes the stored tokens, or the choice of the CLI's sign-in. The Copilot CLI's own sign-in is left alone.
     *
     * @return the status afterwards, not signed in
     */
    public Status signOut() {
        cancel();
        boolean wasCli = loaded().map(s -> s.method() == CopilotCredentials.Method.CLI).orElse(false);
        try {
            store.delete();
        } catch (IOException failure) {
            return refuse("The stored sign-in could not be deleted: " + failure.getMessage());
        }
        cliAuth = null;
        runRefusal = null;
        note = wasCli ? CLI_LEFT : null;
        refused = false;
        return status();
    }

    // ---- what the provider gets ---------------------------------------------------------------------

    /**
     * The token source the provider passes to the SDK's token callback. A run the runtime refuses for
     * authentication or authorization reaches {@link CopilotProvider.TokenSource#refused(String)}, and the
     * status then shows the runtime's words. The reason the runtime gives is
     * not consulted: it asks for {@code refresh} only when an hour or less
     * remains and does not replay after a rejection (docs.github.com, Copilot SDK
     * authentication, read 2026-10-10), which is the mark used here as well.
     *
     * @return the token source
     */
    public CopilotProvider.TokenSource tokenSource() {
        return new CopilotProvider.TokenSource() {
            @Override
            public CopilotProvider.Token token(String host, String reason) throws IOException {
                return CopilotAccount.this.token();
            }

            @Override
            public void refused(String words) {
                runRefusal = words == null || words.isBlank() ? "Copilot refused the run." : words;
            }
        };
    }

    private CopilotProvider.Token token() throws IOException {
        synchronized (tokenLock) {
            CopilotCredentials.Stored s = store.load().orElseThrow(() -> new NotSignedIn(NOT_SIGNED_IN));
            if (s.method() != CopilotCredentials.Method.GITHUB || s.accessToken() == null) {
                throw new NotSignedIn(NOT_SIGNED_IN);
            }
            if (s.accessExpiresAt() == 0) {
                return new CopilotProvider.Token(s.accessToken(), NO_EXPIRY_LIFETIME_S);
            }
            long now = clock.instant().getEpochSecond();
            long remaining = s.accessExpiresAt() - now;
            if (remaining > REFRESH_MARGIN_S) {
                return new CopilotProvider.Token(s.accessToken(), remaining);
            }
            if (!refreshable(s, now)) {
                if (remaining > 0) {
                    return new CopilotProvider.Token(s.accessToken(), remaining);
                }
                throw new NotSignedIn("The GitHub sign-in expired. Sign in again.");
            }
            DeviceFlow.Grant grant;
            try {
                grant = github.refresh(s.refreshToken());
            } catch (DeviceFlow.Refused refusal) {
                if (remaining > 0) {
                    return new CopilotProvider.Token(s.accessToken(), remaining);
                }
                store.delete();
                note = refusal.getMessage();
                refused = false;
                throw new NotSignedIn(refusal.getMessage());
            } catch (IOException unreachable) {
                if (remaining > 0) {
                    return new CopilotProvider.Token(s.accessToken(), remaining);
                }
                throw new NotSignedIn("The GitHub sign-in expired and GitHub could not be reached to renew it.");
            }
            store.save(new CopilotCredentials.Stored(CopilotCredentials.Method.GITHUB, s.login(), grant.accessToken(),
                    grant.expiresInSeconds() > 0 ? now + grant.expiresInSeconds() : 0,
                    grant.refreshToken() != null ? grant.refreshToken() : s.refreshToken(),
                    grant.refreshExpiresInSeconds() > 0 ? now + grant.refreshExpiresInSeconds() : s.refreshExpiresAt()));
            return new CopilotProvider.Token(grant.accessToken(),
                    grant.expiresInSeconds() > 0 ? grant.expiresInSeconds() : NO_EXPIRY_LIFETIME_S);
        }
    }

    /**
     * The options a Copilot provider is built with.
     *
     * @param model   the model id
     * @param cliPath the runtime
     * @return provider options with the credential choice this account holds: the
     *         CLI's stored sign-in only when the user chose it, otherwise the
     *         token callback with the stored-login fallback off
     */
    public CopilotProvider.Options providerOptions(String model, String cliPath) {
        boolean choseCli = loaded().map(s -> s.method() == CopilotCredentials.Method.CLI).orElse(false);
        return choseCli
                ? new CopilotProvider.Options(model, cliPath, null, true)
                : new CopilotProvider.Options(model, cliPath, tokenSource(), false);
    }

    /**
     * A provider built with this account's credential choice. Other code builds
     * a Copilot provider only through here ({@code CopilotProviderIsBuiltByTheAccountDriftTest}).
     *
     * @param model   the model id
     * @param cliPath the runtime
     * @return a provider over {@link #providerOptions(String, String)}
     */
    public CopilotProvider provider(String model, String cliPath) {
        return new CopilotProvider(providerOptions(model, cliPath));
    }
}
