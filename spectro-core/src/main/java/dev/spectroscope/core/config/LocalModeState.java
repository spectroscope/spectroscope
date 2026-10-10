package dev.spectroscope.core.config;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.JsonNodeFactory;
import com.fasterxml.jackson.databind.node.MissingNode;

import java.util.ArrayList;
import java.util.Collection;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;

/**
 * Card 493: the Local mode switch of one chat, as a record of what it wrote.
 *
 * <p>Alternative A of {@code konzept/RUN-PROFILES.md}. Switching on writes the
 * preset of {@link LocalMode} for every knob the operator has not set by hand,
 * and holds every knob in the chat while the switch is on, so a settings file
 * the agent edits cannot move them. An edit in a row of the switch is a value
 * of the switch: it shows as changed, it is written where the preset was, and
 * it comes back the next time the switch goes on in this chat. Switching off
 * gives every knob back what the chat held before, and gives the local file
 * back what it held before for every key the switch wrote.</p>
 *
 * <p>The state decides and returns a {@link Plan}; the session applies it.
 * {@link MissingNode} in a plan means "nothing": in the session's half the
 * chat stops holding the key and reads it from the settings files again, in
 * the file's half the key is removed.</p>
 */
public final class LocalModeState {

    private static final JsonNode MISSING = MissingNode.getInstance();

    /** A switch that is off and has written nothing. */
    public LocalModeState() {
    }

    /**
     * What to apply.
     *
     * @param session key to the value the chat holds now; {@link MissingNode}
     *                releases the key to the settings files
     * @param file    key to the value the folder's local file holds now;
     *                {@link MissingNode} removes the key
     */
    public record Plan(Map<String, JsonNode> session, Map<String, JsonNode> file) {
    }

    /**
     * One row of the switch in the gear.
     *
     * @param key     the knob
     * @param value   the value the chat holds
     * @param preset  the value Local mode writes
     * @param changed whether the value differs from the preset
     * @param owned   whether the switch wrote the key (false for a key the
     *                operator had set by hand when it was switched on)
     */
    public record Row(String key, JsonNode value, JsonNode preset, boolean changed, boolean owned) {
    }

    /**
     * What to apply when the chat's folder changes while the switch is on.
     *
     * @param oldFile key to the value the folder the switch leaves holds now;
     *                {@link MissingNode} removes the key
     * @param plan    what to apply to the chat and to the new folder's file
     */
    public record Move(Map<String, JsonNode> oldFile, Plan plan) {
    }

    private boolean on;
    private final Set<String> owned = new LinkedHashSet<>();
    /** What the chat held for every knob when the switch went on. */
    private final Map<String, JsonNode> before = new LinkedHashMap<>();
    /** What the local file held for every knob and the record before the
     *  switch wrote anything there: what switching off gives it back. */
    private final Map<String, JsonNode> fileAtOn = new LinkedHashMap<>();
    /** What the local file held for every knob and the record when this
     *  session's switch arrived in the folder: what leaving it gives it back. */
    private final Map<String, JsonNode> fileFound = new LinkedHashMap<>();
    /** Values the operator set in the switch's rows, kept across off and on. */
    private final Map<String, JsonNode> edits = new LinkedHashMap<>();

    /**
     * Whether the switch is on.
     *
     * @return true while the switch is on
     */
    public synchronized boolean on() {
        return on;
    }

    /**
     * The keys the switch wrote.
     *
     * @return those keys, in the gear's order
     */
    public synchronized Set<String> owned() {
        return Collections.unmodifiableSet(new LinkedHashSet<>(owned));
    }

    /**
     * Switches on. A second call while on changes nothing.
     *
     * @param held      what the chat holds per knob now, {@link MissingNode}
     *                  where it reads the key from the settings files
     * @param effective the value in force per knob now
     * @param handSet   the knobs the operator set by hand, which the switch
     *                  leaves as they are
     * @param file      what the folder's local file holds per knob and for
     *                  {@link LocalMode#RECORD_KEY}, {@link MissingNode} where
     *                  it holds nothing or there is no folder
     * @return what to apply
     */
    public synchronized Plan switchOn(Map<String, JsonNode> held, Map<String, JsonNode> effective,
                                      Set<String> handSet, Map<String, JsonNode> file) {
        if (on) {
            return new Plan(Map.of(), Map.of());
        }
        on = true;
        owned.clear();
        before.clear();
        fileAtOn.clear();
        fileFound.clear();
        Map<String, JsonNode> session = new LinkedHashMap<>();
        Map<String, JsonNode> written = new LinkedHashMap<>();
        Map<String, JsonNode> preset = LocalMode.preset();
        for (String key : preset.keySet()) {
            before.put(key, held.getOrDefault(key, MISSING));
            fileAtOn.put(key, file.getOrDefault(key, MISSING));
            if (handSet.contains(key)) {
                session.put(key, LocalMode.canonical(key, effective.get(key)));
            } else {
                JsonNode value = edits.getOrDefault(key, preset.get(key));
                session.put(key, value);
                written.put(key, value);
                owned.add(key);
            }
        }
        fileAtOn.put(LocalMode.RECORD_KEY, file.getOrDefault(LocalMode.RECORD_KEY, MISSING));
        fileFound.putAll(fileAtOn);
        if (!owned.isEmpty()) {
            written.put(LocalMode.RECORD_KEY, record());
        }
        return new Plan(session, written);
    }

    /**
     * The chat's folder changes while the switch is on: the folder is pinned
     * after the switch went on, or another folder is picked before the first
     * prompt. The folder the switch leaves gets back what it held when the
     * switch arrived there, for every key the switch owns and for the record.
     * In the new folder the switch acts as if it went on there: a knob its
     * file holds by hand is left as it is and the chat holds the file's value;
     * every other knob the switch owns is written there with the value the
     * chat holds. A knob its file holds and its record names was written by
     * an earlier switch, not by hand. A knob the switch did not own stays as
     * the chat holds it.
     *
     * @param file what the new folder's local file holds per knob and for
     *             {@link LocalMode#RECORD_KEY}, {@link MissingNode} where it
     *             holds nothing
     * @return what to write into the old folder and what to apply
     * @throws IllegalStateException while the switch is off
     */
    public synchronized Move moveFolder(Map<String, JsonNode> file) {
        if (!on) {
            throw new IllegalStateException("Local mode is off; there is nothing to move");
        }
        Map<String, JsonNode> oldFile = new LinkedHashMap<>();
        for (String key : owned) {
            oldFile.put(key, fileFound.getOrDefault(key, MISSING));
        }
        oldFile.put(LocalMode.RECORD_KEY, fileFound.getOrDefault(LocalMode.RECORD_KEY, MISSING));

        Set<String> recorded = new LinkedHashSet<>();
        file.getOrDefault(LocalMode.RECORD_KEY, MISSING).forEach(name -> recorded.add(name.asText()));
        fileAtOn.clear();
        fileFound.clear();
        Map<String, JsonNode> session = new LinkedHashMap<>();
        Map<String, JsonNode> written = new LinkedHashMap<>();
        Map<String, JsonNode> preset = LocalMode.preset();
        for (String key : preset.keySet()) {
            JsonNode there = file.getOrDefault(key, MISSING);
            fileFound.put(key, there);
            boolean handSet = !there.isMissingNode() && !recorded.contains(key);
            fileAtOn.put(key, recorded.contains(key) ? MISSING : there);
            if (handSet) {
                owned.remove(key);
                session.put(key, LocalMode.canonical(key, there));
            } else if (owned.contains(key)) {
                written.put(key, edits.getOrDefault(key, preset.get(key)));
            }
        }
        JsonNode record = file.getOrDefault(LocalMode.RECORD_KEY, MISSING);
        fileFound.put(LocalMode.RECORD_KEY, record);
        fileAtOn.put(LocalMode.RECORD_KEY, recorded.isEmpty() ? record : MISSING);
        if (!owned.isEmpty()) {
            written.put(LocalMode.RECORD_KEY, record());
        }
        return new Move(oldFile, new Plan(session, written));
    }

    /**
     * Turns off a switch that was turned on by a folder's record and not used
     * in this session, when the chat moves to another folder. Writes nothing:
     * the record stays in the folder it was read from. The values read from
     * that folder do not come back on the next switch-on.
     *
     * @return what to apply: every knob back to what the chat held before
     */
    public synchronized Plan drop() {
        if (!on) {
            return new Plan(Map.of(), Map.of());
        }
        Map<String, JsonNode> session = new LinkedHashMap<>();
        for (String key : LocalMode.preset().keySet()) {
            session.put(key, before.getOrDefault(key, MISSING));
        }
        on = false;
        owned.clear();
        edits.clear();
        fileAtOn.clear();
        fileFound.clear();
        return new Plan(session, Map.of());
    }

    /**
     * An edit in one row of the switch. The caller has checked the value with
     * {@link LocalMode#refusal}.
     *
     * @param key   the knob
     * @param value the new value
     * @return what to apply
     * @throws IllegalStateException while the switch is off
     */
    public synchronized Plan edit(String key, JsonNode value) {
        if (!on) {
            throw new IllegalStateException("Local mode is off; switch it on to change its values");
        }
        JsonNode canonical = LocalMode.canonical(key, value);
        JsonNode preset = LocalMode.preset().get(key);
        if (canonical.equals(preset)) {
            edits.remove(key);
        } else {
            edits.put(key, canonical);
        }
        boolean newlyOwned = owned.add(key);
        Map<String, JsonNode> written = new LinkedHashMap<>();
        written.put(key, canonical);
        if (newlyOwned) {
            written.put(LocalMode.RECORD_KEY, record());
        }
        return new Plan(Map.of(key, canonical), written);
    }

    /**
     * Brings one row back to the preset.
     *
     * @param key the knob
     * @return what to apply
     * @throws IllegalStateException while the switch is off
     */
    public synchronized Plan reset(String key) {
        if (!on) {
            throw new IllegalStateException("Local mode is off; switch it on to change its values");
        }
        return edit(key, LocalMode.preset().get(key));
    }

    /**
     * Switches off. A call while off changes nothing.
     *
     * @return what to apply: every knob back to what the chat held before,
     *         every key the switch wrote back to what the file held before
     */
    public synchronized Plan switchOff() {
        if (!on) {
            return new Plan(Map.of(), Map.of());
        }
        Map<String, JsonNode> session = new LinkedHashMap<>();
        for (String key : LocalMode.preset().keySet()) {
            session.put(key, before.getOrDefault(key, MISSING));
        }
        Map<String, JsonNode> file = new LinkedHashMap<>();
        for (String key : owned) {
            file.put(key, fileAtOn.getOrDefault(key, MISSING));
        }
        file.put(LocalMode.RECORD_KEY, fileAtOn.getOrDefault(LocalMode.RECORD_KEY, MISSING));
        on = false;
        owned.clear();
        return new Plan(session, file);
    }

    /**
     * Turns the switch on from the record a folder's local file holds, the
     * way a session that starts in that folder finds it.
     *
     * @param record    the keys {@link LocalMode#RECORD_KEY} names
     * @param effective the value in force per knob, read from the files
     * @return what to apply: the chat holds every knob; the file is left as it is
     */
    public synchronized Plan adopt(Collection<String> record, Map<String, JsonNode> effective) {
        return adopt(record, effective, Map.of());
    }

    /**
     * {@link #adopt(Collection, Map)} with what the local file holds, so a
     * knob the operator set there by hand and edits later is given back.
     *
     * @param record    the keys {@link LocalMode#RECORD_KEY} names
     * @param effective the value in force per knob, read from the files
     * @param file      what the local file holds per knob
     * @return what to apply
     */
    public synchronized Plan adopt(Collection<String> record, Map<String, JsonNode> effective,
                                   Map<String, JsonNode> file) {
        on = true;
        owned.clear();
        before.clear();
        fileAtOn.clear();
        fileFound.clear();
        Map<String, JsonNode> preset = LocalMode.preset();
        Map<String, JsonNode> session = new LinkedHashMap<>();
        for (String key : preset.keySet()) {
            before.put(key, MISSING);
            fileFound.put(key, file.getOrDefault(key, MISSING));
            JsonNode value = LocalMode.canonical(key, effective.get(key));
            session.put(key, value);
            if (record.contains(key)) {
                owned.add(key);
                fileAtOn.put(key, MISSING);
                if (value.equals(preset.get(key))) {
                    edits.remove(key);
                } else {
                    edits.put(key, value);
                }
            } else {
                fileAtOn.put(key, file.getOrDefault(key, MISSING));
            }
        }
        fileAtOn.put(LocalMode.RECORD_KEY, MISSING);
        fileFound.put(LocalMode.RECORD_KEY, file.getOrDefault(LocalMode.RECORD_KEY, MISSING));
        return new Plan(session, Map.of());
    }

    /**
     * The rows of the switch, in the gear's order.
     *
     * @param effective the value the chat holds per knob
     * @return one row per knob
     */
    public synchronized List<Row> rows(Map<String, JsonNode> effective) {
        List<Row> rows = new ArrayList<>();
        LocalMode.preset().forEach((key, preset) -> {
            JsonNode value = LocalMode.canonical(key, effective.getOrDefault(key, MISSING));
            rows.add(new Row(key, value, preset, !preset.equals(value), owned.contains(key)));
        });
        return rows;
    }

    /** @return the record as the file holds it */
    private ArrayNode record() {
        ArrayNode list = JsonNodeFactory.instance.arrayNode();
        for (String key : LocalMode.preset().keySet()) {
            if (owned.contains(key)) {
                list.add(key);
            }
        }
        return list;
    }
}
