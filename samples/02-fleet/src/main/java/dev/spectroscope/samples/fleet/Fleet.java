package dev.spectroscope.samples.fleet;

import dev.spectroscope.Spectro;
import dev.spectroscope.core.events.RunEvent;

import java.nio.file.Path;

/**
 * The fleet path: several agents, one merged event stream. Each lane is a
 * full agent on its own virtual thread; the panel merges every lane's
 * events — plus the A2A task/status/result messages between them — into a
 * single stream you consume with the same for-loop as a single agent.
 *
 * <p>This main runs offline on a scripted provider. To point the fleet at a
 * real model, replace the providers — see the README.</p>
 */
public final class Fleet {

    public static void main(String[] args) {
        var panel = Spectro.panel()
                .model(new ScriptedProvider("nothing to report"))
                .workspace(Path.of(System.getProperty("java.io.tmpdir"), "spectro-fleet-sample"));

        panel.agent("bugs")
                .model(new ScriptedProvider("Reviewed the diff: the null check on line 42 is inverted."))
                .task("Find bugs in the diff");
        panel.agent("perf")
                .model(new ScriptedProvider("The order lookup misses its index; everything else is fine."))
                .task("Check the hot queries");

        for (RunEvent event : panel.run()) {
            System.out.println(event);   // every lane, one spectrum
        }
    }
}
