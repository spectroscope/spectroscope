package dev.spectroscope.samples.watch;

import dev.spectroscope.Spectro;
import dev.spectroscope.Tools;
import dev.spectroscope.core.events.RunEvent;
import dev.spectroscope.core.session.SessionStore;
import dev.spectroscope.core.trace.JsonlSink;

import java.nio.file.Path;

/**
 * Recording an embedded run so the cockpit can show it. The facade hands
 * you the event stream and nothing else — it does not persist. The tee is
 * one line: every event goes to a {@link JsonlSink} on its way through your
 * loop, and the session lands in {@code ~/.spectro/sessions/} where
 * {@code spectro web} lists it like any other run.
 */
public final class Watch {

    public static void main(String[] args) {
        var store = new SessionStore();          // mints the id, owns the file
        var sink = new JsonlSink(store);

        var agent = Spectro.agent()
                .model(new ScriptedProvider())
                .tools(Tools.writeFile(), Tools.readFile())
                .workspace(Path.of(System.getProperty("java.io.tmpdir"), "spectro-watch-sample"));

        for (RunEvent event : agent.run("Write hello.txt with a short greeting")) {
            sink.onEvent(event);                 // the tee — one line
            System.out.println(event);
        }

        System.out.println();
        System.out.println("Recorded session " + store.id());
        System.out.println("File: " + store.file());
        System.out.println("Open the cockpit (spectro web or the server jar) and the session is in the list.");
    }
}
