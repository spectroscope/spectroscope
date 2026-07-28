// The licence facts the About surface states, and the one number it may show.
//
// Every string here is a verbatim fragment of LICENSE or LICENSE-ASSETS.md at
// the repository root, and about.drift.test.ts reads those files to prove it.
// The wording is therefore not editable for tone: it is the grant this project
// makes to whoever reads it, and a smoother sentence is a different grant.
//
// The dual licence is genuinely two licences over two kinds of material, plus a
// third position that is not a licence at all — the marks are reserved, which
// is a trademark stance and belongs stated apart from the CC BY grant rather
// than folded into it.

/** The published repository — also the URL the CC BY attribution line names. */
const REPO = "https://github.com/spectroscope/spectroscope";

/** The author, as a person rather than as a copyright line. Owner's own link. */
const AUTHOR_URL = "https://www.linkedin.com/in/christopherezell/";

export const ABOUT = {
  repo: REPO,

  /** Carried by LICENSE and by LICENSE-ASSETS.md's closing line alike. */
  author: "Christopher Ezell",
  copyright: "Copyright (c) 2026 Christopher Ezell",

  /** MIT's standing obligation, in the assets file's own summary wording. */
  codeCondition: "the copyright notice travels with copies",
  authorUrl: AUTHOR_URL,
  codeLicenceUrl: `${REPO}/blob/main/LICENSE`,

  ccByUrl: "https://creativecommons.org/licenses/by/4.0/",
  assetsLicenceUrl: `${REPO}/blob/main/LICENSE-ASSETS.md`,

  /** The credit LICENSE-ASSETS.md accepts, as one line ready to paste. */
  attribution:
    "Image: spectroscope — Christopher Ezell, https://github.com/spectroscope/spectroscope, CC BY 4.0",

  /** Without this sentence the credit reads as etiquette. It is a term. */
  attributionIsAcondition: "Removing the attribution removes your license to use the material.",

  /** CC BY 4.0 makes three demands, not one. Section 3(a)(1)(B) makes marking a
   *  change a CONDITION of the licence, so a notice that names only credit
   *  grants adaptation on lighter terms than the grant it is quoting. */
  ccByConditions: [
    "Credit the source in a reasonable manner",
    "name what you changed if you changed it",
    "do not suggest the licensor endorses you",
  ],

  /** The marks' status: not a CC BY grant, and not open to being re-granted. */
  marksReserved: "all rights reserved",
  marksIdentify: "They identify this project.",

  /** The carve-out only works if a reader knows it reaches INSIDE the images
   *  they were just granted: a guide screenshot is CC BY and has the wordmark
   *  in its sidebar. Without this, the two rows read as disjoint sets. */
  marksWhereverTheyAppear:
    "the marks themselves, wherever they appear — on the banner, in the app, in screenshots",

  /** The fonts are the one licence here that is not ours to summarise away.
   *  Both families ride in this bundle; NOTICE.md carries the full terms. */
  fonts: [
    {
      name: "Inter",
      holder: "Copyright (c) 2016 The Inter Project Authors",
      url: "https://github.com/rsms/inter",
    },
    {
      name: "JetBrains Mono",
      holder: "Copyright 2020 The JetBrains Mono Project Authors",
      url: "https://github.com/JetBrains/JetBrainsMono",
    },
  ],
  fontsLicence: "SIL Open Font License 1.1",
} as const;

/**
 * The release version to print, or null to print none.
 *
 * The bundle cannot know its own version: package.json still reads 0.1.0, and
 * the same static assets are served by whichever server build contains them.
 * The server's own number is the only honest one, so this narrows an untrusted
 * JSON field and refuses everything else — an About that guesses a version is
 * worse than one that omits it.
 *
 * @param raw the `version` field as it arrived from the server, unvalidated
 * @return the trimmed version, or null when the server did not report a usable one
 */
export function releaseVersion(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const v = raw.trim();
  return v === "" ? null : v;
}
