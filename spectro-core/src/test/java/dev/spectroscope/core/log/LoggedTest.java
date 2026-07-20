package dev.spectroscope.core.log;

import ch.qos.logback.classic.Level;
import ch.qos.logback.classic.Logger;
import ch.qos.logback.classic.spi.ILoggingEvent;
import ch.qos.logback.core.read.ListAppender;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.slf4j.LoggerFactory;

import java.util.List;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertSame;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * The autologging proxy (method entry/exit without hand-written statements —
 * the owner's "Autologging via Injection", container-free by construction):
 * results and exceptions pass through UNTOUCHED, entry logs the abbreviated
 * args, exit logs the duration, everything at DEBUG under the port's logger —
 * and at INFO the proxy is silent. Records are captured with an in-memory
 * appender; no console, no file.
 */
class LoggedTest {

    /** A port-shaped interface, stand-in for LlmProvider/Tool/…. */
    interface Greeter {
        String greet(String name);

        void boom(String reason);

        /** Zero-arg = metadata by port convention (name(), description(), tier(), …). */
        String tier();
    }

    private Logger logger;
    private ListAppender<ILoggingEvent> records;
    private Level before;

    @BeforeEach
    void capture() {
        logger = (Logger) LoggerFactory.getLogger(Greeter.class);
        before = logger.getLevel();
        logger.setLevel(Level.DEBUG);
        records = new ListAppender<>();
        records.start();
        logger.addAppender(records);
    }

    @AfterEach
    void release() {
        logger.detachAppender(records);
        logger.setLevel(before);
    }

    private List<String> messages() {
        return records.list.stream().map(ILoggingEvent::getFormattedMessage).toList();
    }

    @Test
    void forwardsResultsUntouchedAndLogsEntryAndExit() {
        Greeter real = new Greeter() {
            public String greet(String name) { return "Hallo " + name; }
            public void boom(String reason) { }
            public String tier() { return "t"; }
        };

        Greeter wrapped = Logged.wrap(Greeter.class, real);
        String result = wrapped.greet("Owner");

        assertEquals("Hallo Owner", result, "the proxy must never alter results");
        assertEquals(2, records.list.size(), "entry + exit, got: " + messages());
        assertTrue(messages().get(0).contains("greet") && messages().get(0).contains("Owner"),
                "entry names method and args, got: " + messages().get(0));
        assertTrue(messages().get(1).contains("greet") && messages().get(1).contains("ms"),
                "exit names method and duration, got: " + messages().get(1));
    }

    @Test
    void longArgumentsAreAbbreviatedNeverDumped() {
        Greeter real = new Greeter() {
            public String greet(String name) { return "ok"; }
            public void boom(String reason) { }
            public String tier() { return "t"; }
        };

        Logged.wrap(Greeter.class, real).greet("x".repeat(5_000));

        assertTrue(messages().get(0).length() < 400,
                "a huge payload arg must be abbreviated, got length " + messages().get(0).length());
    }

    @Test
    void exceptionsPassThroughIdenticallyAndAreLogged() {
        IllegalStateException original = new IllegalStateException("kaputt");
        Greeter real = new Greeter() {
            public String greet(String name) { return "ok"; }
            public void boom(String reason) { throw original; }
            public String tier() { return "t"; }
        };

        Greeter wrapped = Logged.wrap(Greeter.class, real);
        IllegalStateException thrown =
                assertThrows(IllegalStateException.class, () -> wrapped.boom("now"));

        assertSame(original, thrown, "the SAME exception object, never an Undeclared/Invocation wrapper");
        assertTrue(messages().get(records.list.size() - 1).contains("kaputt"),
                "the failure is logged, got: " + messages());
    }

    @Test
    void silentWhenDebugIsDisabled() {
        logger.setLevel(Level.INFO);
        Greeter real = new Greeter() {
            public String greet(String name) { return "ok"; }
            public void boom(String reason) { }
            public String tier() { return "t"; }
        };

        assertEquals("ok", Logged.wrap(Greeter.class, real).greet("x"));
        assertEquals(0, records.list.size(), "at INFO the proxy is silent");
    }

    @Test
    void zeroArgMetadataMethodsLogAtTraceOnly() {
        // name()/description()/tier() would bury the execute() lines at DEBUG —
        // zero-arg methods are metadata by port convention and drop to TRACE.
        Greeter real = new Greeter() {
            public String greet(String name) { return "ok"; }
            public void boom(String reason) { }
            public String tier() { return "the-tier"; }
        };
        Greeter wrapped = Logged.wrap(Greeter.class, real);

        assertEquals("the-tier", wrapped.tier());
        assertEquals(0, records.list.size(), "metadata is silent at DEBUG");

        logger.setLevel(Level.TRACE);
        wrapped.tier();
        assertEquals(2, records.list.size(), "TRACE shows metadata entry/exit, got: " + messages());
    }

    @Test
    void objectMethodsPassThroughWithoutLogging() {
        Greeter real = new Greeter() {
            public String greet(String name) { return "ok"; }
            public void boom(String reason) { }
            public String tier() { return "t"; }
            @Override public String toString() { return "the-real-greeter"; }
        };

        Greeter wrapped = Logged.wrap(Greeter.class, real);

        assertEquals("the-real-greeter", wrapped.toString());
        assertEquals(0, records.list.size(), "Object methods are not port calls");
    }
}
