package dev.spectroscope.samples.hub;

import dev.spectroscope.Spectro;
import dev.spectroscope.core.events.RunEvent;

import java.nio.file.Path;

/**
 * The code leg of the cross-process fleet: an ordinary {@code Spectro.panel()}
 * run that, when {@code SPECTRO_HUB} is exported, ALSO mirrors every lane to
 * that fleet hub — the same hub the {@code spectro node} processes publish to.
 * The cockpit then shows this in-process fleet live, next to the node fleets.
 *
 * <p>The mirroring is env-first and additive: without {@code SPECTRO_HUB} this
 * is a plain local fleet run; with it, the returned stream is unchanged and
 * the hub receives a copy. A dead hub never blocks or fails the run.</p>
 *
 * <pre>
 * SPECTRO_HUB=127.0.0.1:7700 gradle run
 * </pre>
 */
public final class PanelToHub {

    public static void main(String[] args) {
        String hub = System.getenv("SPECTRO_HUB");
        System.out.println(hub == null || hub.isBlank()
                ? "SPECTRO_HUB is not set — running as a plain local fleet (export SPECTRO_HUB=127.0.0.1:7700 to mirror)."
                : "Mirroring every lane to the fleet hub at " + hub + ".");

        var panel = Spectro.panel()
                .model(new ScriptedProvider("nothing to report"))
                .workspace(Path.of(System.getProperty("java.io.tmpdir"), "spectro-hub-sample"));

        panel.agent("bugs")
                .model(new ScriptedProvider("Reviewed the diff: the null check on line 42 is inverted."))
                .task("Find bugs in the diff");
        panel.agent("perf")
                .model(new ScriptedProvider("The order lookup misses its index; everything else is fine."))
                .task("Check the hot queries");

        for (RunEvent event : panel.run()) {
            System.out.println(event);
        }
    }
}
