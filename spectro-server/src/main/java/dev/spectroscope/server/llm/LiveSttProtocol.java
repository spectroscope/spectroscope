package dev.spectroscope.server.llm;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.fasterxml.jackson.databind.ObjectMapper;

/**
 * The realtime transcription handshake as pure text, so the socket handler owns
 * connections and this owns the protocol (card 187 step 6).
 *
 * <p>Every constant here was learned on 2026-08-09 by being refused, which is
 * why they are pinned by tests rather than left as a comment. The five refusals,
 * in the order they arrived:</p>
 *
 * <ol>
 *   <li>{@code OpenAI-Beta: realtime=v1} answers {@code beta_api_shape_disabled}.
 *       The beta shape is gone, so every recipe that sets that header is stale.</li>
 *   <li>No query at all answers {@code missing_model}.</li>
 *   <li>{@code ?model=gpt-live-transcribe} answers {@code invalid_model}: <i>"is a
 *       transcription model and cannot be used as the realtime session model"</i>.
 *       The transcription model belongs inside the session update, and
 *       {@code intent=transcription} selects a session with no conversation model
 *       at all — which is the one we want, since a conversation model would also
 *       answer.</li>
 *   <li>{@code rate: 16000} answers {@code integer_below_min_value}, expected
 *       &gt;= 24000. whisper.cpp reads 16 kHz and nothing else, so the two routes
 *       cannot share a rate; the browser decides before it builds its capture
 *       chain.</li>
 *   <li>{@code turn_detection} answers <i>"not supported for this transcription
 *       model"</i> — an error frame, not a warning, and it ends the session before
 *       a sample is appended. Which is fine: the button is push-to-talk, so the
 *       turn ends when the user lets go and nothing can close it behind
 *       their back.</li>
 * </ol>
 */
public final class LiveSttProtocol {

    /** Where a live transcription session lives. No model in the query on
     *  purpose — see the class note, refusal 3. */
    public static final String URL = "wss://api.openai.com/v1/realtime?intent=transcription";

    /** The one rate the session accepts, and the reason `captureRate` on the web
     *  side is a function of the route rather than a constant. */
    public static final int RATE = 24_000;

    /** The default live model, measured present in the account's model list. */
    public static final String DEFAULT_MODEL = "gpt-live-transcribe";

    /** Where the local route's runs happen, named on the llm-wire record the
     *  way the batch route names it. */
    public static final String LOCAL_URL = "process://whisper-cli";

    /**
     * Where the local route's runs happen, by program (card 528). The port of a
     * resident whisper-server is not named: the record is a file on disk.
     *
     * @param engine {@code whisper-cli} or {@code whisper-server}
     * @return {@code process://} and the program
     */
    public static String localUrl(String engine) {
        return "process://" + (engine == null || engine.isBlank() ? "whisper-cli" : engine);
    }

    /** The rate whisper.cpp reads, and so the rate the browser captures at
     *  for the local route. */
    public static final int LOCAL_RATE = 16_000;

    /** A chunk run's answer: the open window's text so far. */
    public static final String LOCAL_PARTIAL = "spectro.local.partial";

    /** A window closed on a sentence end or at its cap; the recording goes on. */
    public static final String LOCAL_WINDOW = "spectro.local.window";

    /** The last run after the commit: the transcript of the last window. */
    public static final String LOCAL_FINAL = "spectro.local.final";

    /** The warm up loads the speech model, so the browser shows the loading
     *  card until ready (card 528). Not sent when the model is resident. */
    public static final String LOCAL_LOADING = "spectro.local.loading";

    private static final ObjectMapper JSON = new ObjectMapper();

    private LiveSttProtocol() {
        // constants and pure builders only
    }

    /** What an incoming upstream frame means to a composer. */
    public enum Kind {
        /** The session is configured; audio may start flowing. */
        READY,
        /** A guess, to be shown faded and replaced. */
        PARTIAL,
        /** A guess that REPLACES everything shown for the open window: the
         *  local route runs whisper over the whole window every step, so each
         *  answer is the window's text so far, not a delta (card 527). */
        REPLACE,
        /** The transcript of a window that closed while the speaker goes on:
         *  final for that window, and the recording continues (card 527). */
        WINDOW,
        /** The transcript, which replaces every partial before it. */
        FINAL,
        /** The local route loads its speech model before ready (card 528). */
        LOADING,
        /** The far side refused something, with a sentence. */
        ERROR,
        /** A real event with nothing in it for a composer. */
        IGNORE
    }

    /**
     * One upstream frame, read.
     *
     * @param kind what it means
     * @param text the delta, the transcript or the error sentence; null when
     *             there is nothing to say
     */
    public record Incoming(Kind kind, String text) {}

    /**
     * The session update that configures a transcription session.
     *
     * @param model the transcription model, e.g. {@link #DEFAULT_MODEL}
     * @return the frame, ready to send
     */
    public static String sessionUpdate(String model) {
        ObjectNode frame = JSON.createObjectNode();
        frame.put("type", "session.update");
        ObjectNode session = frame.putObject("session");
        session.put("type", "transcription");
        ObjectNode input = session.putObject("audio").putObject("input");
        ObjectNode format = input.putObject("format");
        format.put("type", "audio/pcm");
        format.put("rate", RATE);
        input.putObject("transcription")
                .put("model", model == null || model.isBlank() ? DEFAULT_MODEL : model);
        // Deliberately NO turn_detection — the model refuses the field outright.
        return frame.toString();
    }

    /**
     * One append of captured audio.
     *
     * @param base64Pcm the browser's own PCM16 base64, forwarded untouched — a
     *                  second encoding here would be a second chance to get
     *                  endianness wrong
     * @return the frame, ready to send
     * @throws IllegalArgumentException when there is no audio in it, because an
     *         empty append is pure overhead on a socket carrying a conversation
     */
    public static String append(String base64Pcm) {
        if (base64Pcm == null || base64Pcm.isEmpty()) {
            throw new IllegalArgumentException("an append with no audio in it");
        }
        ObjectNode frame = JSON.createObjectNode();
        frame.put("type", "input_audio_buffer.append");
        frame.put("audio", base64Pcm);
        return frame.toString();
    }

    /**
     * The handshake for the local route (card 527). Same shape as the hosted
     * one so the record reads alike, with the facts that are true here: 16 kHz,
     * the model file, the dictation language and the chunk step.
     *
     * @param modelFile the whisper model's file name
     * @param language the {@code sttLanguage} setting
     * @param chunkMs how often a run covers the open window
     * @return the frame, ready to send
     */
    public static String localSessionUpdate(String modelFile, String language, long chunkMs) {
        return localSessionUpdate(modelFile, language, chunkMs, "whisper-cli");
    }

    /**
     * The local handshake with the program that runs whisper (card 528).
     *
     * @param modelFile the whisper model's file name
     * @param language the {@code sttLanguage} setting
     * @param chunkMs how often a run covers the open window
     * @param engine {@code whisper-cli} or {@code whisper-server}
     * @return the frame, ready to send
     */
    public static String localSessionUpdate(String modelFile, String language, long chunkMs, String engine) {
        ObjectNode frame = JSON.createObjectNode();
        frame.put("type", "session.update");
        ObjectNode session = frame.putObject("session");
        session.put("type", "transcription");
        ObjectNode format = session.putObject("audio").putObject("input").putObject("format");
        format.put("type", "audio/pcm");
        format.put("rate", LOCAL_RATE);
        session.put("engine", engine == null || engine.isBlank() ? "whisper-cli" : engine);
        session.put("model", modelFile == null ? "" : modelFile);
        session.put("language", language == null || language.isBlank() ? "auto" : language);
        session.put("chunkMs", chunkMs);
        return frame.toString();
    }

    /**
     * One answer of the local route.
     *
     * @param type {@link #LOCAL_PARTIAL}, {@link #LOCAL_WINDOW} or {@link #LOCAL_FINAL}
     * @param text what whisper heard in the window
     * @param chunk the run's number in this session, from 1
     * @param durationMs the run's wall time, model load included
     * @param audioMs how much audio the run covered
     * @param skipped how many steps were skipped so far because a run was in flight
     * @return the frame, as the record keeps it
     */
    public static String localResult(String type, String text, int chunk, long durationMs,
            long audioMs, int skipped) {
        ObjectNode frame = JSON.createObjectNode();
        frame.put("type", type);
        frame.put("text", text == null ? "" : text);
        frame.put("chunk", chunk);
        frame.put("durationMs", durationMs);
        frame.put("audioMs", audioMs);
        frame.put("skipped", skipped);
        return frame.toString();
    }

    /**
     * The local route's loading frame (card 528).
     *
     * @param engine the program that loads the model
     * @return the frame, as the record keeps it
     */
    public static String localLoading(String engine) {
        ObjectNode frame = JSON.createObjectNode();
        frame.put("type", LOCAL_LOADING);
        frame.put("engine", engine == null ? "" : engine);
        return frame.toString();
    }

    /** The frame that says the speaker let go of the button. */
    public static String commit() {
        return "{\"type\":\"input_audio_buffer.commit\"}";
    }

    /**
     * What an upstream frame means.
     *
     * <p>Unknown and typeless frames read as {@link Kind#IGNORE} rather than
     * throwing: a socket that dies on an unexpected frame takes the recording
     * with it, and the far side is free to add events we have never seen.</p>
     *
     * @param frame the parsed upstream message
     * @return the reading
     */
    public static Incoming read(JsonNode frame) {
        String type = frame.path("type").asText("");
        if (type.equals("session.updated")) {
            return new Incoming(Kind.READY, null);
        }
        if (type.equals(LOCAL_PARTIAL)) {
            return new Incoming(Kind.REPLACE, frame.path("text").asText(""));
        }
        if (type.equals(LOCAL_WINDOW)) {
            return new Incoming(Kind.WINDOW, frame.path("text").asText(""));
        }
        if (type.equals(LOCAL_FINAL)) {
            return new Incoming(Kind.FINAL, frame.path("text").asText(""));
        }
        if (type.equals(LOCAL_LOADING)) {
            return new Incoming(Kind.LOADING, frame.path("engine").asText(""));
        }
        if (type.endsWith("input_audio_transcription.delta")) {
            return new Incoming(Kind.PARTIAL, frame.path("delta").asText(""));
        }
        if (type.endsWith("input_audio_transcription.completed")) {
            return new Incoming(Kind.FINAL, frame.path("transcript").asText(""));
        }
        if (type.equals("error")) {
            // The message, never the whole node: reading an error as if it were
            // text would type the API's complaint into the composer.
            JsonNode error = frame.path("error");
            String said = error.path("message").asText("");
            return new Incoming(Kind.ERROR, said.isEmpty() ? "the provider refused the session" : said);
        }
        return new Incoming(Kind.IGNORE, null);
    }
}
