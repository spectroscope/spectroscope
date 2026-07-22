// The fleet spawn role field. A node's role is FREE-FORM on the wire (NodeSpawner
// accepts [A-Za-z0-9][A-Za-z0-9._-]{0,63}, default "worker") — it is a card label
// and cluster key, not an enum. But only a handful of names render with a distinct
// colour (FleetSigil / FleetCanvas), so we surface those as a dropdown with a
// free-text "custom …" escape rather than a bare input. Same shape as ModelField.

import { useState } from "react";
import { useLang } from "../state/lang";

/** The roles that get a distinct colour / cluster tint on the canvas. Free-form
 *  roles still work; these are just the suggested, legible ones. */
export const KNOWN_ROLES = ["worker", "explore", "reviewer", "root"] as const;

const CUSTOM = "__custom__";

/** The select's option list. A seeded non-known role is prepended so the control
 *  can show reality; in custom-input mode only the known roles are listed (the
 *  text input carries the value). Mirrors ModelField's option logic. */
export function roleFieldOptions(role: string, custom: boolean): string[] {
  const known = (KNOWN_ROLES as readonly string[]).includes(role);
  return role !== "" && !custom && !known ? [role, ...KNOWN_ROLES] : [...KNOWN_ROLES];
}

/** A combobox for the node role: the known roles plus a "custom …" escape. */
export function RoleField(props: { role: string; onRoleChange: (r: string) => void }) {
  const de = useLang() === "de";
  const { role, onRoleChange } = props;
  const known = (KNOWN_ROLES as readonly string[]).includes(role);
  const [custom, setCustom] = useState(role !== "" && !known);

  return (
    <>
      <select
        className="fleet-spawn-role-select"
        value={custom ? CUSTOM : role}
        onChange={(e) => {
          if (e.target.value === CUSTOM) {
            setCustom(true);
            onRoleChange("");
          } else {
            setCustom(false);
            onRoleChange(e.target.value);
          }
        }}
      >
        {roleFieldOptions(role, custom).map((r) => (
          <option key={r} value={r}>
            {r}
          </option>
        ))}
        <option value={CUSTOM}>{de ? "eigene …" : "custom …"}</option>
      </select>
      {custom && (
        <input
          className="fleet-spawn-role-custom"
          type="text"
          autoFocus
          value={role}
          placeholder="worker"
          onChange={(e) => onRoleChange(e.target.value)}
        />
      )}
    </>
  );
}
