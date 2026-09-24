package dev.spectroscope.core.tools;

import java.util.ArrayList;
import java.util.Collection;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.Set;

/**
 * Card 396: the desktop app's process tree at 17:09:50 on 2026-09-23, the
 * moment before the first self-kill, as a fake {@link HostGuard.ProcessTable}.
 *
 * <p>Where each row comes from:</p>
 * <ul>
 *   <li>60380, 60381, 60382: the {@code ps -eo pid,etime,stat,command} output
 *       the agent read back at session line 90305 of session
 *       {@code 20260923-145313-ada4053d}, command lines verbatim except two
 *       paths: the app's path down to the repository (the home directory,
 *       two folders and the repository folder) is replaced by
 *       {@code /Users/dev/work/spectro}, and the home directory in
 *       {@code --user-data-dir} by {@code /Users/dev}. A pattern aimed at one
 *       of the replaced folder names would match the real host and not this
 *       table.</li>
 *   <li>60383, the JVM: the server log line "Starting SpectroServerApplication
 *       ... with PID 60383" at 16:18:52, port 54704 from "Tomcat started on
 *       port 54704" in the same start. Its command line is the shape the
 *       desktop spawns ({@code spectro-desktop/src/main.ts}, spawnServer),
 *       taken from {@code ps} of a JVM the same build started on the same
 *       day, with this app's path.</li>
 *   <li>Parents and groups are not in those {@code ps} columns. Electron
 *       starts its helpers and {@code main.ts} starts the JVM from the main
 *       process, so all three hang under 60380. A JVM of the same build,
 *       measured on 2026-09-24, reported a group equal to its Electron
 *       parent's pid, so the group here is 60380.</li>
 *   <li>71000 to 71002 are made up: a terminal with a vitest run and a vite
 *       dev server on port 5173, the unrelated processes a legitimate kill
 *       aims at.</li>
 * </ul>
 */
final class MeasuredHost implements HostGuard.ProcessTable {

    static final String APP =
            "/Users/dev/work/spectro/spectro-desktop/release/mac-arm64/spectroscope.app";
    static final String HELPER_EXE =
            APP + "/Contents/Frameworks/spectroscope Helper.app/Contents/MacOS/spectroscope Helper";
    /**
     * The bundled JRE's launcher, the executable of row 60383. Written as two
     * literals because ChildJvmsInheritTheTestHomeDriftTest counts a test
     * source whose literal ends in the launcher path, closing quote included,
     * as one that starts a child JVM. This file starts no process. The joined
     * value is a compile-time constant and equals the single literal it
     * replaces.
     */
    static final String JAVA = APP + "/Contents/Resources/jre/bin" + "/java";
    static final String CHROMIUM_TAIL = " --shared-files"
            + " --field-trial-handle=1718379636,r,973881214617308753,15567445932645413208,262144"
            + " --enable-features=PdfUseShowSaveFilePicker,ScreenCaptureKitPickerScreen,"
            + "ScreenCaptureKitStreamPickerSonoma"
            + " --disable-features=DropInputEventsWhilePaintHolding,LocalNetworkAccessChecks,"
            + "ScreenAIOCREnabled,SpareRendererForSitePerProcess,TimeoutHangingVideoCaptureStarts,"
            + "TraceSiteInstanceGetProcessCreation"
            + " --variations-seed-version"
            + " --pseudonymization-salt-handle=1935764596,r,7052449455187938637,902537871485178471,4";

    static final long LAUNCHD = 1;
    static final long ELECTRON = 60380;
    static final long GPU_HELPER = 60381;
    static final long NETWORK_HELPER = 60382;
    static final long JVM = 60383;
    static final long TERMINAL = 71000;
    static final long VITEST = 71001;
    static final long VITE = 71002;
    static final int SERVER_PORT = 54704;

    /** The three commands of the self-kills, verbatim from the session. */
    static final String AT_17_09 = "pkill -f \"spectroscope\\.app\" 2>/dev/null; sleep 2;"
            + " ps -eo pid,etime,stat,command | grep -E \"spectroscope\\.app\" | grep -v grep"
            + " | head -3 && echo \"--- after kill ---\" && ps -eo pid,etime,stat,command"
            + " | grep -E \"spectroscope\\.app\" | grep -v grep | head -3 && echo \"should be empty\"";
    static final String AT_19_00 = "pkill -9 -f \"spectroscope Helper\" 2>/dev/null\n"
            + "pkill -9 -f \"spectroscope\\\\.app/Contents/MacOS/spectroscope\" 2>/dev/null\n"
            + "sleep 1\n"
            + "echo \"=== survivors ===\"\n"
            + "pgrep -fl \"spectroscope\" | grep -v -E \"pgrep|grep\" | head\n"
            + "echo \"--- nothing means clean ---\"";
    static final String AT_19_02 = "pkill -9 -f \"spectroscope Helper\" 2>/dev/null\n"
            + "pkill -9 -f \"spectroscope.app/Contents/MacOS/spectroscope\" 2>/dev/null\n"
            + "sleep 2\n"
            + "echo \"=== survivors ===\"\n"
            + "pgrep -fl \"spectroscope\" | grep -v -E \"pgrep|grep\" | wc -l\n"
            + "echo \"--- clean ---\"";

    /** One row of the fake {@code ps}. */
    record Row(long pid, long ppid, long pgid, String executable, String commandLine) {
    }

    private final Map<Long, Row> rows;

    private MeasuredHost(Map<Long, Row> rows) {
        this.rows = rows;
    }

    /** @return the tree at 17:09:50 on 2026-09-23 */
    static MeasuredHost atTheFirstSelfKill() {
        Map<Long, Row> rows = new LinkedHashMap<>();
        put(rows, new Row(LAUNCHD, 0, 1, "/sbin/launchd", "/sbin/launchd"));
        put(rows, new Row(ELECTRON, LAUNCHD, ELECTRON, APP + "/Contents/MacOS/spectroscope",
                APP + "/Contents/MacOS/spectroscope"));
        put(rows, new Row(GPU_HELPER, ELECTRON, ELECTRON, HELPER_EXE, HELPER_EXE
                + " --type=gpu-process"
                + " --user-data-dir=/Users/dev/Library/Application Support/spectro-desktop"
                + " --gpu-preferences=UAAAAAAAAAAgAQAEAAAAAAAAAAAAAGAAOAAAAAAAAAADAAAAAAAAAAAAAAAAAAAA"
                + "AgAAAAAAAAAAAAAAAAAAABgAAAAAAAAAGAAAAAAAAAAIAAAAAAAAAAgAAAAAAAAACAAAAAAAAAA="
                + CHROMIUM_TAIL
                + " --trace-process-track-uuid=3190708988185955192 --seatbelt-client=31"));
        put(rows, new Row(NETWORK_HELPER, ELECTRON, ELECTRON, HELPER_EXE, HELPER_EXE
                + " --type=utility --utility-sub-type=network.mojom.NetworkService --lang=en-GB"
                + " --service-sandbox-type=network"
                + " --user-data-dir=/Users/dev/Library/Application Support/spectro-desktop"
                + CHROMIUM_TAIL
                + " --trace-process-track-uuid=3190708989122997041 --seatbelt-client=31"));
        put(rows, new Row(JVM, ELECTRON, ELECTRON, JAVA,
                JAVA + " -XX:MaxRAMPercentage=33"
                        + " -Dspectro.bundle.bin=" + APP + "/Contents/Resources/bin"
                        + " -jar " + APP + "/Contents/Resources/spectro-server.jar"
                        + " --server.port=" + SERVER_PORT));
        put(rows, new Row(TERMINAL, LAUNCHD, TERMINAL, "/bin/zsh", "-zsh"));
        put(rows, new Row(VITEST, TERMINAL, VITEST, "/opt/homebrew/bin/node",
                "node /Users/dev/work/spectro/spectro-web/node_modules/.bin/vitest run"));
        put(rows, new Row(VITE, TERMINAL, VITE, "/opt/homebrew/bin/node",
                "node /Users/dev/work/spectro/spectro-web/node_modules/.bin/vite --port 5173"));
        return new MeasuredHost(rows);
    }

    /**
     * The same tree with one process moved to another group.
     *
     * @param pid  the process to move
     * @param pgid its new group
     * @return a new table
     */
    MeasuredHost withGroup(long pid, long pgid) {
        Map<Long, Row> copy = new LinkedHashMap<>(rows);
        Row row = copy.get(pid);
        copy.put(pid, new Row(row.pid(), row.ppid(), pgid, row.executable(), row.commandLine()));
        return new MeasuredHost(copy);
    }

    /**
     * The same tree with one process moved under another parent.
     *
     * @param pid  the process to move
     * @param ppid its new parent
     * @return a new table
     */
    MeasuredHost withParent(long pid, long ppid) {
        Map<Long, Row> copy = new LinkedHashMap<>(rows);
        Row row = copy.get(pid);
        copy.put(pid, new Row(row.pid(), ppid, row.pgid(), row.executable(), row.commandLine()));
        return new MeasuredHost(copy);
    }

    /** @return the guard over this tree, with the server's port 54704 */
    static HostGuard guard() {
        return HostGuard.over(atTheFirstSelfKill(), Set.of(SERVER_PORT));
    }

    private static void put(Map<Long, Row> rows, Row row) {
        rows.put(row.pid(), row);
    }

    @Override
    public long self() {
        return JVM;
    }

    @Override
    public Optional<Long> parentOf(long pid) {
        Row row = rows.get(pid);
        return row == null || row.ppid() == 0 ? Optional.empty() : Optional.of(row.ppid());
    }

    @Override
    public List<Long> childrenOf(long pid) {
        List<Long> children = new ArrayList<>();
        for (Row row : rows.values()) {
            if (row.ppid() == pid) {
                children.add(row.pid());
            }
        }
        return children;
    }

    @Override
    public Optional<HostGuard.Proc> describe(long pid) {
        Row row = rows.get(pid);
        return row == null ? Optional.empty()
                : Optional.of(new HostGuard.Proc(pid, row.executable(), row.commandLine()));
    }

    @Override
    public Map<Long, Long> groupsOf(Collection<Long> pids) {
        Map<Long, Long> groups = new LinkedHashMap<>();
        for (long pid : pids) {
            Row row = rows.get(pid);
            if (row != null) {
                groups.put(pid, row.pgid());
            }
        }
        return groups;
    }
}
