package dev.spectroscope.server.session;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import dev.spectroscope.core.config.SpectroConfig;
import dev.spectroscope.core.events.RunEvent;
import dev.spectroscope.core.provider.LlmProvider;
import dev.spectroscope.core.provider.LlmProvider.PStop;
import dev.spectroscope.core.provider.LlmProvider.PTextDelta;
import dev.spectroscope.core.session.SessionStore;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.Timeout;
import org.junit.jupiter.api.io.TempDir;
import org.springframework.http.ResponseEntity;
import org.springframework.mock.web.MockHttpServletRequest;

import java.nio.file.Path;
import java.time.Duration;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicReference;
import java.util.function.Function;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * Card 445, criteria 4, 5 and 8 at the REST surface: the session list carries
 * title and pin, one PATCH changes them, the delete cascade takes them along,
 * and an old session can ask for a suggestion from its menu.
 *
 * <p>Sessions live in the test home the Gradle task points {@code user.home}
 * at; the meta store lives in this test's own folder.</p>
 */
@Timeout(value = 60, unit = TimeUnit.SECONDS, threadMode = Timeout.ThreadMode.SEPARATE_THREAD)
class SessionMetaEndpointTest {

    private static final ObjectMapper JSON = new ObjectMapper();

    @TempDir
    Path home;

    private final AtomicInteger modelCalls = new AtomicInteger();
    private final AtomicReference<SpectroConfig> builtFor = new AtomicReference<>();

    private SessionMetaStore meta() {
        return new SessionMetaStore(home.resolve("session-meta.json"));
    }

    private SessionsController controller(String answer) {
        Function<SpectroConfig, LlmProvider> providers = config -> {
            builtFor.set(config);
            return request -> {
                modelCalls.incrementAndGet();
                return List.of(new PTextDelta(answer), new PStop(PStop.StopReason.END_TURN));
            };
        };
        return new SessionsController(meta(), new SessionTitles(meta(), Duration.ofSeconds(5)), providers);
    }

    private SessionsController controller() {
        return controller("Release notes summary");
    }

    private static String storedSession(String prompt) {
        String id = "test-445-" + UUID.randomUUID().toString().substring(0, 8);
        SessionStore store = new SessionStore(id);
        store.append(new RunEvent.RunStart("r1", "main", null, prompt, "ollama", "qwen3",
                null, null, null, 1L));
        return id;
    }

    private static MockHttpServletRequest local() {
        return new MockHttpServletRequest();
    }

    private static JsonNode body(String json) throws Exception {
        return JSON.readTree(json);
    }

    private static SessionsController.SessionRow rowOf(SessionsController controller, String id) {
        return controller.sessions().stream()
                .filter(row -> row.info().id().equals(id))
                .findFirst()
                .orElseThrow();
    }

    @Test
    void aRenameShowsInTheListAndSurvivesARestart() throws Exception {
        String id = storedSession("hallo");
        ResponseEntity<Map<String, Object>> answer =
                controller().patchSession(id, body("{\"title\":\"Release 0.14.0\"}"), local());

        assertThat(answer.getStatusCode().value()).isEqualTo(200);
        assertThat(answer.getBody()).containsEntry("title", "Release 0.14.0")
                .containsEntry("titleSource", "manual").containsEntry("pinned", false);

        SessionsController.SessionRow row = rowOf(controller(), id);
        assertThat(row.title()).isEqualTo("Release 0.14.0");
        assertThat(row.titleSource()).isEqualTo("manual");
        assertThat(row.info().firstPrompt()).as("the first prompt stays as it was").isEqualTo("hallo");
    }

    @Test
    void theListRowStaysFlatJsonWithTheNewFieldsBesideTheOldOnes() throws Exception {
        String id = storedSession("hallo");
        controller().patchSession(id, body("{\"title\":\"Release 0.14.0\",\"pinned\":true}"), local());

        JsonNode row = JSON.valueToTree(rowOf(controller(), id));
        assertThat(row.path("id").asText()).isEqualTo(id);
        assertThat(row.path("firstPrompt").asText()).isEqualTo("hallo");
        assertThat(row.path("title").asText()).isEqualTo("Release 0.14.0");
        assertThat(row.path("titleSource").asText()).isEqualTo("manual");
        assertThat(row.path("pinned").asBoolean()).isTrue();
        assertThat(row.has("info")).as("the session fields are not nested").isFalse();
    }

    @Test
    void aRowWithoutMetaCarriesNoneOfTheNewFields() {
        String id = storedSession("hallo");
        JsonNode row = JSON.valueToTree(rowOf(controller(), id));
        assertThat(row.has("title")).isFalse();
        assertThat(row.has("titleSource")).isFalse();
        assertThat(row.has("pinned")).isFalse();
        assertThat(row.path("firstPrompt").asText()).isEqualTo("hallo");
    }

    @Test
    void pinAndUnpinShowInTheList() throws Exception {
        String id = storedSession("hallo");
        controller().patchSession(id, body("{\"pinned\":true}"), local());
        assertThat(rowOf(controller(), id).pinned()).isTrue();

        controller().patchSession(id, body("{\"pinned\":false}"), local());
        assertThat(rowOf(controller(), id).pinned()).isNull();
    }

    @Test
    void aBlankTitleFallsBackToTheSuggestion() throws Exception {
        String id = storedSession("hallo");
        meta().suggest(id, "Greeting the agent");
        controller().patchSession(id, body("{\"title\":\"Release 0.14.0\"}"), local());

        ResponseEntity<Map<String, Object>> answer =
                controller().patchSession(id, body("{\"title\":\"\"}"), local());
        assertThat(answer.getBody()).containsEntry("title", "Greeting the agent")
                .containsEntry("titleSource", "suggested");
    }

    @Test
    void aPatchIsRefusedForABadIdAnUnknownSessionAndABadBody() throws Exception {
        String id = storedSession("hallo");
        SessionsController controller = controller();

        assertThat(controller.patchSession("..%2Fdecoy", body("{\"pinned\":true}"), local())
                .getStatusCode().value()).isEqualTo(400);
        assertThat(controller.patchSession("test-445-nothere", body("{\"pinned\":true}"), local())
                .getStatusCode().value()).isEqualTo(404);
        assertThat(controller.patchSession(id, body("{}"), local()).getStatusCode().value()).isEqualTo(400);
        assertThat(controller.patchSession(id, null, local()).getStatusCode().value()).isEqualTo(400);
        assertThat(controller.patchSession(id, body("{\"title\":5}"), local()).getStatusCode().value())
                .isEqualTo(400);
        assertThat(controller.patchSession(id, body("{\"pinned\":\"yes\"}"), local()).getStatusCode().value())
                .isEqualTo(400);
        assertThat(meta().get(id)).as("nothing refused was written").isEmpty();
    }

    @Test
    void aPatchFromAForeignPageIsRefused() throws Exception {
        String id = storedSession("hallo");
        MockHttpServletRequest foreign = local();
        foreign.addHeader("Origin", "https://example.com");

        assertThat(controller().patchSession(id, body("{\"pinned\":true}"), foreign).getStatusCode().value())
                .isEqualTo(404);
        assertThat(meta().get(id)).isEmpty();
    }

    @Test
    void deletingASessionTakesItsTitleAndPinAlong() throws Exception {
        String id = storedSession("hallo");
        controller().patchSession(id, body("{\"title\":\"Release 0.14.0\",\"pinned\":true}"), local());
        assertThat(meta().get(id)).isPresent();

        assertThat(controller().deleteSession(id).getStatusCode().value()).isEqualTo(204);

        assertThat(meta().get(id)).isEmpty();
        assertThat(controller().sessions()).noneMatch(row -> row.info().id().equals(id));
    }

    @Test
    void deletingAnIdThatOnlyLeftMetaBehindRemovesIt() {
        meta().rename("test-445-orphan", "Left behind");
        assertThat(controller().deleteSession("test-445-orphan").getStatusCode().value()).isEqualTo(204);
        assertThat(meta().get("test-445-orphan")).isEmpty();
    }

    @Test
    void anOldSessionGetsASuggestionFromItsOwnProviderAndModel() {
        String id = storedSession("summarise the release notes");
        ResponseEntity<Map<String, Object>> answer = controller().suggestTitle(id, local());

        assertThat(answer.getStatusCode().value()).isEqualTo(200);
        assertThat(answer.getBody()).containsEntry("title", "Release notes summary")
                .containsEntry("titleSource", "suggested").containsEntry("suggested", true);
        assertThat(builtFor.get().provider()).isEqualTo("ollama");
        assertThat(builtFor.get().model()).isEqualTo("qwen3");
        assertThat(meta().get(id).orElseThrow().title()).isEqualTo("Release notes summary");
    }

    @Test
    void aSuggestionThatFailsChangesNothingAndIsNoError() {
        String id = storedSession("summarise the release notes");
        ResponseEntity<Map<String, Object>> answer = controller("   ").suggestTitle(id, local());

        assertThat(answer.getStatusCode().value()).isEqualTo(200);
        assertThat(answer.getBody()).containsEntry("suggested", false).doesNotContainKey("title");
        assertThat(meta().get(id)).isEmpty();
    }

    @Test
    void aSessionTheOperatorNamedIsNotSentToTheModel() throws Exception {
        String id = storedSession("summarise the release notes");
        controller().patchSession(id, body("{\"title\":\"Release 0.14.0\"}"), local());

        ResponseEntity<Map<String, Object>> answer = controller().suggestTitle(id, local());
        assertThat(answer.getBody()).containsEntry("title", "Release 0.14.0").containsEntry("suggested", false);
        assertThat(modelCalls.get()).isZero();
    }

    @Test
    void aSuggestionIsRefusedForABadIdAnUnknownSessionAndAForeignPage() {
        MockHttpServletRequest foreign = local();
        foreign.addHeader("Origin", "https://example.com");
        String id = storedSession("summarise the release notes");

        assertThat(controller().suggestTitle("..%2Fdecoy", local()).getStatusCode().value()).isEqualTo(400);
        assertThat(controller().suggestTitle("test-445-nothere", local()).getStatusCode().value()).isEqualTo(404);
        assertThat(controller().suggestTitle(id, foreign).getStatusCode().value()).isEqualTo(404);
        assertThat(modelCalls.get()).isZero();
    }
}
