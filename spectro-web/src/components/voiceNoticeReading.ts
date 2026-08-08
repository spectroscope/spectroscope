// Card 187 step 7: what the first-run voice sheet SAYS, as pure logic.
//
// Named voiceNoticeReading, NOT voiceNotice: tsc refuses two files whose names
// differ only in casing, and VoiceNotice.tsx sits beside it. This is the same
// reason localNoticeFlag is named apart from LocalModelNotice — the comment
// there says so, and I walked into it anyway.
//
// Split from the sheet the way localNoticeFlag is split from LocalModelNotice —
// the suite runs in plain Node with no DOM, and the interesting part here is not
// the markup, it is which of several true sentences applies to THIS machine.
//
// The card's rule for the whole step: "Do not write the tutorial before 5.5 is
// decided. Every sentence in it is a promise about what the app can do for the
// reader." The hosted route made the promise true for a DMG user, so this reads
// the route first and never leads with what is missing when nothing is.

/**
 * The part of `/api/stt/status` this sheet reads — deliberately a subset.
 *
 * `SttSettings.tsx` declares the fuller shape (binaries, download progress,
 * paths) because the pane drives them. Every field here is optional so an older
 * server, which answers without `route` or `hosted`, degrades to the local
 * reading instead of throwing.
 */
export interface SttStatus {
  /** Which way a recording would go RIGHT NOW. */
  route?: "hosted" | "local" | null;
  /**
   * The configured preference. The stored values are `auto`, `local` and
   * **`openai`** — not `hosted`. `route` is what the server DECIDED; this is
   * what the reader ASKED for, and only the second tells us whether the route
   * was chosen or fell out of `auto`.
   */
  provider?: string | null;
  /** Whether the route being taken can actually run. */
  speechWorks?: boolean | null;
  /** The LOCAL route's readiness — binaries AND model. */
  ready?: boolean | null;
  /** The install line for the missing binary, or null when none is missing. */
  binaryHint?: string | null;
  model?: { present?: boolean | null; expectedBytes?: number | null } | null;
  hosted?: { keyPresent?: boolean | null; keyEnv?: string | null; model?: string | null } | null;
}

/** One line of the sheet: a fact, and whether it is settled or outstanding. */
export interface NoticeLine {
  /** i18n key. */
  key: string;
  /** Substitutions the sentence needs, already stringified. */
  value?: string;
  /** `true` when this line describes something already in place. */
  done: boolean;
}

export interface NoticeReading {
  /** The headline: does speech work on this machine right now. */
  works: boolean;
  /** Which route the headline is about. */
  route: "hosted" | "local";
  /** Whether the reader chose this route or it was chosen for them. */
  chosen: boolean;
  /** What is in place and what is not, in reading order. */
  lines: NoticeLine[];
}

/** Bytes as the sheet prints them — whole megabytes, which is the honest grain. */
export function megabytes(bytes: number): string {
  return `${Math.round(bytes / 1_000_000)} MB`;
}

/**
 * Read a status payload into the sentences the sheet shows.
 *
 * The route decides the whole reading. On the hosted route the local binaries
 * are not a shortcoming and are not mentioned: telling a DMG user to install
 * whisper when their voice already works is the "not on this machine" defect
 * the card's correction was written to kill, pointed the other way.
 *
 * @param status what `/api/stt/status` answered
 * @return the headline and the lines beneath it
 */
export function readNotice(status: SttStatus): NoticeReading {
  const route: "hosted" | "local" = status.route === "hosted" ? "hosted" : "local";
  // "openai", not "hosted": SttRoute.of reads the setting, and the setting
  // spells the hosted provider by name. Getting this wrong would report an
  // auto-derived route as a deliberate choice.
  const chosen = status.provider === "openai" || status.provider === "local";
  const lines: NoticeLine[] = [];

  if (route === "hosted") {
    const key = status.hosted?.keyPresent === true;
    lines.push({ key: "voice.notice.hosted.nothingToInstall", done: true });
    lines.push({
      key: key ? "voice.notice.hosted.keyThere" : "voice.notice.hosted.keyMissing",
      value: status.hosted?.keyEnv ?? undefined,
      done: key,
    });
    // Said plainly and never buried: this is the one line that differs in kind
    // from the local route, and a reader deciding between them needs it.
    lines.push({
      key: "voice.notice.hosted.leaves",
      value: status.hosted?.model ?? undefined,
      done: true,
    });
    return { works: status.speechWorks === true, route, chosen, lines };
  }

  const binariesOk = !status.binaryHint;
  lines.push({
    key: binariesOk ? "voice.notice.local.binaryThere" : "voice.notice.local.binaryMissing",
    value: status.binaryHint ?? undefined,
    done: binariesOk,
  });
  const modelOk = status.model?.present === true;
  lines.push({
    key: modelOk ? "voice.notice.local.modelThere" : "voice.notice.local.modelMissing",
    value: modelOk ? undefined : megabytes(status.model?.expectedBytes ?? 0),
    done: modelOk,
  });
  lines.push({ key: "voice.notice.local.staysHere", done: true });
  return { works: status.speechWorks === true, route, chosen, lines };
}

/**
 * Whether the sheet is worth opening for this reason, as opposed to a tooltip.
 *
 * The card: "a tooltip is right for a retryable event and wrong for 'this needs
 * setting up', which belongs in the sheet with the button that fixes it."
 *
 * `sttMissing` is the setup case, and it is also the one that today removes the
 * microphone button — so its tooltip goes with the button and the reader is
 * left with nothing at all. Everything else is either retryable in place
 * (`requestFailed`, `deviceBusy`, `convertFailed`) or about the browser rather
 * than the server (`denied`, `noDevice`), where the sentence beside the control
 * is the right size.
 *
 * @param reason what went wrong
 * @return true when the sheet should be shown instead of only a tooltip
 */
export function opensTheSheet(reason: string): boolean {
  return reason === "sttMissing";
}
