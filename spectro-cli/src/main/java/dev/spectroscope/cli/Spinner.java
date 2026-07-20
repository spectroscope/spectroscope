package dev.spectroscope.cli;

import java.time.Duration;

/**
 * A braille spinner on its own virtual thread, shown while the model is thinking
 * (between a turn start and its first visible output).
 *
 * <p>The renderer must call {@link #stop()} before printing anything, so the
 * animation frame never interleaves with real output. When ANSI is disabled
 * (piped output), start/stop are no-ops and nothing is written at all.</p>
 */
final class Spinner {

    private static final String[] FRAMES = {"⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"};
    private static final Duration FRAME_DELAY = Duration.ofMillis(80);

    private final Ansi ansi;
    private Thread ticker;

    /**
     * @param ansi supplies the styling AND the on/off decision — with styling
     *             disabled the spinner never draws
     */
    Spinner(Ansi ansi) {
        this.ansi = ansi;
    }

    /**
     * Starts the animation; a second start while running is ignored.
     *
     * @param label dimmed status text shown next to the spinning glyph, e.g. {@code "forging…"}
     */
    synchronized void start(String label) {
        if (!ansi.enabled() || ticker != null) {
            return;
        }
        ticker = Thread.ofVirtual().name("spectroscope-spinner").start(() -> {
            int frame = 0;
            try {
                while (!Thread.currentThread().isInterrupted()) {
                    System.out.print("\r" + ansi.coral(FRAMES[frame++ % FRAMES.length])
                            + " " + ansi.dim(label));
                    System.out.flush();
                    Thread.sleep(FRAME_DELAY);
                }
            } catch (InterruptedException stopped) {
                // stop() interrupts us — just exit; stop() wipes the frame.
            }
        });
    }

    /** Stops the animation and wipes the frame. Safe to call when not running. */
    synchronized void stop() {
        if (ticker == null) {
            return;
        }
        ticker.interrupt();
        try {
            ticker.join(Duration.ofMillis(200));
        } catch (InterruptedException interrupted) {
            Thread.currentThread().interrupt();
        }
        ticker = null;
        System.out.print(ansi.clearLine());
        System.out.flush();
    }
}
