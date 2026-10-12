package dev.spectroscope.server.web;

import org.springframework.core.io.ClassPathResource;
import org.springframework.http.CacheControl;
import org.springframework.http.ContentDisposition;
import org.springframework.http.HttpHeaders;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RestController;

import java.io.IOException;
import java.io.InputStream;

/**
 * Serves the SearXNG setup script from the running app (card 531).
 *
 * <p>The Settings block offers a download of this file, so a user of the DMG
 * needs neither git nor a clone. The file is {@code samples/09-searxng/install.sh},
 * copied into the jar at {@link #RESOURCE} by {@code processResources}; it writes
 * its compose file itself when none is beside it.</p>
 *
 * <p>Outside {@code /api} and so outside {@link ApiLocalFence}, like the rest of
 * the static files: the script carries no machine data and is the same file on
 * every machine. One fixed name, no path variable, so nothing here reads a file
 * name from the request. The answer is {@code text/plain} with
 * {@code Content-Disposition: attachment}: a browser saves it instead of
 * rendering or running it, and {@code curl -O} keeps the name from the URL.</p>
 */
@RestController
public class LocalSetupScriptController {

    /** The route the web bundle prints; LocalSetupScriptControllerTest holds them equal. */
    public static final String ROUTE = "/local-setup/scripts/install-searxng.sh";

    /** Where the build puts the copy of the sample, on the classpath. */
    public static final String RESOURCE = "static/local-setup/scripts/install-searxng.sh";

    private static final String FILE_NAME = "install-searxng.sh";

    /**
     * The script, as a file to save.
     *
     * @return 200 with the script, or 404 when the jar was built without it
     * @throws IOException when the resource exists and cannot be read
     */
    @GetMapping(ROUTE)
    public ResponseEntity<byte[]> searxng() throws IOException {
        ClassPathResource script = new ClassPathResource(RESOURCE);
        if (!script.exists()) {
            return ResponseEntity.notFound().build();
        }
        byte[] body;
        try (InputStream in = script.getInputStream()) {
            body = in.readAllBytes();
        }
        return ResponseEntity.ok()
                .contentType(new MediaType(MediaType.TEXT_PLAIN, java.nio.charset.StandardCharsets.UTF_8))
                .header(HttpHeaders.CONTENT_DISPOSITION,
                        ContentDisposition.attachment().filename(FILE_NAME).build().toString())
                .header("X-Content-Type-Options", "nosniff")
                .cacheControl(CacheControl.noCache())
                .body(body);
    }
}
