package dev.spectroscope.core.scheduler;

import com.fasterxml.jackson.databind.ObjectMapper;
import dev.spectroscope.core.config.SpectroConfig;
import dev.spectroscope.core.goal.RunGoal;
import dev.spectroscope.core.provider.LlmProvider;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.Timeout;
import org.junit.jupiter.api.io.TempDir;

import java.io.IOException;
import java.nio.file.Path;
import java.util.List;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.TimeUnit;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;

/**
 * Card 504, criterion 5: the unattended faces hold no goal. {@code spectro
 * run}, a cron fire and a fleet node build their agent in
 * {@link HeadlessRunner}, and the wiring is the fence: none of them passes a
 * goal, so a run with nobody watching is never continued by one
 * ({@code Agent.java}, card 266 owner call 1). A child holds none either
 * ({@code ChildGoalFenceTest}).
 */
@Timeout(value = 30, unit = TimeUnit.SECONDS, threadMode = Timeout.ThreadMode.SEPARATE_THREAD)
class GoalFenceTest {

    private static final ObjectMapper JSON = new ObjectMapper();

    private static LlmProvider answering(List<String> systems) {
        return request -> {
            systems.add(request.system());
            return List.of(new LlmProvider.PTextDelta("done"),
                    new LlmProvider.PStop(LlmProvider.PStop.StopReason.END_TURN));
        };
    }

    private static void assertNoGoal(HeadlessRunner runner, List<String> systems) {
        assertNotNull(runner.lastAgent(), "premise: the face built an agent");
        assertNull(runner.lastAgent().goal(), "an unattended face holds a goal");
        assertFalse(systems.isEmpty(), "premise: the run asked the model");
        systems.forEach(system -> assertFalse(system.contains(RunGoal.PROMPT_HEADING.strip()),
                "a goal section reached an unattended run: " + system));
    }

    @Test
    void aSpectroRunHoldsNoGoal(@TempDir Path cwd) throws IOException {
        List<String> systems = new CopyOnWriteArrayList<>();
        HeadlessRunner runner = new HeadlessRunner(JSON, SpectroConfig.load(SpectroConfig.Overrides.none(), cwd),
                answering(systems));
        HeadlessRunner.Outcome outcome = runner.runOnce("hello", cwd, false, null, event -> { }, line -> { });
        assertEquals("end_turn", outcome.stopReason());
        assertNoGoal(runner, systems);
    }

    @Test
    void aCronFireHoldsNoGoal(@TempDir Path cwd) throws IOException {
        List<String> systems = new CopyOnWriteArrayList<>();
        RecordingNotifier notes = new RecordingNotifier();
        HeadlessRunner runner = new HeadlessRunner(JSON, SpectroConfig.load(SpectroConfig.Overrides.none(), cwd),
                answering(systems)).withNotifier(notes);
        JobState state = runner.runJob(new Job("card-504-fence", "* * * * *", "hello", cwd.toString(),
                Job.READONLY), line -> { });
        // runJob runs on a copy of the runner (withOutsideReach), so the agent
        // is read where it lands: the requests carry no goal section.
        assertEquals("end_turn", state.stopReason());
        assertEquals(1, notes.shown().size(), "the job's end went to the recording notifier, not the desktop");
        assertFalse(systems.isEmpty(), "premise: the run asked the model");
        systems.forEach(system -> assertFalse(system.contains(RunGoal.PROMPT_HEADING.strip()),
                "a goal section reached a cron fire: " + system));
    }

    @Test
    void aFleetNodeHoldsNoGoal(@TempDir Path cwd) throws IOException {
        List<String> systems = new CopyOnWriteArrayList<>();
        HeadlessRunner runner = new HeadlessRunner(JSON, SpectroConfig.load(SpectroConfig.Overrides.none(), cwd),
                answering(systems)).withIdentity("node-a").withBroker(request -> true);
        runner.runOnce("hello", cwd, false, null, event -> { }, line -> { });
        assertNoGoal(runner, systems);
    }
}
