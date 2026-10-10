package dev.spectroscope.core.config.governing;

import dev.spectroscope.core.config.SpectroConfig;
import dev.spectroscope.core.session.CareParagraph;
import org.junit.jupiter.api.Test;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.util.ArrayList;
import java.util.List;
import java.util.Optional;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * Card 490: the default session count of a chat, three (the main agent and
 * two helpers, {@code konzept/RUN-PROFILES.md}), lives in one constant,
 * {@link SpectroConfig#DEFAULT_SESSIONS_PER_CHAT}.
 *
 * <p>Every other number that stands for it is an alias of that constant in
 * the source, so moving the constant moves them: the preset the Local mode
 * switch writes into the gear row ({@code LocalMode.PRESET_SESSIONS_PER_CHAT})
 * and the helpers the care paragraph names while the key is unset
 * ({@link CareParagraph#DEFAULT_HELPERS}). The reference rows of
 * {@code sessionsPerChat} and {@code careParagraph} name the same constant.</p>
 *
 * <p>The key itself ships unset, so a chat with the Local mode switch off
 * sends the v0.14.4 request (card 493, criterion 6). Where that leaves the
 * default is written on card 490.</p>
 */
class SessionCountDefaultDriftTest {

    private static final String SOURCE = "dev.spectroscope.core.config.SpectroConfig";
    private static final String FIELD = "DEFAULT_SESSIONS_PER_CHAT";
    private static final String GUIDE = "docs/guide-assets/parts/18-ref-config-build.html";

    /** The constants that stand for the default count, by owner and field. */
    private static final List<String> ALIASES = List.of(
            "dev.spectroscope.core.config.LocalMode#PRESET_SESSIONS_PER_CHAT",
            "dev.spectroscope.core.session.CareParagraph#DEFAULT_HELPERS");

    @Test
    void theDefaultIsOneSettableConstantAndEveryCopyIsAnAliasOfIt() throws IOException {
        List<GoverningNumber> scanned = GoverningScan.scan();
        GoverningNumber source = find(scanned, SOURCE + "#" + FIELD)
                .orElseThrow(() -> new AssertionError("premise: " + FIELD + " is in the tree"));
        assertEquals(Governs.Kind.SETTABLE, source.kind(),
                FIELD + " is the one settable default of the session count");
        assertEquals("sessionsPerChat", source.key());
        assertEquals("3", source.value(), "the owner's figure: the main agent and two helpers");

        List<String> wrong = new ArrayList<>();
        for (String alias : ALIASES) {
            Optional<GoverningNumber> found = find(scanned, alias);
            if (found.isEmpty()) {
                wrong.add(alias + " is not in the tree");
                continue;
            }
            GoverningNumber number = found.get();
            if (!number.expression().contains(FIELD)) {
                wrong.add(alias + " = " + number.expression() + " is a second copy of the default;"
                        + " derive it from SpectroConfig." + FIELD);
            }
            if (number.kind() != Governs.Kind.ALIAS) {
                wrong.add(alias + " is " + number.kind() + ", not ALIAS");
            }
        }
        for (GoverningNumber number : scanned) {
            String name = number.owner() + "#" + number.field();
            if (!name.equals(SOURCE + "#" + FIELD) && number.expression().contains(FIELD)
                    && !ALIASES.contains(name)) {
                wrong.add(name + " reads " + FIELD + " and is not in this test's list");
            }
        }
        assertTrue(wrong.isEmpty(), String.join("\n", wrong));
        assertEquals(SpectroConfig.DEFAULT_SESSIONS_PER_CHAT - 1, CareParagraph.DEFAULT_HELPERS,
                "the care paragraph names the default count minus the main agent");
    }

    @Test
    void theReferenceRowsNameTheDefaultCount() throws IOException {
        String count = "<code>" + SpectroConfig.DEFAULT_SESSIONS_PER_CHAT + "</code>";
        String sessions = row("sessionsPerChat");
        assertTrue(sessions.contains("The default count is " + count),
                "the sessionsPerChat row names the default count " + count + ":\n" + sessions);

        String care = row("careParagraph");
        assertTrue(care.contains("the count minus one"),
                "the careParagraph row derives the helpers from the count:\n" + care);
        assertTrue(care.contains("the default count of " + count),
                "the careParagraph row names the default count " + count
                        + " for an unset key:\n" + care);
        assertFalse(care.contains("two while the count is unset"),
                "the careParagraph row states the unset helpers as a second figure:\n" + care);
    }

    private static Optional<GoverningNumber> find(List<GoverningNumber> scanned, String name) {
        return scanned.stream()
                .filter(n -> (n.owner() + "#" + n.field()).equals(name))
                .findFirst();
    }

    private static String row(String key) throws IOException {
        String guide = Files.readString(GoverningScan.repoRoot().resolve(GUIDE), StandardCharsets.UTF_8);
        for (String line : guide.split("\n")) {
            if (line.contains("<td><code>" + key + "</code></td>")) {
                return line;
            }
        }
        throw new AssertionError("premise: " + GUIDE + " has a " + key + " row");
    }
}
