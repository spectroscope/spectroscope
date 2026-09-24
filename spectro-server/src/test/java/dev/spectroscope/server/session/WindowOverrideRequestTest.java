package dev.spectroscope.server.session;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.Test;

import java.util.List;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * Card 390, owner call 5 (default taken): what a person may set as the window
 * of a session is decided by the server. Whole tokens, from 8,000 to
 * 10,000,000. The web mirrors the two numbers, and
 * {@code spectro-web/src/wire/windowOverride.drift.test.ts} holds its copy to
 * the constants here.
 *
 * <p>The reverted first build accepted 1 (compaction on every turn), turned
 * 0.4 into a clear by rounding, and read values above 2^31 through
 * {@code asInt} (E6 in the review of 2026-09-24). Each of those has a row
 * below.</p>
 */
class WindowOverrideRequestTest {

    private static final ObjectMapper JSON = new ObjectMapper();

    private static WindowOverrideRequest.Parsed parse(String frame) throws Exception {
        return WindowOverrideRequest.parse(JSON.readTree(frame).path("tokens"));
    }

    @Test
    void aWholeNumberInsideTheRangeIsSet() throws Exception {
        assertThat(parse("{\"tokens\":512000}")).isEqualTo(new WindowOverrideRequest.Set(512_000));
        assertThat(parse("{\"tokens\":8000}"))
                .as("the floor itself is allowed")
                .isEqualTo(new WindowOverrideRequest.Set(8_000));
        assertThat(parse("{\"tokens\":10000000}"))
                .as("the ceiling itself is allowed")
                .isEqualTo(new WindowOverrideRequest.Set(10_000_000));
    }

    @Test
    void anAbsentOrNullValueClears() throws Exception {
        assertThat(parse("{\"tokens\":null}")).isEqualTo(new WindowOverrideRequest.Clear());
        assertThat(parse("{}")).isEqualTo(new WindowOverrideRequest.Clear());
    }

    @Test
    void everythingElseIsRefusedWithTheValueAndTheRangeNamed() throws Exception {
        // The value as it arrived, then the frame it arrived in.
        List<List<String>> refused = List.of(
                List.of("0", "{\"tokens\":0}"),
                List.of("1", "{\"tokens\":1}"),
                List.of("7999", "{\"tokens\":7999}"),
                List.of("10000001", "{\"tokens\":10000001}"),
                List.of("-512000", "{\"tokens\":-512000}"),
                List.of("4294967296", "{\"tokens\":4294967296}"),
                List.of("99999999999999999999999", "{\"tokens\":99999999999999999999999}"),
                List.of("0.4", "{\"tokens\":0.4}"),
                List.of("512000.5", "{\"tokens\":512000.5}"),
                List.of("\"512k\"", "{\"tokens\":\"512k\"}"),
                List.of("\"512000\"", "{\"tokens\":\"512000\"}"),
                List.of("true", "{\"tokens\":true}"),
                List.of("{\"n\":1}", "{\"tokens\":{\"n\":1}}"));
        for (List<String> row : refused) {
            WindowOverrideRequest.Parsed parsed = parse(row.get(1));
            assertThat(parsed).as(row.get(1)).isInstanceOf(WindowOverrideRequest.Refused.class);
            String message = ((WindowOverrideRequest.Refused) parsed).message();
            assertThat(message).as(row.get(1))
                    .contains(row.get(0))
                    .contains("8,000")
                    .contains("10,000,000");
        }
    }

    @Test
    void theRangeCheckIsTheOneTheRestoreUses() {
        assertThat(WindowOverrideRequest.inRange(8_000)).isTrue();
        assertThat(WindowOverrideRequest.inRange(10_000_000)).isTrue();
        assertThat(WindowOverrideRequest.inRange(512_000)).isTrue();
        assertThat(WindowOverrideRequest.inRange(7_999)).isFalse();
        assertThat(WindowOverrideRequest.inRange(10_000_001)).isFalse();
        assertThat(WindowOverrideRequest.inRange(0)).isFalse();
    }

    @Test
    void aVeryLongValueIsShortenedInTheMessage() throws Exception {
        String longString = "x".repeat(500);
        JsonNode frame = JSON.readTree("{\"tokens\":\"" + longString + "\"}");
        WindowOverrideRequest.Parsed parsed = WindowOverrideRequest.parse(frame.path("tokens"));
        assertThat(parsed).isInstanceOf(WindowOverrideRequest.Refused.class);
        assertThat(((WindowOverrideRequest.Refused) parsed).message())
                .as("the sentence names the value, it does not paste 500 characters of it")
                .hasSizeLessThan(200)
                .contains("xxxx");
    }
}
