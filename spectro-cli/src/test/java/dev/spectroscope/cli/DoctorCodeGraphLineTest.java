package dev.spectroscope.cli;

import dev.spectroscope.core.tools.ToolPath;
import org.junit.jupiter.api.Test;

import java.util.List;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * Card 472: doctor says whether graphify, the program behind "Build code
 * graph", is on the tool PATH, and when it is not, how to install it and where
 * the lookup searched.
 */
class DoctorCodeGraphLineTest {

    private static final List<String> SEARCHED = List.of("/opt/homebrew/bin", "/usr/bin", "/bin");

    @Test
    void aMissingGraphifyIsANoteWithTheInstallLineAndTheFoldersSearched() {
        DoctorCommand.Line line = DoctorCommand.codeGraphLine(new ToolPath.Lookup("graphify", null, SEARCHED));

        assertEquals(DoctorCommand.Kind.INFO, line.kind(), "optional infrastructure is a note");
        assertTrue(line.message().startsWith("code graph: graphify missing"), line.message());
        assertTrue(line.message().contains("uv tool install graphifyy"), line.message());
        for (String folder : SEARCHED) {
            assertTrue(line.message().contains(folder), folder + " is not named: " + line.message());
        }
    }

    @Test
    void aFoundGraphifyPassesAndNamesWhereItIs() {
        DoctorCommand.Line line = DoctorCommand.codeGraphLine(
                new ToolPath.Lookup("graphify", "/opt/tools/graphify", SEARCHED));

        assertEquals(DoctorCommand.Kind.PASS, line.kind());
        assertEquals("code graph: graphify at /opt/tools/graphify (Build code graph)", line.message());
    }
}
