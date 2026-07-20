package dev.spectroscope.core.scheduler;

import org.junit.jupiter.api.Test;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;

/** Job validation: never trust the file. */
class JobTest {

    @Test
    void permissionsDefaultToReadonly() {
        Job job = new Job("j1", "* * * * *", "do it", "/tmp", null);
        assertEquals(Job.READONLY, job.permissions());
    }

    @Test
    void unknownPoliciesAreRejected() {
        assertThrows(IllegalArgumentException.class,
                () -> new Job("j1", "* * * * *", "do it", "/tmp", "yolo"));
    }

    @Test
    void missingFieldsFailLoudly() {
        assertThrows(IllegalArgumentException.class,
                () -> new Job(null, "* * * * *", "p", "/tmp", null));
        assertThrows(IllegalArgumentException.class,
                () -> new Job("j1", " ", "p", "/tmp", null));
        assertThrows(IllegalArgumentException.class,
                () -> new Job("j1", "* * * * *", "", "/tmp", null));
        assertThrows(IllegalArgumentException.class,
                () -> new Job("j1", "* * * * *", "p", null, null));
    }
}
