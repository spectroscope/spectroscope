# Bundled fonts

Self-hosted brand typography (no runtime font CDN — spectroscope is
local-first). Both families are licensed under the SIL Open Font
License 1.1, which permits bundling and redistribution:

- `inter-latin-wght-normal.woff2` — Inter (variable, latin subset).
  Copyright 2016 The Inter Project Authors, https://github.com/rsms/inter
- `jetbrains-mono-latin-wght-normal.woff2` — JetBrains Mono (variable,
  latin subset). Copyright 2020 The JetBrains Mono Project Authors,
  https://github.com/JetBrains/JetBrainsMono

Files taken from the fontsource variable builds
(`@fontsource-variable/inter`, `@fontsource-variable/jetbrains-mono`).
The full license texts ship next to the fonts: [OFL-Inter.txt](OFL-Inter.txt)
and [OFL-JetBrainsMono.txt](OFL-JetBrainsMono.txt). The built server bundle
re-ships both fonts; see `spectro-server/src/main/resources/NOTICE.md`.
