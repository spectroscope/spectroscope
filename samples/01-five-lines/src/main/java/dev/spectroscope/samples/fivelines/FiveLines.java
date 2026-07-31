package dev.spectroscope.samples.fivelines;

import dev.spectroscope.Anthropic;
import dev.spectroscope.Spectro;
import dev.spectroscope.Tools;
import dev.spectroscope.core.events.RunEvent;

import java.nio.file.Path;

/**
 * The five lines, verbatim — spectroscope's frozen front door. One agent,
 * one provider, a tool belt, a workspace, and a plain for-loop over the
 * typed event stream. Needs {@code ANTHROPIC_API_KEY} in the environment
 * (or in {@code ~/.spectro/.env}).
 */
public final class FiveLines {

    public static void main(String[] args) {
        var agent = Spectro.agent()
                .model(Anthropic.opus())
                .tools(Tools.readFile(), Tools.runCommand())
                .workspace(Path.of("/tmp/scratch"));

        for (RunEvent event : agent.run("Write hello.py and run it")) {
            System.out.println(event);   // the stream IS the observability
        }
    }
}
