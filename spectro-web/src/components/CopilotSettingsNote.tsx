// The settings page's note under the provider when Copilot is chosen (card
// 496): what it needs instead of a key, and the unit it is billed in. The same
// page serves learn and light, so the note is one component for both. It
// decides itself whether to draw, so the page mounts it without a condition.

import { t, type Lang } from "../i18n/i18n";
import { COPILOT_INSTALL_LINE } from "./copilotAccount";

export function CopilotSettingsNote({ provider, lang }: { provider: string; lang: Lang }) {
  if (provider !== "copilot") return null;
  return (
    <p className="settings-note copilot-settings-note">
      {t(lang, "set.copilotNote")} {t(lang, "set.copilotInstall", { install: COPILOT_INSTALL_LINE })}
    </p>
  );
}
