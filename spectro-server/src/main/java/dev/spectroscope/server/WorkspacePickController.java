package dev.spectroscope.server;

import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RestController;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;

/**
 * Opens the NATIVE folder chooser on the machine spectroscope runs on and returns the
 * picked absolute path. A browser cannot hand out filesystem paths — but spectroscope
 * is a local tool, so the server-side dialog (macOS: osascript "choose folder")
 * is the honest way to let the user point a session's workspace at a real
 * directory. The picked path then travels back over the socket as a
 * {@code set_workspace} message; this endpoint only picks, it changes nothing.
 */
@RestController
public class WorkspacePickController {

    /** How long the dialog waits for the human before giving up. */
    static final int DIALOG_TIMEOUT_SECONDS = 120;

    /** The AppleScript one-liner: a folder chooser that prints a POSIX path. */
    private static final List<String> OSASCRIPT_COMMAND = List.of(
            "osascript", "-e",
            "POSIX path of (choose folder with prompt \"spectroscope workspace\")");

    /** One dialog at a time — a second click must not stack system dialogs. */
    private final AtomicBoolean dialogOpen = new AtomicBoolean(false);

    private final FolderDialog dialog;

    /** The dialog seam — production runs osascript, tests inject a fake. */
    interface FolderDialog {
        /**
         * Blocks until the user picked or cancelled.
         *
         * @return the picked absolute path, or empty when the user cancelled
         * @throws UnsupportedOperationException when no native dialog exists here
         * @throws IOException when the dialog process itself fails
         * @throws InterruptedException when the wait is interrupted
         */
        Optional<String> choose() throws IOException, InterruptedException;
    }

    /** Production wiring: the osascript folder chooser. */
    public WorkspacePickController() {
        this(WorkspacePickController::chooseViaOsascript);
    }

    /**
     * Seam for tests.
     *
     * @param dialog the dialog implementation to use
     */
    WorkspacePickController(FolderDialog dialog) {
        this.dialog = dialog;
    }

    /**
     * Opens the folder chooser and answers with the picked path.
     *
     * @return 200 {@code {path}} on a pick, 204 on cancel, 409 while another
     *         dialog is open, 501 when the platform has no native dialog,
     *         500 when the dialog process fails
     */
    @PostMapping("/api/pick-workspace")
    public ResponseEntity<?> pick() {
        if (!dialogOpen.compareAndSet(false, true)) {
            return ResponseEntity.status(409)
                    .body(Map.of("message", "A folder dialog is already open."));
        }
        try {
            return dialog.choose()
                    .<ResponseEntity<?>>map(path -> ResponseEntity.ok(Map.of("path", path)))
                    .orElseGet(() -> ResponseEntity.noContent().build());
        } catch (UnsupportedOperationException unsupported) {
            return ResponseEntity.status(501).body(Map.of("message", unsupported.getMessage()));
        } catch (IOException | InterruptedException failure) {
            if (failure instanceof InterruptedException) {
                Thread.currentThread().interrupt();
            }
            return ResponseEntity.status(500)
                    .body(Map.of("message", "Folder dialog failed: " + failure.getMessage()));
        } finally {
            dialogOpen.set(false);
        }
    }

    /**
     * The production dialog: macOS osascript. Exit 0 prints the POSIX path;
     * a cancel exits non-zero (AppleScript "User canceled") — that is a normal
     * outcome, not an error.
     *
     * @return the picked path, or empty on cancel/timeout
     * @throws IOException when osascript cannot be started
     * @throws InterruptedException when the wait is interrupted
     */
    private static Optional<String> chooseViaOsascript() throws IOException, InterruptedException {
        if (!System.getProperty("os.name", "").toLowerCase().contains("mac")) {
            throw new UnsupportedOperationException(
                    "The native folder picker needs macOS (osascript). Set the workspace "
                            + "via config/SPECTRO_WORKSPACE instead.");
        }
        Process process = new ProcessBuilder(OSASCRIPT_COMMAND).start();
        if (!process.waitFor(DIALOG_TIMEOUT_SECONDS, TimeUnit.SECONDS)) {
            process.destroyForcibly();
            return Optional.empty(); // nobody picked — treat like a cancel
        }
        if (process.exitValue() != 0) {
            return Optional.empty(); // AppleScript cancel
        }
        String path = new String(process.getInputStream().readAllBytes(), StandardCharsets.UTF_8).strip();
        return path.isEmpty() ? Optional.empty() : Optional.of(path);
    }
}
