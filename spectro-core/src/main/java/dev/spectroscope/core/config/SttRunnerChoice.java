package dev.spectroscope.core.config;

import dev.spectroscope.core.tools.ToolPath;

/**
 * What {@code sttRunner} runs on this machine (card 528): the one rule the
 * server, the live socket, the status page and the doctor read.
 *
 * <p>{@code cli} runs whisper-cli. {@code server} runs whisper-server and,
 * when it is not installed, whisper-cli with {@link #fallback()} set.
 * {@code auto} runs {@link SttStreaming#STT_RUNNER_AUTO_PICK} when
 * whisper-server is installed and whisper-cli otherwise.</p>
 *
 * @param configured the setting: {@code auto}, {@code cli} or {@code server}
 * @param running what runs: {@code server} or {@code cli}
 * @param fallback true when {@code server} was asked for and whisper-server is missing
 * @param binary the path of the program that runs, or null when it is missing
 */
public record SttRunnerChoice(String configured, String running, boolean fallback, String binary) {

    /**
     * Resolve the setting against what is installed.
     *
     * @param configured the {@code sttRunner} setting; null or blank reads as auto
     * @param server where whisper-server was looked for
     * @param cli where whisper-cli was looked for
     * @return the choice
     */
    public static SttRunnerChoice resolve(String configured, ToolPath.Lookup server, ToolPath.Lookup cli) {
        String asked = configured == null || configured.isBlank() ? SpectroConfig.STT_RUNNER_AUTO : configured;
        boolean wantsServer = SpectroConfig.STT_RUNNER_SERVER.equals(asked)
                || (SpectroConfig.STT_RUNNER_AUTO.equals(asked)
                        && SpectroConfig.STT_RUNNER_SERVER.equals(SttStreaming.STT_RUNNER_AUTO_PICK));
        if (wantsServer && server.isFound()) {
            return new SttRunnerChoice(asked, SpectroConfig.STT_RUNNER_SERVER, false, server.found());
        }
        boolean fallback = SpectroConfig.STT_RUNNER_SERVER.equals(asked);
        return new SttRunnerChoice(asked, SpectroConfig.STT_RUNNER_CLI, fallback, cli.found());
    }

    /**
     * Whether the program that runs is installed.
     *
     * @return true when {@link #binary()} names a path
     */
    public boolean ready() {
        return binary != null;
    }

    /**
     * The program's name, for the handshake and the record.
     *
     * @return {@code whisper-server} or {@code whisper-cli}
     */
    public String engine() {
        return SpectroConfig.STT_RUNNER_SERVER.equals(running) ? "whisper-server" : "whisper-cli";
    }
}
