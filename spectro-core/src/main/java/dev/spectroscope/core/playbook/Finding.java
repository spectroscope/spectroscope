package dev.spectroscope.core.playbook;

/**
 * One problem in a playbook file: the JSON path a person can go and look at,
 * and what is wrong there. The root of the file is the empty path.
 */
public record Finding(String path, String message) {}
