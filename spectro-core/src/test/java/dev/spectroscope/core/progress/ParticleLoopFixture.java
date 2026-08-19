package dev.spectroscope.core.progress;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;

import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;

/**
 * The measured loop, replayable — card 262, criterion 1.
 *
 * <p><b>Where the shape came from, and what is NOT here.</b> On 2026-08-17 the
 * owner looked into his own project {@code ~/particle_Stephan_deepseek} while a
 * 1-bit-quantized local model worked in it, and measured:</p>
 * <ul>
 *   <li>{@code src/particleEngine.js} through {@code particleEngine31.js} —
 *       <b>31 files, ONE distinct content</b>
 *       ({@code md5 -q src/particleEngine*.js | sort -u | wc -l} → 1),
 *       <b>283 bytes each</b>, byte-identical;</li>
 *   <li>31 matching tests, each importing its own numbered copy, each carrying
 *       the same assertion the model itself labelled {@code // placeholder}:
 *       {@code stepParticle(p, 100, 5, 8, 0.016); assert.ok(Math.abs(p.x) > 99)}
 *       — a particle asked to cross 100 units in one 16 ms step, which the
 *       (perfectly reasonable) spring integrator cannot do;</li>
 *   <li>{@code node --test test/particleEngine31.test.js} → {@code ERR_ASSERTION}.</li>
 * </ul>
 *
 * <p>His directory is not copied into this repo and never will be. What is
 * reproduced here is the SEQUENCE — the tool calls and their inputs, in the
 * order the harness saw them — because that sequence is the entire input the
 * guard has. The bytes below are ours: a spring integrator written to be
 * exactly 283 characters long, so the sentence the guard says carries the
 * number the owner measured rather than a number this fixture invented.</p>
 *
 * <p>The assertion in {@link #TEST_TEMPLATE} really does fail against
 * {@link #ENGINE}: one 16 ms step moves the particle 0.18432 units, measured
 * under node while this fixture was written, so {@code Math.abs(p.x) > 99} is
 * false. The fixture reproduces an unsatisfiable test, not a test that merely
 * says it is one.</p>
 */
final class ParticleLoopFixture {

    private static final ObjectMapper JSON = new ObjectMapper();

    /** How many copies the model wrote before it broke out by itself. The
     *  guard's ceiling is measurable because of this number: the model needed
     *  31, the guard's job is to speak at three. */
    static final int COPIES = 31;

    /** The one distinct content, 283 characters — the size the owner measured.
     *  Held to that length by {@code ProgressGuardTest}, because a fixture whose
     *  number drifts turns the guard's own sentence into a fiction. */
    static final String ENGINE = """
            // spring toward the target, damped each step
            export function stepParticle(p, tx, ty, k, dt) {
              const ax = (tx - p.x) * k;
              const ay = (ty - p.y) * k;
              p.vx = (p.vx + ax * dt) * 0.9;
              p.vy = (p.vy + ay * dt) * 0.9;
              p.x = p.x + p.vx * dt;
              p.y = p.y + p.vy * dt;
              return p;
            }
            """;

    /** The test the model rewrote every round — identical but for the import,
     *  which is exactly why detector 1 must key on the CONTENT of the engine
     *  file and not on "the model keeps writing files". */
    private static final String TEST_TEMPLATE = """
            import { stepParticle } from "../src/%s";
            import assert from "node:assert";
            const p = { x: 0, y: 0, vx: 0, vy: 0 };
            // placeholder
            stepParticle(p, 100, 5, 8, 0.016);
            assert.ok(Math.abs(p.x) > 99);
            """;

    /**
     * One tool call as the harness saw it.
     *
     * @param tool   the tool name
     * @param input  the model-supplied input
     * @param failed whether the result came back as an error
     */
    record Call(String tool, JsonNode input, boolean failed) {}

    /** Static fixture — never instantiated. */
    private ParticleLoopFixture() {
    }

    /** The engine file's name for copy {@code n} — the first one carries no
     *  number, exactly as measured.
     *  @param n the copy number, 1-based
     *  @return e.g. {@code particleEngine.js}, {@code particleEngine2.js} */
    static String engineName(int n) {
        return n == 1 ? "particleEngine.js" : "particleEngine" + n + ".js";
    }

    /** The test file's name for copy {@code n}.
     *  @param n the copy number, 1-based
     *  @return e.g. {@code particleEngine3.test.js} */
    static String testName(int n) {
        return engineName(n).replace(".js", ".test.js");
    }

    /**
     * The whole hour, as calls: for every copy, the engine written with the same
     * bytes, its own numbered test written beside it, and the command that fails.
     *
     * @param copies how many rounds to replay
     * @return the calls in the order the harness saw them
     */
    static List<Call> replay(int copies) {
        List<Call> calls = new ArrayList<>();
        for (int n = 1; n <= copies; n++) {
            calls.add(new Call("write_file", write("src/" + engineName(n), ENGINE), false));
            calls.add(new Call("write_file",
                    write("test/" + testName(n), TEST_TEMPLATE.formatted(engineName(n))), false));
            calls.add(new Call("run_command",
                    JSON.createObjectNode()
                            .put("command", "node --test test/" + testName(n)),
                    true));
        }
        return calls;
    }

    /** A {@code write_file} input in the tool's own shape.
     *  @param path    the sandbox-relative path
     *  @param content the bytes going to it
     *  @return the input node */
    static JsonNode write(String path, String content) {
        return JSON.createObjectNode().put("path", path).put("content", content);
    }

    /** The engine content's length in bytes, for the pin that keeps this fixture
     *  honest about the owner's measurement.
     *  @return the byte length of {@link #ENGINE} */
    static int engineBytes() {
        return ENGINE.getBytes(StandardCharsets.UTF_8).length;
    }
}
