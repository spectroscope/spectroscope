# The skill catalogue

Four skill collections, vendored verbatim, carried inside every spectroscope
artifact and installed only when somebody asks for one.

| pack | skills | author | licence |
|---|---|---|---|
| `superpowers` | 14 | Jesse Vincent | MIT |
| `ui-ux-pro-max` | 7 | Next Level Builder | MIT |
| `matt-pocock` | 35 | Matt Pocock | MIT |
| `humanizer` | 1 | Siqi Chen | MIT |

Each pack keeps the upstream `LICENSE` beside it and a `PROVENANCE.json` naming
the repo, the exact commit vendored, and the date. **MIT permits the copy; what
it requires is that the notice and the licence text travel with it**, which is
what those two files are for. Remove either and the copy stops being licensed.

`ui-ux-pro-max/skills/ui-styling/canvas-fonts/` carries 24 typefaces, and a
font's licence is NOT covered by a repository's MIT statement. They ship with
their own SIL OFL notices, one per family, verbatim from upstream. That is the
one place in this tree where a second licence applies, and it is why the fonts
were checked rather than assumed.

## Why this is not `bundled-skills`

`.spectro/skills/` is seeded into `~/.spectro/skills` on first boot, and every
skill in that folder is appended to the agent's system prompt. Fifty-seven
foreign skills there would be in the context of every run this product ever
makes. So the catalogue is carried and not seeded: it is a shelf, and card 182's
install button is what takes something off it.

## Updating

`PROVENANCE.json` holds the commit each pack came from. Re-vendoring means
cloning at a newer commit, replacing the pack, and updating that file —
including the licence, which is re-read rather than assumed to be unchanged.
