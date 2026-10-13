// The form state of the model picker under the composer (ProviderPicker.tsx):
// the provider in the select, the model in the field, and the model list the
// shared brain fetches for that provider (providerModelField.tsx).
//
// Card 556, fix round 1: under a stored session the preselection is the pair
// the record names, and it stays that pair until the owner picks. The live
// picker snaps a model an authoritative list does not carry to the list's
// first entry (autoPick); for a stored session that snap is off while the form
// still holds the recorded provider and model.

import { useEffect, useState } from "react";
import type { ModelFieldMode } from "./providerPickerMode";
import { useProviderModels } from "./providerModelField";

/** What the picker's popover reads and sets. */
export interface PickerForm {
  /** The provider in the select. */
  sel: string;
  /** The model in the field. */
  model: string;
  setModel: (model: string) => void;
  /** The owner picks a provider in the select; the model field empties. */
  chooseProvider: (provider: string) => void;
  models: string[];
  mode: ModelFieldMode;
}

/**
 * The picker's form.
 *
 * @param input.open           whether the popover is open; it seeds and fetches only then
 * @param input.provider       the chat's provider
 * @param input.activeModel    the chat's model
 * @param input.providerStatus per-provider onboarding status from /api/config
 * @param input.holdRecorded   a stored session's picker
 * @returns the form
 */
export function usePickerForm(input: {
  open: boolean;
  provider: string;
  activeModel: string | undefined;
  providerStatus?: Record<string, string>;
  holdRecorded: boolean;
}): PickerForm {
  const { open, provider, activeModel, providerStatus, holdRecorded } = input;
  const [sel, setSel] = useState(provider);
  const [model, setModel] = useState("");

  // Opening seeds the form from the active provider and the real current model.
  useEffect(() => {
    if (open) {
      setSel(provider);
      setModel(activeModel || "");
    }
  }, [open, provider, activeModel]);

  // Shared model list + field mode; autoPick snaps a stale local model, but
  // not a stored session's recorded pair before the owner picks.
  const holding = holdRecorded && sel === provider && model === (activeModel ?? "");
  const { models, mode } = useProviderModels(open ? sel : "", providerStatus, {
    model,
    onModelChange: setModel,
    autoPick: !holding,
  });

  const chooseProvider = (next: string): void => {
    setSel(next);
    setModel("");
  };

  return { sel, model, setModel, chooseProvider, models, mode };
}
