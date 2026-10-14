---
name: md-view plan page
description: One generated notebook page per <slug>.md, written by agents and witnessed by the owner.
colors:
  paper: "#F3F5F1"
  ink: "#1A1D1B"
  ink-2: "#4A524D"
  form: "#3D5A4C"
  rule: "#C3CEC6"
  rule-2: "#DDE4DF"
  margin: "#D9827A"
  agent: "#2B4C9B"
  claude: "#A84F2A"
  user: "#2C7038"
  pencil: "#646B67"
  paper-dark: "#121614"
  ink-dark: "#E5E9E6"
  ink-2-dark: "#A9B2AC"
  form-dark: "#9DB8A9"
  rule-dark: "#34403A"
  rule-2-dark: "#232B27"
  margin-dark: "#9A5048"
  agent-dark: "#93AEF2"
  claude-dark: "#E79A73"
  user-dark: "#8ACB94"
  pencil-dark: "#9AA19C"
typography:
  display:
    fontFamily: "Archivo, system-ui, sans-serif"
    fontSize: "1.35rem"
    fontWeight: 640
    lineHeight: 1.2
    fontVariation: "'wdth' 80"
  headline:
    fontFamily: "Archivo, system-ui, sans-serif"
    fontSize: "1.35rem"
    fontWeight: 650
    lineHeight: 1.25
    letterSpacing: "-0.005em"
    fontVariation: "'wdth' 80"
  title:
    fontFamily: "Archivo, system-ui, sans-serif"
    fontSize: "1.2rem"
    fontWeight: 650
    lineHeight: 1.25
    letterSpacing: "-0.005em"
    fontVariation: "'wdth' 85"
  body:
    fontFamily: "system-ui, -apple-system, Segoe UI, Roboto, sans-serif"
    fontSize: "16px"
    fontWeight: 400
    lineHeight: 1.6
    fontFeature: "'tnum'"
  body-dense:
    fontFamily: "system-ui, -apple-system, Segoe UI, Roboto, sans-serif"
    fontSize: "0.95rem"
    lineHeight: 1.45
    fontFeature: "'tnum'"
  note:
    fontFamily: "system-ui, -apple-system, Segoe UI, Roboto, sans-serif"
    fontSize: "0.8rem"
  band:
    fontFamily: "Archivo, system-ui, sans-serif"
    fontSize: "0.95rem"
    fontWeight: 700
    lineHeight: 1.2
    letterSpacing: "0.06em"
    fontVariation: "'wdth' 80"
  label:
    fontFamily: "Archivo, system-ui, sans-serif"
    fontSize: "0.72rem"
    fontWeight: 600
    lineHeight: 1.2
    letterSpacing: "0.09em"
    fontVariation: "'wdth' 82"
  lane:
    fontFamily: "Archivo, system-ui, sans-serif"
    fontSize: "0.78rem"
    fontWeight: 650
    lineHeight: 1.2
    letterSpacing: "0.06em"
    fontVariation: "'wdth' 85"
  mono:
    fontFamily: "ui-monospace, SF Mono, Menlo, Consolas, monospace"
    fontSize: "0.86rem"
    lineHeight: 1.55
rounded:
  square: "0"
  hair: "2px"
  chip: "3px"
spacing:
  gutter: "2.75rem"
  gutter-gap: "1.25rem"
  gutter-sm: "1.6rem"
  gutter-gap-sm: "0.8rem"
  page-x: "2rem"
  page-x-sm: "1rem"
  contents: "12.5rem"
  layout-gap: "2.25rem"
  label-col: "5.5rem"
  slice-card: "8.75rem"
  block: "2rem"
  section: "3rem"
  max-width: "80rem"
components:
  header-strip:
    backgroundColor: "{colors.paper}"
    textColor: "{colors.ink}"
    rounded: "{rounded.square}"
    padding: ".55rem 1rem .7rem"
  band:
    textColor: "{colors.form}"
    typography: "{typography.band}"
    padding: ".45rem 0 .35rem"
  slice-card:
    textColor: "{colors.ink}"
    typography: "{typography.note}"
    rounded: "{rounded.square}"
    padding: ".45rem .6rem .5rem"
    width: "{spacing.slice-card}"
  slice-card-done:
    backgroundColor: "color-mix(in srgb, #3D5A4C 7%, transparent)"
    textColor: "{colors.ink-2}"
  now-tag:
    typography: "{typography.label}"
    rounded: "{rounded.square}"
    padding: ".05rem .4rem"
  step-frame:
    backgroundColor: "{colors.paper}"
    textColor: "{colors.ink}"
    rounded: "{rounded.square}"
    padding: ".35rem .5rem .4rem"
  lane-label:
    textColor: "{colors.agent}"
    typography: "{typography.lane}"
    padding: ".3rem 0"
  ledger-row:
    textColor: "{colors.ink}"
    typography: "{typography.body-dense}"
    padding: ".6rem 0 .65rem"
  copy-button:
    backgroundColor: "{colors.paper}"
    textColor: "{colors.form}"
    typography: "{typography.label}"
    rounded: "{rounded.hair}"
    padding: ".35rem .55rem"
  code-chip:
    backgroundColor: "color-mix(in srgb, #3D5A4C 10%, transparent)"
    typography: "{typography.mono}"
    rounded: "{rounded.chip}"
    padding: ".06em .3em"
  unknown:
    textColor: "{colors.pencil}"
---

# Design System: md-view plan page

Source: `md-view.template.html`, the live template (promoted 2026-10-06 from `md-view.template.sample.html`; v1 backup `md-view.template.v1.html`). Plain CSS. Tokens are CSS custom properties on `:root` with the same names (`--paper`, `--form`, ...); `-dark` keys are the dark values of the same property.

## Overview

**Creative North Star: "The Witnessed Notebook"**

Each `.md` renders as one numbered notebook page. Agents write the entries; the owner witnesses them and signs off in chat. Flat cool paper, printed form rules and labels in green-grey, one pink-red margin rule, owner inks in the margin. Dense, single page, no tabs. The brief is one progress board: slice map, steps in order, then what is not yet confirmed.

**Key Characteristics:**
- A form header strip, then a contents column and one ruled sheet.
- A margin gutter that carries every status mark.
- One progress board: every task appears once, in one order.
- Three owner inks that answer "who owns it".
- Unknowns in graphite pencil.
- Tally strokes and tabular figures for progress.
- A condensed form face for labels and headings; system sans for reading.

## Colors

Low-chroma green-grey paper and form; color is reserved for owners and the one margin rule. Light and dark follow `prefers-color-scheme`; `data-theme` on `<html>` overrides.

### Primary
- **Form Green-Grey** (`form`): labels, band headings and their 2px rules, section underlines, step numbers, done marks and tally strokes, slice-map arrows, todo card borders, the loop wire.

### Owner inks
- **Agent Cobalt** (`agent`): any owner that is not Claude or user. Also focus ring, caret, selection (24% mix).
- **Claude Clay** (`claude`): Claude.
- **User Green** (`user`): the user.

### Tertiary
- **Margin Pink-Red** (`margin`): the margin rule and the section arrival ink (22% mix). Nothing else.

### Neutral
- **Cool Paper** (`paper`): page, and the fill behind step frames and the copy button.
- **Ink** (`ink`) / **Ink Two** (`ink-2`): text / secondary text (sources, counts, hints, step numbers, done steps, footer).
- **Graphite Pencil** (`pencil`): unknowns only.
- **Rule** (`rule`) / **Faint Rule** (`rule-2`): card and pane borders, dashed lane rules / row separators.

### Named Rules
**The One Margin Rule.** One 1.5px margin rule per sheet. Margin pink-red appears nowhere else except the arrival ink.

**The Owner Ink Rule.** Owner inks mark ownership only: gutter marks of open steps, the owner column, the owner line and border of the now card, lane labels, step frames. Done marks switch to form green-grey.

## Typography

**Display Font:** Archivo (Google Fonts, `wdth 62..125`, `wght 400..700`), with system-ui fallback.
**Body Font:** system-ui stack.
**Label/Mono Font:** Archivo for labels; ui-monospace for code and the page hash.

**Character:** a condensed printed-form face over a plain reading sans. Width is set with `font-stretch`.

### Hierarchy
- **Display**: the current step's text in "Steps, in order" only.
- **Headline**: section openers.
- **Title**: page title in the header strip.
- **Band**: uppercase board headings (Slice map, Steps, in order, Not yet confirmed) in form, with a note-size count or hint right.
- **Body**: prose and lists, measure 72ch. Tabular figures page-wide.
- **Body-dense**: step rows and unknown rows.
- **Note**: slice cards, sources, hints, footer, counts (0.72-0.85rem in ink-2).
- **Label**: uppercase form labels, form green-grey. Also every `###` heading, the card number, and the NOW tag.
- **Lane**: owner lane labels, in owner ink.

### Named Rules
**The Form Label Rule.** A label names a form field or is the heading itself. Never stack a label above a heading that already names the block.

**The Tabular Rule.** Figures stay tabular (`font-variant-numeric: tabular-nums` on body).

## Layout

- **Page:** max-width 80rem, centered, padding 1.75rem 2rem 3rem (1rem 1rem 2.5rem at ≤719px).
- **Frame:** header strip full width; below, contents (12.5rem, sticky at 1.25rem) and the sheet, gap 2.25rem.
- **Margin/gutter system:** the sheet reserves a gutter of `gutter` (2.75rem; `gutter-sm` at ≤719px). The margin rule sits at x = gutter, 1.5px wide. Content starts at gutter + `gutter-gap`. Marks are centered in the gutter; script aligns each to the middle of its entry's first line and re-runs on resize and font load.
- **Brief order:** the progress board (Slice map, Steps in order, Not yet confirmed), then the loop lanes, then the facts table (7rem label column).
- **One order:** done steps first, then open steps; numbers run on through the slice map and the stack. Task rows leave their sections; a section or `###` heading left empty is dropped.
- **Slice map:** a wrapping row of 8.75rem cards, gap .8rem 1.5rem, joined by 1px form arrows with a 5px head.
- **Label column:** 5.5rem in the loop lanes.
- **Steps grid:** step 1.6fr, owner 6.5rem, check 1fr, rollback 1fr; gap .2rem 1.25rem.
- **Rhythm:** sections 3rem apart; bands 1.75rem; loop and facts 2rem.
- **Breakpoints:** ≤1023px contents becomes a wrapping row. ≤719px the header becomes 3 columns (title first); the slice map runs two cards per row with no arrow after the second; step rows and facts stack with inline labels. ≤640px (script) lanes turn into columns with a vertical elbow wire.

## Elevation & Depth

Flat. No shadows anywhere. Depth comes from rules: a 2px form top rule opens the header strip, each band, and the loop; a 1px form underline opens each section; 1px rules outline cards and panes; faint rules separate rows. Step frames take a paper fill only to sit above the dashed lane rules and the wire.

### Named Rules
**The Flat Paper Rule.** No shadows and no tinted panels. The only tints are the inline code chip (form 10%), done slice cards (form 7%), and text selection (agent 24%).

## Shapes

Square corners everywhere. Exceptions: 2px on the focus ring and the copy button, 3px on inline code chips, 1px on mark squares. Marks are inline SVG, drawn in `currentColor`:
- **Open:** outlined square (11px, stroke 1.5), owner ink.
- **Done:** filled form square with a paper check.
- **Now:** pennant flag on a staff, owner ink, 20px (16px at ≤719px); other marks 16px (14px).
- **Unknown:** dashed circle with a question mark, pencil.
- **Tally:** four 10px strokes 3.6px apart and a diagonal fifth; 19px per group; stroke 1.3, round caps; done strokes form, open strokes ink-2 at 50%; capped at 40.

Slice-card state is carried by the border: done = 1px rule with form 7% fill and struck text; now = 2px solid owner ink; todo = 1px dashed form.

## Components

- **Header strip:** 1px form border with a 2px top. Cells divided by 1px rules: Kind, Title, Status, Dated, Entries done, Page (source hash in mono). Each cell is label over value.
- **Contents:** label, then rows divided by faint rules. The first row is Progress with `done/all` and a tally; section rows show the name only. The current row is bold in form. Click inks the target section's opener.
- **Band:** band-type heading on a 2px form top rule, count or hint right in note size.
- **Slice map:** numbered cards (number in label type, text clamped to 2 lines, owner line in owner ink) linked to their step row. The now card reads `N · now` in owner ink.
- **Steps, in order:** one numbered stack with a head row of labels (Step, Owner, Check, Rollback). Done rows in ink-2 and struck through. The current row's text is display type with a NOW tag (1px currentColor border, label type). Source section in note size when the page has more than one.
- **Not yet confirmed:** band with count, a one-line hint, then rows of pencil mark + text + source. Empty state: "No unknowns recorded."
- **Loop lanes:** a label row "Loop · who acts when"; one lane per owner (static label in lane type, owner ink; "has the next step" note under the owner of the current step). Dashed lane rules; step frames with 1px owner-ink border, "Step N" in form, name in ink; a 1px form elbow wire joins steps in order. Footer note: the loop restarts at step 1.
- **Facts table:** intro `Label: value` lines. Values with 3+ ` · ` parts become a 2-column list.
- **Split panes:** Always loaded / On demand side by side, 1px rule border.
- **Code block:** 1px rule border, no fill; copy button top right ("Copy" / "Copied").
- **Unknown:** pencil, italic, 1px dashed underline; also listed in Not yet confirmed. Unknowns outside step rows get a gutter mark.
- **Motion:** the now flag lands from -14px (.7s, `cubic-bezier(.16,1,.3,1)`, .15s delay) only under `prefers-reduced-motion: no-preference`. Section arrival ink fades margin 22% to clear over 1.4s, same curve.

## Do's and Don'ts

### Do:
- **Do** keep every status mark in the gutter, left of the one margin rule.
- **Do** use owner inks wherever an owner is named, and only there.
- **Do** write every `unknown` in pencil and list it in Not yet confirmed.
- **Do** open board blocks with a 2px form top rule; underline section openers with 1px form.
- **Do** show each task once, in the progress board, in one numbered order.
- **Do** keep text at AA contrast on paper in both themes.

### Don't:
- **Don't** put sections behind tabs or clicks.
- **Don't** add shadows, solid-filled cards, or rounded panels.
- **Don't** use margin pink-red for text, marks, or emphasis.
- **Don't** use a label as a kicker above a heading.
- **Don't** add a fourth owner ink; any non-Claude, non-user owner is agent.
