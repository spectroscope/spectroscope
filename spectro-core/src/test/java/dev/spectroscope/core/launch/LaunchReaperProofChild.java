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
 * <p>The probe answers true without connecting anywhere: this proof is about
 * reaping, and a real port would only add a way for it to be flaky.
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
        LaunchSupervisor supervisor = new LaunchSupervisor((host, port) -> true);
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
