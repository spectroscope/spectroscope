package dev.spectroscope.server;

import dev.spectroscope.core.leveling.Ladder;
import dev.spectroscope.core.leveling.LevelingFold;
import dev.spectroscope.core.leveling.LevelingRecorder;
import dev.spectroscope.core.leveling.LevelingState;

import jakarta.servlet.http.HttpServletRequest;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;

import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RestController;

/**
 * The ladder over REST: read the state, report a visited surface, switch mode,
 * restart, and tick a criterion by hand.
 *
 * <p>Every endpoint wears the full local fence ({@link FleetController#isLocalOrigin}
 * plus the Origin check) and refuses with a blank 404, the house answer for
 * "not for you". The reads are fenced too, because the state names sessions
 * this operator has worked in.</p>
 *
 * <p>Nothing here enforces a level. The endpoints report state and record
 * evidence; whether a surface renders or shows a teaser is the client's
 * decision, so REST, CLI and MCP behave identically at level 0 and level 6.
 * That is deliberate: the moment the server started refusing work by level, an
 * observability tool would be withholding observability.</p>
 */
@RestController
public class LevelingController {

    private final LevelingRecorder recorder;

    /** Spring wiring — the server's shared recorder. */
    public LevelingController() {
        this(ServerLeveling.recorder());
    }

    /**
     * Seam constructor for tests.
     *
     * @param recorder the recorder to read and write
     */
    LevelingController(LevelingRecorder recorder) {
        this.recorder = recorder;
    }

    /** A surface a face just showed. @param surface the surface id @param sessionId the session on screen, optional */
    public record VisitBody(String surface, String sessionId) {}

    /** A mode switch. @param mode ladder, checklist or off */
    public record ModeBody(String mode) {}

    /** A hand tick. @param criterion the criterion id */
    public record TickBody(String criterion) {}

    /**
     * The ladder and this home's progress through it.
     *
     * @param request the servlet request, for the local-origin fence
     * @return ladder, mode, level, marks, remaining criteria and history; blank 404 when fenced out
     */
    @GetMapping("/api/leveling")
    public ResponseEntity<Map<String, Object>> state(HttpServletRequest request) {
        if (refused(request)) {
            return ResponseEntity.notFound().build();
        }
        return ResponseEntity.ok(describe());
    }

    /**
     * Reports that a surface was shown, which is how acts the event stream
     * cannot see reach the ladder.
     *
     * @param body the surface and the session it was shown for
     * @param request the servlet request, for the local-origin fence
     * @return the fresh state, or a blank 404 when fenced out
     */
    @PostMapping(value = "/api/leveling/visit", consumes = MediaType.APPLICATION_JSON_VALUE)
    public ResponseEntity<Map<String, Object>> visit(@RequestBody(required = false) VisitBody body,
                                                     HttpServletRequest request) {
        if (refused(request)) {
            return ResponseEntity.notFound().build();
        }
        if (body != null && body.surface() != null) {
            recorder.visit(body.surface(), blankToNull(body.sessionId()), System.currentTimeMillis());
        }
        return ResponseEntity.ok(describe());
    }

    /**
     * Switches how much of the ladder is doing work in this home.
     *
     * @param body the new mode
     * @param request the servlet request, for the local-origin fence
     * @return the fresh state, 400 for an unknown mode, or a blank 404 when fenced out
     */
    @PostMapping(value = "/api/leveling/mode", consumes = MediaType.APPLICATION_JSON_VALUE)
    public ResponseEntity<Map<String, Object>> mode(@RequestBody(required = false) ModeBody body,
                                                    HttpServletRequest request) {
        if (refused(request)) {
            return ResponseEntity.notFound().build();
        }
        String raw = body == null ? null : body.mode();
        LevelingState.Mode parsed = exactMode(raw);
        if (parsed == null) {
            return ResponseEntity.badRequest().body(Map.of("error", "unknown mode"));
        }
        recorder.mode(parsed);
        return ResponseEntity.ok(describe());
    }

    /**
     * Restarts the ladder from the dark frame, keeping the chosen mode.
     *
     * @param request the servlet request, for the local-origin fence
     * @return the fresh state, or a blank 404 when fenced out
     */
    @PostMapping(value = "/api/leveling/reset", consumes = MediaType.APPLICATION_JSON_VALUE)
    public ResponseEntity<Map<String, Object>> reset(HttpServletRequest request) {
        if (refused(request)) {
            return ResponseEntity.notFound().build();
        }
        recorder.reset();
        return ResponseEntity.ok(describe());
    }

    /**
     * Marks a criterion by hand. The receipt says so, forever.
     *
     * @param body the criterion to tick
     * @param request the servlet request, for the local-origin fence
     * @return the fresh state, or a blank 404 when fenced out
     */
    @PostMapping(value = "/api/leveling/tick", consumes = MediaType.APPLICATION_JSON_VALUE)
    public ResponseEntity<Map<String, Object>> tick(@RequestBody(required = false) TickBody body,
                                                    HttpServletRequest request) {
        if (refused(request)) {
            return ResponseEntity.notFound().build();
        }
        if (body != null && body.criterion() != null) {
            recorder.tick(body.criterion(), System.currentTimeMillis());
        }
        return ResponseEntity.ok(describe());
    }

    private static boolean refused(HttpServletRequest request) {
        return !FleetController.isLocalOrigin(request)
                || !FleetController.originIsLoopbackOrAbsent(request);
    }

    /** Strict on purpose: a typo becomes a 400, never a silent fallback to a different mode. */
    private static LevelingState.Mode exactMode(String raw) {
        if (raw == null) {
            return null;
        }
        for (LevelingState.Mode mode : LevelingState.Mode.values()) {
            if (mode.wire().equals(raw.trim().toLowerCase(Locale.ROOT))) {
                return mode;
            }
        }
        return null;
    }

    private static String blankToNull(String value) {
        return value == null || value.isBlank() ? null : value;
    }

    private Map<String, Object> describe() {
        Ladder ladder = recorder.ladder();
        LevelingState state = recorder.state();
        int level = state.level(ladder);

        Map<String, Object> answer = new LinkedHashMap<>();
        answer.put("mode", state.mode().wire());
        answer.put("level", level);
        answer.put("levelId", ladder.levels().get(level).id());
        answer.put("ladder", ladderShape(ladder));
        answer.put("marks", marks(state));
        answer.put("remaining", LevelingFold.remaining(ladder, state));
        answer.put("history", history(state));
        return answer;
    }

    private static Map<String, Object> ladderShape(Ladder ladder) {
        List<Map<String, Object>> levels = new ArrayList<>();
        for (Ladder.Level level : ladder.levels()) {
            Map<String, Object> shape = new LinkedHashMap<>();
            shape.put("index", level.index());
            shape.put("id", level.id());
            shape.put("nameKey", level.nameKey());
            shape.put("blurbKey", level.blurbKey());
            shape.put("opens", level.opens());
            shape.put("advanceWhen", level.advanceWhen());
            levels.add(shape);
        }
        List<Map<String, Object>> criteria = new ArrayList<>();
        for (Ladder.Criterion criterion : ladder.criteria()) {
            Map<String, Object> shape = new LinkedHashMap<>();
            shape.put("id", criterion.id());
            shape.put("level", criterion.level());
            shape.put("source", criterion.source().name().toLowerCase(Locale.ROOT));
            shape.put("surface", criterion.surface());
            shape.put("mastery", criterion.mastery());
            shape.put("labelKey", criterion.labelKey());
            shape.put("countsKey", criterion.countsKey());
            criteria.add(shape);
        }
        Map<String, Object> shape = new LinkedHashMap<>();
        shape.put("schemaVersion", ladder.schemaVersion());
        shape.put("levels", levels);
        shape.put("criteria", criteria);
        return shape;
    }

    private static Map<String, Object> marks(LevelingState state) {
        Map<String, Object> marks = new LinkedHashMap<>();
        state.marks().forEach((id, mark) -> {
            Map<String, Object> shape = new LinkedHashMap<>();
            shape.put("sessionId", mark.sessionId());
            shape.put("eventIndex", mark.eventIndex());
            shape.put("ts", mark.ts());
            shape.put("origin", mark.origin().wire());
            marks.put(id, shape);
        });
        return marks;
    }

    private static List<Map<String, Object>> history(LevelingState state) {
        List<Map<String, Object>> history = new ArrayList<>();
        for (LevelingState.LevelUp up : state.history()) {
            Map<String, Object> shape = new LinkedHashMap<>();
            shape.put("level", up.level());
            shape.put("ts", up.ts());
            history.add(shape);
        }
        return history;
    }
}
