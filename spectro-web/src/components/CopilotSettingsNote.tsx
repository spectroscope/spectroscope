// The settings page's note under the provider when Copilot is chosen (card
// 496): what it needs instead of a key, and the unit it is billed in. The same
// page serves learn and light, so the note is one component for both.

import { t, type Lang } from "../i18n/i18n";

export function CopilotSettingsNote({ lang }: { lang: Lang }) {
  return (
    <p className="settings-note copilot-settings-note">
      {t(lang, "set.copilotNote")} {t(lang, "set.copilotInstall")}
    </p>
  );
}
