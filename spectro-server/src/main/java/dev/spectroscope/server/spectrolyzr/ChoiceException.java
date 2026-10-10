package dev.spectroscope.server.spectrolyzr;

/** A choice the manifest does not offer, or a name the rules refuse; {@link #field()} names the wizard field. */
public final class ChoiceException extends IllegalArgumentException {

    private final String field;

    public ChoiceException(String field, String message) {
        super(message);
        this.field = field;
    }

    public String field() {
        return field;
    }
}
