# Screenshots

Real captures of `docs/project-explainer.html`, made by `tools/explainer.ts capture` with headless Chrome. Nothing here is a mock-up. Rerun the command after the page changes; it rewrites the images and this file.

- Date: 2026-11-05
- Source page SHA-256: 89926fb3bbf66bd648e782b68aba7ca4d5ff3f167ce90d9555ec7add70909fbd
- Command:

```sh
node --experimental-strip-types tools/explainer.ts capture docs/project-explainer.html docs/assets/screenshots
```

| File | Size | Alt text |
|---|---|---|
| `explainer-desktop-light.png` | 1440 x 900 | The explainer at desktop width in light theme: the title "One rulebook for every AI coding agent", the list of figures in three parts, and Fig. 1, the whole system on one page. |
| `explainer-desktop-dark.png` | 1440 x 900 | The same desktop view in dark theme. |
| `explainer-phone-light.png` | 390 x 844 | The explainer on a phone-width screen in light theme: a compact top bar, the title, and the start of Fig. 1. |
| `explainer-skills-explorer.png` | Fig. 6 | Fig. 6, the skills explorer: the ten skills in five groups (Planning, Execution, Quality, Communication, Platform) with a status filter and a facts panel. |
| `explainer-orchestration.png` | Fig. 7 | Fig. 7, one plan and many agents: lanes for you, the Claude lead, Codex, a Claude reviewer and the ae engine, and an example sequence from plan to verify. |
| `explainer-unattended-run.png` | Fig. 9 | Fig. 9, an unattended run and its stops: preflight, charter, next batch, stop on deadline, cap or block, and the report, with what is advice, ask and refuse. |

The checks the page passes are run by `node --experimental-strip-types tools/explainer.ts check docs/project-explainer.html`: overflow, console errors, keyboard focus, reduced motion, WCAG AA contrast and links, at 360, 390, 768, 1024 and 1440 px, in light and dark.
