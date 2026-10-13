package dev.spectroscope.orchestrator;

import java.io.IOException;
import java.net.BindException;
import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.util.Locale;

/**
 * The fleet hub's two settings and what a server makes of them (card 585).
 *
 * <p>{@code SPECTRO_HUB_ENABLED} is the switch: {@code true}, {@code on},
 * {@code yes} or {@code 1} turn the hub on, {@code false}, {@code off},
 * {@code no} or {@code 0} keep it off, in any case. {@code SPECTRO_HUB_PORT} is
 * only the port, default {@value #DEFAULT_PORT}. Without the switch a port
 * alone also turns the hub on.</p>
 *
 * <p>The rules the owner set: the hub never binds a port under 1024, never one
 * in {@value #APP_FIRST} to {@value #APP_LAST}, where the app's own server
 * runs, and never the server's own port. Such a port, or one that is not a
 * port number, makes the hub walk from {@value #DEFAULT_PORT} upwards to the
 * first free loopback port. Any other written port is used as written; if it
 * cannot open, or another program already listens on it, the hub is off.
 * Nothing here throws: the caller always gets an {@link Outcome} and a
 * sentence that says what happened.</p>
 *
 * <p>Port {@code 0} keeps its old meaning, a port the operating system
 * assigns. That is never under 1024; the tests use it.</p>
 */
public final class HubSettings {

    private HubSettings() {}

    /** The switch. */
    public static final String ENABLED = "SPECTRO_HUB_ENABLED";
    /** The port. */
    public static final String PORT = "SPECTRO_HUB_PORT";
    /** Where the walk for a free port starts, and the port the settings show. */
    public static final int DEFAULT_PORT = 7700;
    /** The lowest port the hub may bind; everything below needs admin rights. */
    public static final int LOWEST_PORT = 1024;
    /** The first port of the app's own server range. */
    public static final int APP_FIRST = 8080;
    /** The last port of the app's own server range. */
    public static final int APP_LAST = 8100;
    /** The highest port there is. */
    private static final int HIGHEST_PORT = 65535;
    /** How long the "does anyone answer here" probe waits per address. */
    private static final int PROBE_MS = 200;

    /** Why the hub is not simply on as written, or off as asked. */
    public enum Note {
        /** Nothing to say: on as written, or off because nobody asked. */
        NONE,
        /** The switch holds a word that is neither on nor off; the hub stays off. */
        ENABLED_UNREADABLE,
        /** The written port is under 1024; the hub took a free one from the default up. */
        PORT_PRIVILEGED,
        /** The written port is not a port number; the hub took a free one from the default up. */
        PORT_INVALID,
        /** The written port is in the app's own range; the hub took a free one from the default up. */
        PORT_APP_RANGE,
        /** The written port is the server's own; the hub took a free one from the default up. */
        PORT_SERVER,
        /** No port was written and the default was busy; the hub took the next free one. */
        DEFAULT_TAKEN,
        /** The written port could not open; the hub stays off. */
        BIND_FAILED,
        /** No loopback port from the default up was free; the hub stays off. */
        NO_FREE_PORT,
        /** A setting could not be read at all (an unresolvable placeholder); the hub stays off. */
        SETTING_UNREADABLE;

        /** @return the wire form, e.g. {@code bind-failed}, or null for {@link #NONE} */
        public String wire() {
            return this == NONE ? null : name().toLowerCase(Locale.ROOT).replace('_', '-');
        }
    }

    /**
     * What the two settings ask for, before anything is bound.
     *
     * @param enabledSetting the switch as read, null when not set
     * @param portSetting    the port as read, null when not set
     * @param on             whether a hub is wanted at all
     * @param pick           true when the hub walks for a free port instead of a written one
     * @param writtenPort    the port to bind when {@code pick} is false (0 = OS-assigned), else -1
     * @param pickFrom       where the walk starts when {@code pick} is true
     * @param serverPort     the server's own port, 0 when not known
     * @param note           why the plan differs from the written values
     * @param detail         what could not be read, for {@link Note#SETTING_UNREADABLE}, else null
     */
    public record Plan(String enabledSetting, String portSetting, boolean on, boolean pick,
                       int writtenPort, int pickFrom, int serverPort, Note note, String detail) {
    }

    /**
     * What happened when the plan met the machine.
     *
     * @param plan   the plan
     * @param hub    the running hub, or null when it is off
     * @param port   the bound port, or -1 when the hub is off
     * @param note   why the result differs from the written values
     * @param reason the bind error in the system's words, or what could not be read, or null
     */
    public record Outcome(Plan plan, ProcessBusHub hub, int port, Note note, String reason) {

        /** @return true when a hub is listening */
        public boolean on() {
            return port >= 0;
        }

        /** @return one plain English sentence for the log, the roster and doctor */
        public String describe() {
            String written = plan.portSetting() == null ? "" : plan.portSetting();
            return switch (note) {
                case ENABLED_UNREADABLE -> ENABLED + "=\"" + plan.enabledSetting()
                        + "\" is not true or false, so the fleet hub stays off.";
                case PORT_PRIVILEGED -> PORT + "=" + written
                        + " is under 1024 and needs admin rights, so the fleet hub took port "
                        + port + " instead.";
                case PORT_INVALID -> PORT + "=\"" + written
                        + "\" is not a port number, so the fleet hub took port " + port + " instead.";
                case PORT_APP_RANGE -> PORT + "=" + written + " is in " + APP_FIRST + " to " + APP_LAST
                        + ", where the app's own server runs, so the fleet hub took port " + port + " instead.";
                case PORT_SERVER -> PORT + "=" + written
                        + " is this server's own port, so the fleet hub took port " + port + " instead.";
                case DEFAULT_TAKEN -> "Port " + plan.pickFrom()
                        + " is in use, so the fleet hub took port " + port + ".";
                case BIND_FAILED -> "The fleet hub stays off: port " + plan.writtenPort()
                        + " (" + PORT + ") could not be opened: " + reason + ". The app runs without it.";
                case NO_FREE_PORT -> "The fleet hub stays off: no loopback port from "
                        + plan.pickFrom() + " up was free.";
                case SETTING_UNREADABLE -> "The fleet hub stays off: " + plan.detail() + ".";
                case NONE -> on()
                        ? "The fleet hub listens on loopback port " + port + "."
                        : offSentence(plan);
            };
        }
    }

    private static String offSentence(Plan plan) {
        if (plan.enabledSetting() != null) {
            return "The fleet hub is off (" + ENABLED + "=" + plan.enabledSetting() + ").";
        }
        return "The fleet hub is off (" + ENABLED + " and " + PORT + " are not set).";
    }

    /**
     * Reads the two settings into a plan that walks from {@link #DEFAULT_PORT}.
     *
     * @param enabled the raw switch, null or blank when not set
     * @param port    the raw port, null or blank when not set
     * @return the plan; never throws
     */
    public static Plan plan(String enabled, String port) {
        return plan(enabled, port, DEFAULT_PORT, 0);
    }

    /**
     * Reads the two settings into a plan, the server's port not known.
     *
     * @param enabled  the raw switch, null or blank when not set
     * @param port     the raw port, null or blank when not set
     * @param pickFrom where a walk for a free port starts (tests move it off 7700)
     * @return the plan; never throws
     */
    public static Plan plan(String enabled, String port, int pickFrom) {
        return plan(enabled, port, pickFrom, 0);
    }

    /**
     * Reads the two settings into a plan.
     *
     * @param enabled    the raw switch, null or blank when not set
     * @param port       the raw port, null or blank when not set
     * @param pickFrom   where a walk for a free port starts (tests move it off 7700)
     * @param serverPort the server's own port, 0 when not known
     * @return the plan; never throws
     */
    public static Plan plan(String enabled, String port, int pickFrom, int serverPort) {
        String switchValue = blankToNull(enabled);
        String portValue = blankToNull(port);
        Boolean wanted = readSwitch(switchValue);
        if (switchValue != null && wanted == null) {
            return new Plan(switchValue, portValue, false, false, -1, pickFrom, serverPort,
                    Note.ENABLED_UNREADABLE, null);
        }
        boolean on = wanted != null ? wanted : portValue != null;
        if (!on) {
            return new Plan(switchValue, portValue, false, false, -1, pickFrom, serverPort, Note.NONE, null);
        }
        if (portValue == null) {
            return walk(switchValue, null, pickFrom, serverPort, Note.NONE);
        }
        String problem = portProblem(portValue, serverPort);
        if (problem == null) {
            int number = Integer.parseInt(portValue);
            return new Plan(switchValue, portValue, true, false, number, pickFrom, serverPort, Note.NONE, null);
        }
        Note note = switch (problem) {
            case "under-1024" -> Note.PORT_PRIVILEGED;
            case "app-range" -> Note.PORT_APP_RANGE;
            case "server-port" -> Note.PORT_SERVER;
            default -> Note.PORT_INVALID;
        };
        return walk(switchValue, portValue, pickFrom, serverPort, note);
    }

    private static Plan walk(String switchValue, String portValue, int pickFrom, int serverPort, Note note) {
        return new Plan(switchValue, portValue, true, true, -1, pickFrom, serverPort, note, null);
    }

    /**
     * A plan for a setting that could not be read at all: the hub stays off.
     *
     * @param name   the setting's name
     * @param detail what went wrong, in the resolver's words
     * @return an off plan that says why
     */
    public static Plan unreadable(String name, String detail) {
        return new Plan(null, null, false, false, -1, DEFAULT_PORT, 0, Note.SETTING_UNREADABLE,
                name + " could not be read (" + (detail == null ? "no reason given" : detail.strip()) + ")");
    }

    /**
     * Reads a switch word.
     *
     * @param value the trimmed value, or null
     * @return true or false, or null when it is not one of the eight words
     */
    public static Boolean readSwitch(String value) {
        if (value == null) {
            return null;
        }
        return switch (value.strip().toLowerCase(Locale.ROOT)) {
            case "true", "on", "yes", "1" -> Boolean.TRUE;
            case "false", "off", "no", "0" -> Boolean.FALSE;
            default -> null;
        };
    }

    /**
     * Why a port may not be saved as the hub port, the server's port not known.
     *
     * @param value the trimmed value
     * @return a reason, or null when it may be saved
     */
    public static String portProblem(String value) {
        return portProblem(value, 0);
    }

    /**
     * Why a port may not be saved as the hub port, or null when it may. Blank
     * and {@code 0} may; 1024 to 65535 may, except the app's own range and the
     * server's own port.
     *
     * @param value      the trimmed value
     * @param serverPort the server's own port, 0 when not known
     * @return {@code under-1024}, {@code not-a-port}, {@code app-range},
     *         {@code server-port}, or null
     */
    public static String portProblem(String value, int serverPort) {
        if (value == null || value.isBlank()) {
            return null;
        }
        int number;
        try {
            number = Integer.parseInt(value.strip());
        } catch (NumberFormatException notANumber) {
            return "not-a-port";
        }
        if (number < 0 || number > HIGHEST_PORT) {
            return "not-a-port";
        }
        if (number == 0) {
            return null;
        }
        if (number < LOWEST_PORT) {
            return "under-1024";
        }
        if (number >= APP_FIRST && number <= APP_LAST) {
            return "app-range";
        }
        return serverPort > 0 && number == serverPort ? "server-port" : null;
    }

    /**
     * The plain English answer to a refused hub setting.
     *
     * @param problem {@code under-1024}, {@code app-range}, {@code server-port},
     *                {@code not-a-port} or {@code not-a-switch}
     * @return one sentence that says what to type instead
     */
    public static String refusal(String problem) {
        String instead = " Use a port from 1024 to 65535, or leave the field empty for " + DEFAULT_PORT + ".";
        return switch (problem) {
            case "under-1024" -> "Ports under 1024 need admin rights." + instead;
            case "app-range" -> "Ports " + APP_FIRST + " to " + APP_LAST + " belong to the app's own server." + instead;
            case "server-port" -> "That is this server's own port." + instead;
            case "not-a-switch" -> "Use true or false.";
            default -> "That is not a port number." + instead;
        };
    }

    /**
     * The first port a walk from {@code from} tries, the server's port not known.
     *
     * @param from where the walk wants to start
     * @return the first allowed port at or above it, or -1 when there is none
     */
    public static int firstCandidate(int from) {
        return firstCandidate(from, 0);
    }

    /**
     * The first port a walk from {@code from} tries: never under 1024, never
     * in the app's own range, never the server's own port.
     *
     * @param from       where the walk wants to start
     * @param serverPort the server's own port, 0 when not known
     * @return the first allowed port at or above it, or -1 when there is none
     */
    public static int firstCandidate(int from, int serverPort) {
        int port = Math.max(from, LOWEST_PORT);
        while (port <= HIGHEST_PORT
                && ((port >= APP_FIRST && port <= APP_LAST) || (serverPort > 0 && port == serverPort))) {
            port = port >= APP_FIRST && port <= APP_LAST ? APP_LAST + 1 : port + 1;
        }
        return port > HIGHEST_PORT ? -1 : port;
    }

    /**
     * @param port the port just tried
     * @return the next allowed port, or -1 after 65535
     */
    public static int nextCandidate(int port) {
        return nextCandidate(port, 0);
    }

    /**
     * @param port       the port just tried
     * @param serverPort the server's own port, 0 when not known
     * @return the next allowed port, or -1 after 65535
     */
    public static int nextCandidate(int port, int serverPort) {
        return port >= HIGHEST_PORT ? -1 : firstCandidate(port + 1, serverPort);
    }

    /** Opens one hub on one port; a test can count or fail the attempts. */
    @FunctionalInterface
    public interface Binder {
        /**
         * @param port the loopback port to bind
         * @return the listening hub
         * @throws IOException when the port cannot be bound
         */
        ProcessBusHub bind(int port) throws IOException;
    }

    /**
     * Opens the hub the plan asks for, on loopback, and never next to another
     * program that already listens on the port.
     *
     * @param plan the plan
     * @return the outcome; never throws
     */
    public static Outcome open(Plan plan) {
        return open(plan, HubSettings::bindIfNobodyAnswers);
    }

    /**
     * Opens the hub the plan asks for.
     *
     * @param plan   the plan
     * @param binder how one port is bound
     * @return the outcome; never throws
     */
    public static Outcome open(Plan plan, Binder binder) {
        if (!plan.on()) {
            return new Outcome(plan, null, -1, plan.note(), plan.detail());
        }
        if (!plan.pick()) {
            try {
                ProcessBusHub hub = binder.bind(plan.writtenPort());
                return new Outcome(plan, hub, hub.port(), Note.NONE, null);
            } catch (IOException | RuntimeException failed) {
                return new Outcome(plan, null, -1, Note.BIND_FAILED, reasonOf(failed));
            }
        }
        for (int port = firstCandidate(plan.pickFrom(), plan.serverPort()); port != -1;
             port = nextCandidate(port, plan.serverPort())) {
            try {
                ProcessBusHub hub = binder.bind(port);
                Note note = plan.note() != Note.NONE ? plan.note()
                        : port != plan.pickFrom() ? Note.DEFAULT_TAKEN : Note.NONE;
                return new Outcome(plan, hub, hub.port(), note, null);
            } catch (IOException | RuntimeException busy) {
                // taken or refused: try the next one
            }
        }
        return new Outcome(plan, null, -1, Note.NO_FREE_PORT, null);
    }

    /**
     * Binds a hub unless another program already answers on the port. A bind
     * on 127.0.0.1 alone succeeds next to a wildcard listener on macOS, so the
     * probe asks first.
     */
    private static ProcessBusHub bindIfNobodyAnswers(int port) throws IOException {
        if (port != 0 && answers(port)) {
            throw new BindException("another program already listens on it");
        }
        return new ProcessBusHub(port);
    }

    /**
     * Whether a loopback port can be bound right now, the way the hub binds
     * it, and nobody answers on it.
     *
     * @param port the port, 1024 to 65535
     * @return true when nobody answers and a bind succeeded (released at once)
     */
    public static boolean free(int port) {
        if (answers(port)) {
            return false;
        }
        try (ServerSocket probe = new ServerSocket()) {
            probe.bind(new InetSocketAddress(InetAddress.getLoopbackAddress(), port));
            return true;
        } catch (IOException | RuntimeException taken) {
            return false;
        }
    }

    /**
     * Whether anything accepts a connection on 127.0.0.1 or [::1] at this port.
     *
     * @param port the port
     * @return true when either address answers within the probe time
     */
    static boolean answers(int port) {
        for (String address : new String[] {"127.0.0.1", "::1"}) {
            try (Socket socket = new Socket()) {
                socket.connect(new InetSocketAddress(InetAddress.getByName(address), port), PROBE_MS);
                return true;
            } catch (IOException | RuntimeException nobody) {
                // refused, unreachable or no IPv6: nobody answers here
            }
        }
        return false;
    }

    private static String reasonOf(Exception failed) {
        String message = failed.getMessage();
        return message == null || message.isBlank() ? failed.getClass().getSimpleName() : message.strip();
    }

    private static String blankToNull(String value) {
        return value == null || value.isBlank() ? null : value.strip();
    }
}
