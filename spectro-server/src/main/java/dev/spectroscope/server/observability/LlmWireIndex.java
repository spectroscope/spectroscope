package dev.spectroscope.server.observability;

import com.fasterxml.jackson.core.JsonParser;
import com.fasterxml.jackson.core.JsonToken;
import com.fasterxml.jackson.core.exc.StreamConstraintsException;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;

import java.io.EOFException;
import java.io.IOException;
import java.io.InputStream;
import java.lang.invoke.MethodHandles;
import java.lang.invoke.VarHandle;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.nio.channels.FileChannel;
import java.nio.charset.StandardCharsets;
import java.nio.file.Path;
import java.nio.file.StandardOpenOption;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;

/**
 * The bodiless ledger of one llm-wire sidecar, read in one pass (card 434).
 *
 * <p>Each line is handed to a streaming parser as bytes. The parser keeps the
 * top-level fields an entry is built from, counts the elements of a
 * {@code lines} array and skips every other value, bodies and headers
 * included, so the bodies a call skips add nothing to what it allocates. The
 * exceptions are the lines the third and fourth rule below read again whole.
 * Up to 0.13.0 the index read each line into a String and a full Jackson
 * tree; its answers are the contract, and {@code LlmWireIndexTest} compares
 * the two.</p>
 *
 * <p>Four rules keep the answers equal where the old reader and a byte parser
 * would part:</p>
 * <ul>
 *   <li>A line ends at LF and at CR, as {@code BufferedReader.readLine} ends
 *       one. A CR LF pair leaves an empty line between the two, and an empty
 *       line carries no exchange here or there.</li>
 *   <li>A line that starts with a UTF-8 byte order mark, or whose first or
 *       second byte is NUL, is skipped: the old reader failed on it, while the
 *       byte parser would strip the mark or read the line as UTF-16 or
 *       UTF-32.</li>
 *   <li>A line longer than Jackson's string length limit is parsed again the
 *       old way, because only such a line can hold a string past the limit,
 *       and the old tree parse dropped a line with one while the byte parser
 *       skips strings without that check.</li>
 *   <li>A line on which the byte parser hits one of Jackson's stream limits
 *       is parsed again the old way too. Jackson counts a field name's length
 *       in UTF-8 bytes when it parses bytes and in characters when it parses
 *       a String, so a name of non-ASCII characters can fail the byte parser
 *       and pass the old tree parse.</li>
 * </ul>
 *
 * <p>One rule is new, the owner's call 1 at its default: a line with a byte
 * sequence the JDK's UTF-8 decoder refuses is skipped and the rest is indexed.
 * The old reader threw on it and the endpoint answered 404 for the whole
 * sidecar.</p>
 */
final class LlmWireIndex {

    private static final ObjectMapper JSON = new ObjectMapper();

    /** The top-level fields an entry is built from. {@code lines} is counted, not kept. */
    private static final Set<String> KEPT = Set.of("type", "xid", "agentId", "turn", "kind",
            "provider", "model", "transport", "url", "status", "bodyBytes", "fidelity", "ts",
            "aborted", "durationMs", "lineCount");

    /** What {@link #parse} answers for a line on which the byte parser hit one of Jackson's stream limits. */
    private static final Line PAST_A_LIMIT = new Line(null, -1);

    private LlmWireIndex() {
    }

    /**
     * The index of one sidecar: one object per exchange in request order, the
     * request and response lines paired by {@code xid}. Each object carries
     * exactly the {@code llm_exchange} frame's fields; a request still waiting
     * for its response reports {@code status} null.
     *
     * @param file the sidecar
     * @return the exchange metadata
     * @throws IOException when the file cannot be read
     */
    static List<Map<String, Object>> read(Path file) throws IOException {
        long longestString = JSON.getFactory().streamReadConstraints().getMaxStringLength();
        // Insertion-ordered by xid: entries appear in request order, and a
        // response landing later (parallel subagents interleave) finds its pair.
        Map<String, Map<String, Object>> entries = new LinkedHashMap<>();
        try (FileChannel channel = FileChannel.open(file, StandardOpenOption.READ)) {
            Lines lines = new Lines(channel);
            while (lines.next()) {
                Line line = parse(lines);
                lines.skipRest();
                if (line == null || !lines.validUtf8() || lines.byteAt(0) == 0 || lines.byteAt(1) == 0
                        || lines.startsWithBom()) {
                    continue;
                }
                if (line == PAST_A_LIMIT || lines.length() > longestString) {
                    line = parseWhole(channel, lines.start(), lines.length());
                    if (line == null) {
                        continue;
                    }
                }
                switch (line.fields().path("type").asText()) {
                    case "llm_request" -> entries.put(line.fields().path("xid").asText(), openEntry(line.fields()));
                    case "llm_response" -> {
                        Map<String, Object> entry = entries.get(line.fields().path("xid").asText());
                        if (entry != null) {
                            closeEntry(entry, line);
                        }
                    }
                    default -> { } // the truncation marker carries no exchange
                }
            }
        }
        return new ArrayList<>(entries.values());
    }

    /**
     * One line as its kept fields.
     *
     * @param fields the kept top-level fields, read into the nodes a full tree
     *               parse gives them
     * @param lines  how many elements the {@code lines} array holds, or -1 when
     *               the line has no {@code lines} array
     */
    private record Line(JsonNode fields, int lines) {
    }

    /**
     * Reads the kept fields of the line the stream serves.
     *
     * @param in one line's bytes
     * @return the line; {@link #PAST_A_LIMIT} when the parser hit one of
     *         Jackson's stream limits; or null when it is no JSON object or
     *         does not parse, a torn tail line (crash mid-write) among them
     */
    private static Line parse(InputStream in) {
        try (JsonParser p = JSON.getFactory().createParser(in)) {
            if (p.nextToken() != JsonToken.START_OBJECT) {
                return null; // a line that is no object carries no exchange
            }
            ObjectNode fields = JSON.createObjectNode();
            int lines = -1;
            JsonToken token;
            while ((token = p.nextToken()) == JsonToken.FIELD_NAME) {
                String name = p.currentName();
                JsonToken value = p.nextToken();
                if ("lines".equals(name)) {
                    lines = value == JsonToken.START_ARRAY ? countElements(p) : -1;
                    p.skipChildren();
                } else if (KEPT.contains(name)) {
                    fields.set(name, JSON.readTree(p));
                } else {
                    p.skipChildren();
                }
            }
            // Jackson 2.19 throws at the end of input inside an object, so the
            // loop ends on END_OBJECT; a parser that returned null instead would
            // otherwise have a torn line indexed.
            return token == JsonToken.END_OBJECT ? new Line(fields, lines) : null;
        } catch (StreamConstraintsException limit) {
            return PAST_A_LIMIT;
        } catch (IOException torn) {
            return null;
        }
    }

    /**
     * Counts an array's elements and skips each one.
     *
     * @param p a parser on the array's {@code START_ARRAY}
     * @return the element count; the parser is left on {@code END_ARRAY}
     * @throws IOException when the array does not parse
     */
    private static int countElements(JsonParser p) throws IOException {
        int count = 0;
        JsonToken token;
        while ((token = p.nextToken()) != JsonToken.END_ARRAY) {
            if (token == null) {
                // Jackson 2.19 throws here itself; a parser that returned null
                // would otherwise keep this loop counting forever.
                throw new EOFException("the array has no end");
            }
            p.skipChildren();
            count++;
        }
        return count;
    }

    /**
     * Parses one line the way the old index did: the whole line as a String,
     * then one tree. Used for a line longer than Jackson's string length
     * limit, where the tree parse can fail on a string the byte parser
     * skipped, and for a line on which the byte parser hit one of Jackson's
     * stream limits, where the tree parse can pass (a field name's length is
     * counted in characters here).
     *
     * @param channel the sidecar
     * @param start   the line's first byte
     * @param length  the line's length in bytes, without its terminator
     * @return the line, or null when the tree parse fails
     * @throws IOException when the file cannot be read
     */
    private static Line parseWhole(FileChannel channel, long start, long length) throws IOException {
        if (length > Integer.MAX_VALUE - 8) {
            return null; // no Java array holds the line, so no String can
        }
        ByteBuffer bytes = ByteBuffer.allocate((int) length);
        while (bytes.hasRemaining()) {
            if (channel.read(bytes, start + bytes.position()) < 0) {
                throw new EOFException("the sidecar ended inside a line it had already read");
            }
        }
        JsonNode node;
        try {
            node = JSON.readTree(new String(bytes.array(), StandardCharsets.UTF_8));
        } catch (IOException refused) {
            return null;
        }
        JsonNode array = node.path("lines");
        return new Line(node, array.isArray() ? array.size() : -1);
    }

    /**
     * Starts an index entry from an {@code llm_request} line: the frame fields
     * the request half owns, response-half fields at their unanswered defaults
     * so every entry carries the full frame shape.
     *
     * @param node the request line's fields
     * @return the mutable entry the paired response completes
     */
    private static Map<String, Object> openEntry(JsonNode node) {
        Map<String, Object> entry = new LinkedHashMap<>();
        entry.put("xid", node.path("xid").asText());
        entry.put("agentId", textOrNull(node, "agentId"));
        entry.put("turn", node.hasNonNull("turn") ? node.get("turn").asInt() : null);
        entry.put("kind", textOrNull(node, "kind"));
        entry.put("provider", textOrNull(node, "provider"));
        entry.put("model", textOrNull(node, "model"));
        // The wire it used, so a reopened archive's rows describe themselves as
        // exactly as a live one does.
        entry.put("transport", textOrNull(node, "transport"));
        entry.put("url", textOrNull(node, "url"));
        entry.put("status", null);
        entry.put("requestBytes", node.path("bodyBytes").asLong(0));
        entry.put("responseBytes", 0L);
        entry.put("responseLines", 0);
        entry.put("aborted", false);
        entry.put("fidelity", textOrNull(node, "fidelity"));
        entry.put("durationMs", null);
        entry.put("ts", node.path("ts").asLong(0));
        return entry;
    }

    /**
     * Completes an entry from its {@code llm_response} line. The line count
     * comes from the lines array when the bodies still ride the file, from the
     * recorded {@code lineCount} when the ceiling dropped them.
     *
     * @param entry the entry its request line opened
     * @param line  the response line
     */
    private static void closeEntry(Map<String, Object> entry, Line line) {
        JsonNode node = line.fields();
        entry.put("status", node.hasNonNull("status") ? node.get("status").asInt() : null);
        entry.put("responseBytes", node.path("bodyBytes").asLong(0));
        entry.put("responseLines", line.lines() >= 0 ? line.lines() : node.path("lineCount").asInt(0));
        entry.put("aborted", node.path("aborted").asBoolean(false));
        entry.put("durationMs", node.hasNonNull("durationMs") ? node.get("durationMs").asLong() : null);
        entry.put("ts", node.path("ts").asLong(0));
    }

    /** A field's text, or null when absent; the index never invents "".
     *  @param node the line's fields
     *  @param field the field name
     *  @return the text value or null */
    private static String textOrNull(JsonNode node, String field) {
        return node.hasNonNull(field) ? node.get(field).asText() : null;
    }

    /**
     * The sidecar's lines, one at a time, each served as the bytes of this
     * stream until its terminator. While it serves and skips bytes it checks
     * them against the UTF-8 forms the JDK's decoder accepts, so a line the
     * old reader refused can be recognised and skipped on its own. The file is
     * read in 64 KiB chunks; no line is ever held whole.
     */
    private static final class Lines extends InputStream {

        /** Eight bytes of the chunk as one long, byte 0 lowest. */
        private static final VarHandle LONGS =
                MethodHandles.byteArrayViewVarHandle(long[].class, ByteOrder.LITTLE_ENDIAN);

        private final FileChannel channel;
        private final byte[] buf = new byte[1 << 16];
        private final ByteBuffer window = ByteBuffer.wrap(buf);
        private final byte[] head = new byte[3];
        private final byte[] drain = new byte[1 << 13];
        private long bufStart;     // file offset of buf[0]
        private int pos;
        private int lim;
        private boolean eof;
        private boolean ended = true;
        private long lineStart;
        private long lineLength;
        private boolean valid;
        private int need;          // continuation bytes the current sequence still needs
        private int lo;            // the range the next continuation byte must lie in
        private int hi;

        Lines(FileChannel channel) {
            this.channel = channel;
        }

        /**
         * Moves to the next line, skipping what is left of the current one.
         *
         * @return false at the end of the file
         * @throws IOException when the file cannot be read
         */
        boolean next() throws IOException {
            skipRest();
            if (!fill()) {
                return false;
            }
            lineStart = bufStart + pos;
            lineLength = 0;
            ended = false;
            valid = true;
            need = 0;
            return true;
        }

        /**
         * Reads past the rest of the current line, checking its bytes.
         *
         * @throws IOException when the file cannot be read
         */
        void skipRest() throws IOException {
            while (read(drain, 0, drain.length) >= 0) {
                // the bytes are counted and checked by read
            }
        }

        /** @return whether every byte of the line forms a sequence the UTF-8 decoder accepts */
        boolean validUtf8() {
            return valid;
        }

        /** @param i 0, 1 or 2
         *  @return the line's byte at {@code i}, or -1 when the line is shorter */
        int byteAt(int i) {
            return i < lineLength ? head[i] & 0xFF : -1;
        }

        /** @return whether the line starts with the UTF-8 byte order mark EF BB BF */
        boolean startsWithBom() {
            return byteAt(0) == 0xEF && byteAt(1) == 0xBB && byteAt(2) == 0xBF;
        }

        /** @return the file offset of the line's first byte */
        long start() {
            return lineStart;
        }

        /** @return the line's length in bytes, without its terminator */
        long length() {
            return lineLength;
        }

        @Override
        public int read() throws IOException {
            byte[] one = new byte[1];
            return read(one, 0, 1) < 0 ? -1 : one[0] & 0xFF;
        }

        @Override
        public int read(byte[] b, int off, int len) throws IOException {
            if (ended) {
                return -1;
            }
            if (len == 0) {
                return 0;
            }
            if (!fill()) {
                end(); // the last line of a file may have no terminator
                return -1;
            }
            int stop = Math.min(lim, pos + len);
            int at = scan(pos, stop);
            int n = at - pos;
            System.arraycopy(buf, pos, b, off, n);
            count(pos, n);
            if (at < stop) {
                end();
                pos = at + 1;
                return n == 0 ? -1 : n;
            }
            pos = at;
            return n;
        }

        /** The parser closes its source; the file stays open for the next line. */
        @Override
        public void close() {
        }

        private boolean fill() throws IOException {
            if (pos < lim) {
                return true;
            }
            if (eof) {
                return false;
            }
            bufStart += lim;
            pos = 0;
            lim = 0;
            window.clear();
            int n = channel.read(window);
            if (n <= 0) {
                eof = true;
                return false;
            }
            lim = n;
            return true;
        }

        private void end() {
            ended = true;
            if (need != 0) {
                valid = false; // the line ends inside a sequence
            }
        }

        private void count(int from, int n) {
            for (int i = 0; lineLength + i < head.length && i < n; i++) {
                head[(int) lineLength + i] = buf[from + i];
            }
            lineLength += n;
        }

        /**
         * Checks bytes until the first line terminator. Eight bytes are
         * passed at once while no sequence is open and all eight are ASCII
         * and neither LF nor CR; every other byte goes through the UTF-8
         * state one at a time.
         *
         * @param from the first index to check
         * @param to   one past the last
         * @return the index of the first LF or CR, or {@code to}
         */
        private int scan(int from, int to) {
            byte[] b = buf;
            int need = this.need;
            int lo = this.lo;
            int hi = this.hi;
            boolean valid = this.valid;
            int i = from;
            while (i < to) {
                if (need == 0 && i + 8 <= to) {
                    long word = (long) LONGS.get(b, i);
                    long lf = word ^ 0x0A0A0A0A0A0A0A0AL;
                    long cr = word ^ 0x0D0D0D0D0D0D0D0DL;
                    // A byte of lf or cr is zero where the word holds LF or CR;
                    // (x - 0x01..) & ~x sets the high bit of some byte exactly
                    // when x has a zero byte. The word's own high bits mark
                    // non-ASCII bytes.
                    if (((word | ((lf - 0x0101010101010101L) & ~lf) | ((cr - 0x0101010101010101L) & ~cr))
                            & 0x8080808080808080L) == 0) {
                        i += 8;
                        continue;
                    }
                }
                int c = b[i];
                if (c >= 0) {
                    if (c == '\n' || c == '\r') {
                        break;
                    }
                    if (need != 0) {
                        valid = false;
                        need = 0;
                    }
                    i++;
                    continue;
                }
                c &= 0xFF;
                if (need != 0) {
                    if (c < lo || c > hi) {
                        valid = false;
                        need = 0;
                    } else {
                        need--;
                        lo = 0x80;
                        hi = 0xBF;
                    }
                } else if (c >= 0xC2 && c <= 0xDF) {
                    need = 1;
                    lo = 0x80;
                    hi = 0xBF;
                } else if (c >= 0xE0 && c <= 0xEF) {
                    // E0 needs A0..BF (no overlong form), ED needs 80..9F (no surrogate)
                    need = 2;
                    lo = c == 0xE0 ? 0xA0 : 0x80;
                    hi = c == 0xED ? 0x9F : 0xBF;
                } else if (c >= 0xF0 && c <= 0xF4) {
                    // F0 needs 90..BF (no overlong form), F4 needs 80..8F (nothing past U+10FFFF)
                    need = 3;
                    lo = c == 0xF0 ? 0x90 : 0x80;
                    hi = c == 0xF4 ? 0x8F : 0xBF;
                } else {
                    valid = false; // 80..C1 and F5..FF never start a sequence
                }
                i++;
            }
            this.need = need;
            this.lo = lo;
            this.hi = hi;
            this.valid = valid;
            return i;
        }
    }
}
