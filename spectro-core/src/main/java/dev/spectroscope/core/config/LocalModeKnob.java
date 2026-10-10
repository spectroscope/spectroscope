package dev.spectroscope.core.config;

import java.lang.annotation.Documented;
import java.lang.annotation.ElementType;
import java.lang.annotation.Retention;
import java.lang.annotation.RetentionPolicy;
import java.lang.annotation.Target;

/**
 * Card 493: marks a {@link SpectroConfig} component as a knob of the Local
 * mode switch, a key the switch writes for one chat. {@link LocalMode#knobs()}
 * reads the list off the record, and {@code LocalModeKnobsDriftTest} requires
 * a preset value for every marked component.
 */
@Documented
@Retention(RetentionPolicy.RUNTIME)
@Target(ElementType.RECORD_COMPONENT)
public @interface LocalModeKnob {
}
