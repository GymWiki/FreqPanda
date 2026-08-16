# Branding source assets

Source logo files, kept separate from `public/` and `src-tauri/icons/`
(the actual generated/derived assets used by the app) so the originals
are always available to regenerate from.

- `panda-logo-transparent.png` — used as the source for the full Tauri
  desktop-app icon set (`src-tauri/icons/`, via `npx tauri icon`).
- `panda-logo-bg.png` — used for the web favicon and anywhere a solid
  background is needed (e.g. a social-share image).
