package dev.spectroscope.core.events;

import org.junit.jupiter.api.Test;

import java.lang.reflect.RecordComponent;
import java.util.Arrays;
import java.util.List;

import static org.junit.jupiter.api.Assertions.assertEquals;

/** Card 482: a playbook run writes sidecars only; the wire records it touches stay as they are. */
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
                "LaunchOutcome", "SteeringMessage", "ContextCleared"), permitted);
    }

    @Test
    void theRecordsAPlaybookRunEmitsKeepTheirComponents() {
        assertEquals(List.of("runId", "agentId", "parentId", "prompt", "provider", "model", "trigger", "attachments",
                "workspace", "llmWire", "browserWire", "children", "ts"), components(RunEvent.RunStart.class));
        assertEquals(List.of("agentId", "steps", "ts"), components(RunEvent.Plan.class));
        assertEquals(List.of("text", "status"), components(RunEvent.PlanStep.class));
        assertEquals(List.of("from", "to", "role", "state", "text", "label", "ts"), components(RunEvent.AgentMessage.class));
        assertEquals(List.of("agentId", "callId", "questions", "ts"), components(RunEvent.QuestionAsked.class));
        assertEquals(List.of("callId", "answers", "cancelled", "waitMs", "ts"), components(RunEvent.QuestionAnswered.class));
        assertEquals(List.of("agentId", "callId", "name", "input", "decidedBy", "ts"), components(RunEvent.PermissionRequest.class));
    }
}
