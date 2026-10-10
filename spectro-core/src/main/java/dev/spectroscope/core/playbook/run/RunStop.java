package dev.spectroscope.core.playbook.run;

/** The stop reasons a playbook run ends with; recorded in playbook_end. */
public final class RunStop {
    public static final String DONE = "done";
    public static final String ABORTED = "aborted";
    public static final String STEP_FAILED = "step_failed";
    public static final String MODEL_UNAVAILABLE = "model_unavailable";
    public static final String CHAT_SWITCH_REFUSED = "chat_switch_refused";
    public static final String PRIVACY_DECLINED = "privacy_declined";
    public static final String UNANSWERED = "unanswered";
    public static final String REVIEW_UNLABELLED = "review_unlabelled";
    public static final String NOD_REFUSED = "nod_refused";
    public static final String RECURSION_LIMIT = "recursion_limit";
    public static final String REFUSED = "refused";

    private RunStop() {
    }
}
