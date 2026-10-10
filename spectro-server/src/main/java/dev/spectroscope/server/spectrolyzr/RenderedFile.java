package dev.spectroscope.server.spectrolyzr;

/** One generated file: its root ({@code project} or {@code playbook}), its relative path, its text and its reason. */
public record RenderedFile(String root, String path, String content, Manifest.Text why) {}
