package dev.spectroscope.core;

import java.lang.annotation.Documented;
import java.lang.annotation.ElementType;
import java.lang.annotation.Retention;
import java.lang.annotation.RetentionPolicy;
import java.lang.annotation.Target;

/**
 * Card 504, hub and spoke review round 2: marks the test that pins one exit of
 * the goal's check that chapter 4 of the guide names. The value is the id of
 * that sentence in {@code GoalCheckGuideDriftTest}, which reads the marker, so
 * the tie between sentence and test is written on the test as well.
 */
@Documented
@Retention(RetentionPolicy.RUNTIME)
@Target(ElementType.METHOD)
public @interface GuideExit {

    /** @return the id of the guide's sentence this test pins */
    String value();
}
