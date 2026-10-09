package dev.spectroscope.server.session;

import dev.spectroscope.core.events.RunEvent;
import dev.spectroscope.core.session.SessionStore;
import dev.spectroscope.core.wire.BrowserWireRecorder;
import dev.spectroscope.core.wire.LlmWireRecorder;
import org.junit.jupiter.api.Test;
import org.springframework.http.ResponseEntity;
import org.springframework.mock.web.MockHttpServletRequest;
import org.springframework.web.servlet.mvc.method.annotation.StreamingResponseBody;

import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.zip.ZipEntry;
import java.util.zip.ZipInputStream;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * Card 473: the session export as a bundle. One zip that carries the session
 * file, its two wires and its child session files, each entry byte for byte
 * the file on disk, so the session travels to another machine with its
 * evidence.
 */
class SessionBundleTest {

    private final SessionsController controller = new SessionsController();

    private static MockHttpServletRequest local() {
        return new MockHttpServletRequest();
    }

    /** The streamed body, unzipped: entry name to bytes, in zip order. */
    private static Map<String, byte[]> unzip(ResponseEntity<StreamingResponseBody> res) throws IOException {
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        res.getBody().writeTo(out);
        Map<String, byte[]> entries = new LinkedHashMap<>();
        try (ZipInputStream zip = new ZipInputStream(new ByteArrayInputStream(out.toByteArray()))) {
            ZipEntry entry;
            while ((entry = zip.getNextEntry()) != null) {
                entries.put(entry.getName(), zip.readAllBytes());
            }
        }
        return entries;
    }

    /** A real session file written through the store, the way a run writes it. */
    private static SessionStore storedSession(RunEvent... events) {
        SessionStore store = new SessionStore();
        for (RunEvent event : events) {
            store.append(event);
        }
        return store;
    }

    private static void write(Path file, String text) throws IOException {
        Files.createDirectories(file.getParent());
        Files.writeString(file, text, StandardCharsets.UTF_8);
    }

    private static void cleanUp(String... ids) throws IOException {
        for (String id : ids) {
            Files.deleteIfExists(SessionStore.sessionFile(id));
            Files.deleteIfExists(LlmWireRecorder.fileFor(id));
            Files.deleteIfExists(BrowserWireRecorder.fileFor(id));
        }
    }

    @Test
    void theBundleCarriesTheSessionAndBothWiresByteForByte() throws IOException {
        SessionStore store = new SessionStore();
        String id = store.id();
        store.append(new RunEvent.RunStart("r1", "main", null, "hello", "anthropic", null, 2L)
                .withWires(id + ".llm.jsonl", id + ".browser.jsonl", List.of()));
        store.append(new RunEvent.RunEnd("r1", "end_turn", 3L));
        // Non-ASCII and a body with an escaped newline: bytes, not characters,
        // are what must come back.
        String llm = "{\"type\":\"llm_request\",\"xid\":\"00000000-0000-4000-8000-000000000001\","
                + "\"body\":\"grüße\\n\",\"ts\":2}\n"
                + "{\"type\":\"llm_response\",\"xid\":\"00000000-0000-4000-8000-000000000001\","
                + "\"status\":200,\"lines\":[\"data: {}\"],\"ts\":3}\n";
        String browser = "{\"type\":\"browser_call\",\"cid\":\"c1\",\"tool\":\"browser_navigate\",\"ts\":2}\n";
        write(LlmWireRecorder.fileFor(id), llm);
        write(BrowserWireRecorder.fileFor(id), browser);
        try {
            ResponseEntity<StreamingResponseBody> res = controller.exportBundle(id, local());
            assertThat(res.getStatusCode().value()).isEqualTo(200);
            assertThat(res.getHeaders().getFirst("Content-Disposition"))
                    .contains("attachment")
                    .contains(id + ".spectro.zip");
            assertThat(res.getHeaders().getContentType()).hasToString("application/zip");
            assertThat(res.getHeaders().getFirst("X-Content-Type-Options")).isEqualTo("nosniff");

            Map<String, byte[]> entries = unzip(res);
            assertThat(entries.keySet()).containsExactly(
                    id + ".jsonl", id + ".llm.jsonl", id + ".browser.jsonl");
            assertThat(entries.get(id + ".jsonl"))
                    .isEqualTo(Files.readAllBytes(SessionStore.sessionFile(id)));
            assertThat(entries.get(id + ".llm.jsonl"))
                    .isEqualTo(Files.readAllBytes(LlmWireRecorder.fileFor(id)));
            assertThat(entries.get(id + ".browser.jsonl"))
                    .isEqualTo(Files.readAllBytes(BrowserWireRecorder.fileFor(id)));
        } finally {
            cleanUp(id);
        }
    }

    @Test
    void anOldSessionWithoutAReferenceFindsItsWireByTheIdConvention() throws IOException {
        SessionStore store = storedSession(
                new RunEvent.RunStart("r1", "main", null, "old", "anthropic", null, 1L),
                new RunEvent.RunEnd("r1", "end_turn", 2L));
        String id = store.id();
        write(LlmWireRecorder.fileFor(id), "{\"type\":\"llm_request\",\"xid\":\"x\",\"ts\":1}\n");
        try {
            Map<String, byte[]> entries = unzip(controller.exportBundle(id, local()));
            assertThat(entries.keySet()).containsExactly(id + ".jsonl", id + ".llm.jsonl");
        } finally {
            cleanUp(id);
        }
    }

    @Test
    void aBrowserWireWrittenAfterTheReferenceStillRidesAlong() throws IOException {
        // The first run_start names no browser wire because none was written
        // yet; a page opened later writes one. The bundle carries what is on
        // disk, by the id convention for a wire the reference leaves unnamed.
        SessionStore store = new SessionStore();
        String id = store.id();
        store.append(new RunEvent.RunStart("r1", "main", null, "hello", "anthropic", null, 2L)
                .withWires(id + ".llm.jsonl", null, List.of()));
        write(BrowserWireRecorder.fileFor(id), "{\"type\":\"browser_call\",\"cid\":\"c1\",\"ts\":2}\n");
        try {
            Map<String, byte[]> entries = unzip(controller.exportBundle(id, local()));
            assertThat(entries.keySet()).containsExactly(id + ".jsonl", id + ".browser.jsonl");
        } finally {
            cleanUp(id);
        }
    }

    @Test
    void aChildRunStartNamesNothingForTheBundle() throws IOException {
        // Only the main agent's run_start carries the reference; a child line
        // with the fields (hand-edited, or from a future writer) is ignored.
        SessionStore child = storedSession(
                new RunEvent.RunStart("c", "main", null, "child", "anthropic", null, 1L));
        SessionStore store = new SessionStore();
        store.append(new RunEvent.RunStart("r1", "main", null, "hello", "anthropic", null, 2L)
                .withWires(null, null, List.of()));
        store.append(new RunEvent.RunStart("r2", "helper", "main", "sub", "anthropic", null, null, null, null, 3L)
                .withWires(null, null, List.of(child.id())));
        try {
            Map<String, byte[]> entries = unzip(controller.exportBundle(store.id(), local()));
            assertThat(entries.keySet()).containsExactly(store.id() + ".jsonl");
        } finally {
            cleanUp(store.id(), child.id());
        }
    }

    @Test
    void theReferencedChildSessionsRideAlongUnderChildren() throws IOException {
        SessionStore child = storedSession(
                new RunEvent.RunStart("c", "main", null, "child", "anthropic", null, 1L));
        SessionStore parent = new SessionStore();
        parent.append(new RunEvent.RunStart("r1", "main", null, "parent", "anthropic", null, 2L)
                .withWires(parent.id() + ".llm.jsonl", null, List.of(child.id(), "not-there-1")));
        try {
            Map<String, byte[]> entries = unzip(controller.exportBundle(parent.id(), local()));
            assertThat(entries.keySet()).containsExactly(
                    parent.id() + ".jsonl", "children/" + child.id() + ".jsonl");
            assertThat(entries.get("children/" + child.id() + ".jsonl"))
                    .isEqualTo(Files.readAllBytes(SessionStore.sessionFile(child.id())));
        } finally {
            cleanUp(parent.id(), child.id());
        }
    }

    @Test
    void aReferenceThatNamesAPathIsNeverFollowed() throws IOException {
        // A session file is caller-shaped: an imported or hand-edited line can
        // name anything. The bundle reads only the recorders' own folders.
        SessionStore secretHolder = storedSession(
                new RunEvent.RunStart("s", "main", null, "secret", "anthropic", null, 1L));
        SessionStore store = new SessionStore();
        store.append(new RunEvent.RunStart("r1", "main", null, "hello", "anthropic", null, 2L)
                .withWires("../sessions/" + secretHolder.id() + ".jsonl", "../../.ssh/id_rsa",
                        List.of("../" + secretHolder.id(), "a/b", "..")));
        try {
            Map<String, byte[]> entries = unzip(controller.exportBundle(store.id(), local()));
            assertThat(entries.keySet()).containsExactly(store.id() + ".jsonl");
        } finally {
            cleanUp(store.id(), secretHolder.id());
        }
    }

    @Test
    void refusesAPathShapedIdAndAForeignCaller() {
        for (String evil : new String[] {"../secrets", "..", "a/b", "a.jsonl", ""}) {
            assertThat(controller.exportBundle(evil, local()).getStatusCode().value())
                    .as("id \"" + evil + "\"").isEqualTo(404);
        }
        MockHttpServletRequest rebound = local();
        rebound.setServerName("attacker.example");
        assertThat(controller.exportBundle("20260725-120000-abcdef12", rebound).getStatusCode().value())
                .isEqualTo(404);
        assertThat(controller.exportBundle("20260725-000000-deadbeef", local()).getStatusCode().value())
                .as("a well-shaped id without a session").isEqualTo(404);
    }
}
