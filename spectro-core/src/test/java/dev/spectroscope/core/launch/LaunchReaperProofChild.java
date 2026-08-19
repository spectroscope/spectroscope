package dev.spectroscope.core.launch;

import java.nio.file.Path;
import java.time.Duration;
import java.util.List;
import java.util.concurrent.TimeUnit;

/**
 * The child half of the launch reaper proof: a separate JVM whose
 * {@link LaunchSupervisor} starts a real shell that spawns a real grandchild —
 * the {@code npm run dev} / Vite shape — and then blocks forever. The parent
 * SIGTERMs this JVM, which is exactly how a spectro-server dies, and BOTH
 * processes must die with it rather than orphaning a dev server on a port.
 *
 * <p>The probe connects to nothing: this proof is about reaping, and a real
 * port would only add a way for it to be flaky. But it does MODEL one, because
 * card 286 made the pre-spawn sample real — a probe that answers true before
 * anything has bound the port now means "a stranger holds it", and this start
 * would honestly be refused. So the stub answers the way an unoccupied port
 * does: silent on the first ask, which is the sample taken before the spawn,
 * and answering from then on, which is the command having come up.
 *
 * <p>Deterministic on purpose, and criterion 7 of that card is why: the port
 * exists here to make the start honest, not to become a second thing this proof
 * can be flaky about. There is no socket, no timing and no race — a counter.
 */
final class LaunchReaperProofChild {

    private LaunchReaperProofChild() {
    }

    /**
     * Starts the tree, announces both pids, then waits to be killed.
     *
     * @param args unused
     * @throws Exception when the tree never comes up
     */
    public static void main(String[] args) throws Exception {
        java.util.concurrent.atomic.AtomicBoolean bound =
                new java.util.concurrent.atomic.AtomicBoolean(false);
        LaunchSupervisor supervisor = new LaunchSupervisor((host, port) -> bound.getAndSet(true));
        LaunchEntry entry = new LaunchEntry("dev", 4321, "/bin/sh",
                List.of("-c", "sleep 3600 & echo grandchild:$!; wait"), null, List.of());
        LaunchSupervisor.Outcome outcome =
                supervisor.start(entry, Path.of("."), Duration.ofSeconds(10));
        if (!outcome.ok()) {
            throw new IllegalStateException("the tree did not start: " + outcome.problem());
        }
        System.out.println("shell-pid:" + outcome.running().pid());
        System.out.println("grandchild-pid:" + grandchild(supervisor));
        System.out.println("ready");
        System.out.flush();
        Thread.sleep(Long.MAX_VALUE);
    }

    private static long grandchild(LaunchSupervisor supervisor) throws InterruptedException {
        for (int attempt = 0; attempt < 100; attempt++) {
            for (String line : supervisor.logs("dev", 0).text().split("\n")) {
                if (line.startsWith("grandchild:")) {
                    return Long.parseLong(line.substring("grandchild:".length()).strip());
                }
            }
            TimeUnit.MILLISECONDS.sleep(100);
        }
        throw new IllegalStateException("the shell never announced its grandchild");
    }
}
