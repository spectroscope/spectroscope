package dev.spectroscope.core.copilot;

import java.io.BufferedReader;
import java.io.File;
import java.io.IOException;
import java.io.InputStreamReader;
import java.nio.charset.StandardCharsets;
import java.nio.file.Path;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CompletableFuture;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Runs {@code copilot login --device-code} and reads its code, address and
 * outcome from what it prints.
 *
 * <p>The lines are the ones Copilot CLI 1.0.94 printed in card 478's sign-in
 * ({@code evidence/478/login-device.log}): "To authenticate, visit &lt;url&gt;
 * and enter code &lt;code&gt;", then "Signed in successfully as &lt;login&gt;."
 * or "Login failed: &lt;reason&gt;". The CLI keeps the credential in its own
 * store (the system keychain); nothing is copied out of it.
 *
 * <p>The process starts without the token variables, so a token in the app's
 * environment cannot decide which account the CLI signs in with.
 */
public final class CopilotCliLogin {

    /** Every variable that would put a token in front of the CLI's own sign-in. */
    static final List<String> TOKEN_VARIABLES = List.of("COPILOT_GITHUB_TOKEN", "GH_TOKEN", "GITHUB_TOKEN",
            "GITHUB_COPILOT_API_TOKEN", "COPILOT_API_URL");

    private static final Pattern PROMPT =
            Pattern.compile("visit\\s+(https?://\\S+)\\s+and\\s+enter\\s+code\\s+([A-Z0-9]{4}-[A-Z0-9]{4})");
    private static final Pattern SUCCESS = Pattern.compile("Signed in successfully as\\s+(\\S+?)\\.?\\s*$");
    private static final Pattern FAILURE = Pattern.compile("Login failed:\\s*(.*)$");

    private final Path cliPath;
    private final Map<String, String> parentEnvironment;

    /**
     * @param cliPath           the {@code copilot} executable
     * @param parentEnvironment the environment to start from; token variables are removed
     */
    public CopilotCliLogin(Path cliPath, Map<String, String> parentEnvironment) {
        this.cliPath = cliPath;
        this.parentEnvironment = Map.copyOf(parentEnvironment);
    }

    /**
     * The code and address the CLI printed.
     *
     * @param verificationUri the address to open
     * @param userCode        the code to type there
     */
    public record Prompt(String verificationUri, String userCode) {
        @Override
        public String toString() {
            return "Prompt[verificationUri=" + verificationUri + "]";
        }
    }

    /**
     * How the login ended.
     *
     * @param signedIn whether the CLI reported success
     * @param login    the login it named, or null
     * @param message  the CLI's own failure text, or null
     */
    public record Outcome(boolean signedIn, String login, String message) {
    }

    /** One running {@code copilot login}. */
    public interface Run {
        /** @return completes when the code and address were printed, fails when the process ended first */
        CompletableFuture<Prompt> prompt();

        /** @return completes when the process ended */
        CompletableFuture<Outcome> outcome();

        /** Stops the process. */
        void cancel();
    }

    /**
     * @param parent the environment to start from
     * @return the same without any token variable
     */
    static Map<String, String> environment(Map<String, String> parent) {
        Map<String, String> copy = new LinkedHashMap<>(parent);
        TOKEN_VARIABLES.forEach(copy::remove);
        return copy;
    }

    /**
     * @return the running login
     * @throws IOException when the process cannot be started
     */
    public Run start() throws IOException {
        ProcessBuilder builder = new ProcessBuilder(cliPath.toString(), "login", "--device-code")
                .redirectErrorStream(true)
                .redirectInput(ProcessBuilder.Redirect.from(new File("/dev/null")));
        builder.environment().clear();
        builder.environment().putAll(environment(parentEnvironment));
        Process process = builder.start();
        CompletableFuture<Prompt> prompt = new CompletableFuture<>();
        CompletableFuture<Outcome> outcome = new CompletableFuture<>();
        Thread reader = new Thread(() -> read(process, prompt, outcome), "copilot-cli-login");
        reader.setDaemon(true);
        reader.start();
        return new Run() {
            @Override
            public CompletableFuture<Prompt> prompt() {
                return prompt;
            }

            @Override
            public CompletableFuture<Outcome> outcome() {
                return outcome;
            }

            @Override
            public void cancel() {
                process.descendants().forEach(ProcessHandle::destroy);
                process.destroy();
            }
        };
    }

    private static void read(Process process, CompletableFuture<Prompt> prompt, CompletableFuture<Outcome> outcome) {
        String login = null;
        String failure = null;
        try (BufferedReader in = new BufferedReader(
                new InputStreamReader(process.getInputStream(), StandardCharsets.UTF_8))) {
            String line;
            while ((line = in.readLine()) != null) {
                Matcher asked = PROMPT.matcher(line);
                if (asked.find()) {
                    prompt.complete(new Prompt(asked.group(1), asked.group(2)));
                    continue;
                }
                Matcher done = SUCCESS.matcher(line.strip());
                if (done.find()) {
                    login = done.group(1);
                    continue;
                }
                Matcher failed = FAILURE.matcher(line.strip());
                if (failed.find()) {
                    failure = failed.group(1).strip();
                }
            }
        } catch (IOException closed) {
            // The process went away; its exit code below says how.
        }
        int exit;
        try {
            exit = process.waitFor();
        } catch (InterruptedException interrupted) {
            Thread.currentThread().interrupt();
            process.destroy();
            exit = -1;
        }
        prompt.completeExceptionally(new IOException("copilot login printed no code"));
        if (login != null && exit == 0) {
            outcome.complete(new Outcome(true, login, null));
        } else {
            outcome.complete(new Outcome(false, null,
                    failure != null ? failure : "copilot login ended with exit code " + exit));
        }
    }
}
