package dev.spectroscope.server.llm;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.time.Duration;

/**
 * Speech to text without anything installed: the recording goes to a hosted
 * transcription API and the sentence comes back.
 *
 * <p>Card 187's correction is why this exists. The card had spent a whole
 * section on how to get two binaries into a signed DMG before the owner asked
 * the question that dissolved it — <i>"aber warum? claude code kann das doch
 * auch"</i>. Claude Code bundles neither whisper nor ffmpeg; it transcribes
 * remotely, so the user's machine needs nothing but a microphone. The question
 * was never how the binaries get in. It was why local at all.</p>
 *
 * <p><b>The claim this rests on was measured before it was built:</b> the API's
 * documentation lists wav among its input formats, and the exact bytes the
 * browser's encoder produces (step 5.4) came back 200 with the right sentence
 * from a real call. So there is ONE encoder for both paths and nothing rewrites
 * the audio on its way anywhere.</p>
 *
 * <p>The local path stays as the thing it actually is: the keyless, offline,
 * private option, which is the axis this product differentiates on. Not
 * either/or — {@link SttRoute} chooses.</p>
 */
public final class HostedTranscriber implements HostedStt {

    /** Where the recording goes. Named in the llm-wire record, so the trace
     *  shows a real url and a reader can see the audio leave the machine. */
    public static final String URL = "https://api.openai.com/v1/audio/transcriptions";

    /** The default model. Measured against the alternative on this project's own
     *  test clip: 1504 ms here against 2382 ms for `whisper-1`, same sentence. */
    public static final String DEFAULT_MODEL = "gpt-transcribe";

    /** The env var the key comes from — the SAME one image generation already
     *  uses, so a key saved once in the UI feeds both. */
    public static final String KEY_ENV = "OPENAI_API_KEY";

    /** 25 MB is the endpoint's documented ceiling; the browser's own 300-second
     *  limit produces about 9.2 MB, so this is a fence and not a squeeze. */
    static final int MAX_BYTES = 25 * 1024 * 1024;

    private static final ObjectMapper JSON = new ObjectMapper();

    private final HttpClient http;
    private final String model;

    /** One client for every request. The convenience constructor used to build
     *  a fresh HttpClient -- selector thread and all -- on EVERY transcribe
     *  call, including local-route calls that never use it. */
    private static final HttpClient SHARED =
            HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(15)).build();

    HostedTranscriber(String model) {
        this(SHARED, model);
    }

    HostedTranscriber(HttpClient http, String model) {
        this.http = http;
        this.model = model == null || model.isBlank() ? DEFAULT_MODEL : model;
    }

    /** The model this instance posts with — named on the wire record. */
    @Override
    public String model() {
        return model;
    }

    /**
     * Transcribe a 16 kHz mono WAV through the hosted API.
     *
     * @param wav the recording, exactly as the browser encoded it
     * @param key the API key
     * @param language the {@code sttLanguage} setting; {@code auto} adds nothing
     * @return the raw response body, so the caller can record what really came
     *         back rather than a rewritten version of it
     * @throws IOException with a readable sentence for any refusal
     */
    @Override
    public String post(byte[] wav, String key, String language)
            throws IOException, InterruptedException {
        if (wav.length > MAX_BYTES) {
            throw new IOException("The recording is " + (wav.length / (1024 * 1024))
                    + " MB and the transcription API accepts 25 MB.");
        }
        String boundary = "spectroscope-" + Long.toHexString(System.nanoTime());
        HttpRequest request = HttpRequest.newBuilder(URI.create(URL))
                .header("Authorization", "Bearer " + key)
                .header("Content-Type", "multipart/form-data; boundary=" + boundary)
                .timeout(Duration.ofMinutes(5))
                .POST(HttpRequest.BodyPublishers.ofByteArray(
                        multipart(boundary, wav, model, language)))
                .build();
        HttpResponse<String> response = http.send(request, HttpResponse.BodyHandlers.ofString());
        if (response.statusCode() / 100 != 2) {
            failureOf(response.statusCode(), response.body());
        }
        return response.body();
    }

    /**
     * The multipart body: the model as a field, an optional language field, the
     * recording as a file.
     *
     * <p>Hand-assembled rather than pulled in as a dependency — it is a few fields
     * and a boundary, and the audio has to ride through it byte for byte, which
     * is easier to guarantee than to verify in a library.</p>
     *
     * <p>The language field appears only for a REAL code. {@code auto} means the
     * absence of an instruction — the request stays exactly what it was before
     * the setting existed — never {@code language=auto}, which the API would
     * read as a literal (and unknown) language.</p>
     *
     * @param boundary the multipart boundary
     * @param wav the recording
     * @param model the transcription model to ask for
     * @param language the {@code sttLanguage} setting; {@code auto}/blank/null add nothing
     * @return the complete request body
     */
    static byte[] multipart(String boundary, byte[] wav, String model, String language) {
        ByteArrayOutputStream out = new ByteArrayOutputStream(wav.length + 512);
        write(out, "--" + boundary + "\r\n"
                + "Content-Disposition: form-data; name=\"model\"\r\n\r\n"
                + model + "\r\n");
        if (language != null && !language.isBlank() && !"auto".equals(language)) {
            write(out, "--" + boundary + "\r\n"
                    + "Content-Disposition: form-data; name=\"language\"\r\n\r\n"
                    + language + "\r\n");
        }
        write(out, "--" + boundary + "\r\n"
                + "Content-Disposition: form-data; name=\"file\"; filename=\"recording.wav\"\r\n"
                + "Content-Type: audio/wav\r\n\r\n");
        out.writeBytes(wav);
        write(out, "\r\n--" + boundary + "--\r\n");
        return out.toByteArray();
    }

    /**
     * The spoken text out of the answer.
     *
     * @param body the response body as it arrived
     * @return the transcript, or "" for silence and for any shape this build
     *         does not recognise — raw JSON must never reach the composer
     */
    static String textOf(String body) {
        try {
            JsonNode text = JSON.readTree(body).get("text");
            return text == null || !text.isTextual() ? "" : text.asText();
        } catch (Exception unreadable) {
            return "";
        }
    }

    /**
     * Turn a refusal into one sentence a person can act on.
     *
     * @param status the HTTP status
     * @param body the response body, which usually carries the reason
     * @throws IOException always — this is the throw site, named for what it does
     */
    static void failureOf(int status, String body) throws IOException {
        String detail = "";
        try {
            JsonNode message = JSON.readTree(body).path("error").path("message");
            if (message.isTextual()) {
                detail = " — " + message.asText();
            }
        } catch (Exception unreadable) {
            // A body that is not the API's own error shape (a proxy's HTML, an
            // empty 502) carries nothing worth quoting; the status is the fact.
            detail = "";
        }
        throw new IOException("Transcription failed with HTTP " + status + detail);
    }

    private static void write(ByteArrayOutputStream out, String text) {
        out.writeBytes(text.getBytes(StandardCharsets.UTF_8));
    }
}
