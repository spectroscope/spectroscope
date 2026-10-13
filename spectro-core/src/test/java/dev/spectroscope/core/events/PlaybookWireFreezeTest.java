package dev.spectroscope.core.events;

import org.junit.jupiter.api.Test;

import java.lang.reflect.RecordComponent;
import java.util.Arrays;
import java.util.List;

import static org.junit.jupiter.api.Assertions.assertEquals;

/**
 * Card 482: a playbook run writes its record into sidecars; the wire records it
 * touches stay as they are.
 *
 * <p>Card 554 (criterion 8f) moved the line on purpose and additively: a run
 * now tells the chat of its session that it started, which step runs on which
 * model and how it ended ({@code playbook_progress}), and the turn a step sends
 * into the chat says it came from the playbook ({@code run_start.origin}),
 * and the playbook a session picked is a line of its own
 * ({@code playbook_picked}, criterion 8e).
 * Both are written to the session file so a replay shows them. Every other
 * component stays frozen, and the lists below stay exact.</p>
 */
class PlaybookWireFreezeTest {

    private static List<String> components(Class<?> record) {
        return Arrays.stream(record.getRecordComponents()).map(RecordComponent::getName).toList();
    }

    @Test
    void thePermittedRecordsAreUnchanged() {
        List<String> permitted = Arrays.stream(RunEvent.class.getPermittedSubclasses()).map(Class::getSimpleName).toList();
        assertEquals(List.of("LlmExchange", "RunStart", "TurnStart", "TextDelta", "ThinkingDelta", "ToolCall",
                "PermissionRequest", "PermissionDecision", "ToolResult", "AgentSpawn", "Compaction", "VoiceInput",
                "Usage", "RunEnd", "ErrorEvent", "ImageGenerated", "ContextInfo", "WindowOverride", "AgentMessage",
                "Plan", "BrowserAction", "HookDecision", "ImagesWithheld", "QuestionAsked", "QuestionAnswered",
                "NoProgress", "ProgressIntervention", "Continuation", "GoalCheck", "SettingsIgnored",
                "LaunchOutcome", "SteeringMessage", "ContextCleared", "PlaybookProgress", "PlaybookPicked"), permitted);
    }

    @Test
    void theRecordsAPlaybookRunEmitsKeepTheirComponents() {
        assertEquals(List.of("runId", "agentId", "parentId", "prompt", "provider", "model", "trigger", "attachments",
                "workspace", "llmWire", "browserWire", "children", "contextWindow", "windowSource", "origin", "ts"),
                components(RunEvent.RunStart.class));
        assertEquals(List.of("agentId", "runId", "phase", "playbook", "task", "node", "name", "provider", "model",
                "stopReason", "result", "detail", "ts"), components(RunEvent.PlaybookProgress.class));
        // Card 554, integrator decision b: an explicit "No playbook" pick.
        assertEquals(List.of("dir", "name", "none", "ts"), components(RunEvent.PlaybookPicked.class));
        assertEquals(List.of("agentId", "steps", "ts"), components(RunEvent.Plan.class));
        assertEquals(List.of("text", "status"), components(RunEvent.PlanStep.class));
        assertEquals(List.of("from", "to", "role", "state", "text", "label", "ts"), components(RunEvent.AgentMessage.class));
        assertEquals(List.of("agentId", "callId", "questions", "ts"), components(RunEvent.QuestionAsked.class));
        assertEquals(List.of("callId", "answers", "cancelled", "waitMs", "ts"), components(RunEvent.QuestionAnswered.class));
        assertEquals(List.of("agentId", "callId", "name", "input", "decidedBy", "ts"), components(RunEvent.PermissionRequest.class));
    }
}
