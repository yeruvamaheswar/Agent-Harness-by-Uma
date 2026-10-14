---
name: "Agentic Harness public pages: the project explainer"
description: A figure atlas in the Witnessed Notebook family. Nine numbered plates explain the project; the text is their caption.
colors:
  paper: "#F3F5F1"
  ink: "#1A1D1B"
  ink-2: "#4A524D"
  form: "#3D5A4C"
  rule: "#C3CEC6"
  rule-2: "#DDE4DF"
  agent: "#2B4C9B"
  claude: "#A84F2A"
  user: "#2C7038"
  pencil: "#646B67"
  tint: "color-mix(in srgb, #3D5A4C 7%, #F3F5F1)"
  chip: "color-mix(in srgb, #3D5A4C 10%, transparent)"
  paper-dark: "#121614"
  ink-dark: "#E5E9E6"
  ink-2-dark: "#A9B2AC"
  form-dark: "#9DB8A9"
  rule-dark: "#34403A"
  rule-2-dark: "#232B27"
  agent-dark: "#93AEF2"
  claude-dark: "#E79A73"
  user-dark: "#8ACB94"
  pencil-dark: "#9AA19C"
  tint-dark: "color-mix(in srgb, #9DB8A9 7%, #121614)"
  chip-dark: "color-mix(in srgb, #9DB8A9 10%, transparent)"
typography:
  display:
    fontFamily: "Archivo, 'Arial Narrow', 'Helvetica Neue', system-ui, sans-serif"
    fontSize: "clamp(2.2rem, 3.75vw, 3.4rem)"
    fontWeight: 660
    lineHeight: 1
    letterSpacing: "-0.01em"
    fontVariation: "'wdth' 76"
  headline:
    fontFamily: "Archivo, 'Arial Narrow', 'Helvetica Neue', system-ui, sans-serif"
    fontSize: "1.625rem"
    fontWeight: 650
    lineHeight: 1.15
    fontVariation: "'wdth' 80"
  title:
    fontFamily: "Archivo, 'Arial Narrow', 'Helvetica Neue', system-ui, sans-serif"
    fontSize: "1.2rem"
    fontWeight: 650
    fontVariation: "'wdth' 85"
  fact-lead:
    fontFamily: "Archivo, 'Arial Narrow', 'Helvetica Neue', system-ui, sans-serif"
    fontSize: "1.3rem"
    fontWeight: 650
    lineHeight: 1.15
    fontVariation: "'wdth' 80"
  band:
    fontFamily: "Archivo, 'Arial Narrow', 'Helvetica Neue', system-ui, sans-serif"
    fontSize: "0.95rem"
    fontWeight: 700
    letterSpacing: "0.06em"
    fontVariation: "'wdth' 80"
  label:
    fontFamily: "Archivo, 'Arial Narrow', 'Helvetica Neue', system-ui, sans-serif"
    fontSize: "0.72rem"
    fontWeight: 600
    lineHeight: 1.2
    letterSpacing: "0.09em"
    fontVariation: "'wdth' 82"
  lane:
    fontFamily: "Archivo, 'Arial Narrow', 'Helvetica Neue', system-ui, sans-serif"
    fontSize: "0.78rem"
    fontWeight: 650
    lineHeight: 1.2
    letterSpacing: "0.06em"
    fontVariation: "'wdth' 85"
  lead:
    fontFamily: "system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif"
    fontSize: "1.125rem"
    lineHeight: 1.45
  body:
    fontFamily: "system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif"
    fontSize: "16px"
    fontWeight: 400
    lineHeight: 1.6
    fontFeature: "'tnum'"
  caption:
    fontFamily: "system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif"
    fontSize: "0.97rem"
    lineHeight: 1.5
  body-dense:
    fontFamily: "system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif"
    fontSize: "0.9rem"
    lineHeight: 1.3
  facts:
    fontFamily: "system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif"
    fontSize: "0.875rem"
    lineHeight: 1.42
  note:
    fontFamily: "system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif"
    fontSize: "0.8rem"
    lineHeight: 1.45
  mono:
    fontFamily: "ui-monospace, 'SF Mono', Menlo, Consolas, monospace"
    fontSize: "0.86em"
    lineHeight: 1.5
  mono-block:
    fontFamily: "ui-monospace, 'SF Mono', Menlo, Consolas, monospace"
    fontSize: "0.84rem"
    lineHeight: 1.55
rounded:
  square: "0"
  hair: "2px"
  chip: "3px"
spacing:
  max-width: "90rem"
  page-x: "3rem"
  page-x-md: "1.5rem"
  page-x-sm: "1rem"
  rail: "14.75rem"
  frame-gap: "2.5rem"
  caption-col: "16.375rem"
  spread-gap: "2.25rem"
  section: "7rem"
  section-md: "5rem"
  measure: "44rem"
  facts-label: "4.6rem"
  control: "2.25rem"
  touch: "2.75rem"
components:
  top-bar:
    backgroundColor: "{colors.paper}"
    textColor: "{colors.ink-2}"
    rounded: "{rounded.square}"
    padding: ".3rem 0 .2rem"
    height: "2.75rem"
  rail-link:
    textColor: "{colors.ink-2}"
    typography: "{typography.body-dense}"
    padding: ".56rem 0 .62rem"
  rail-link-current:
    textColor: "{colors.form}"
  plate:
    backgroundColor: "{colors.paper}"
    textColor: "{colors.ink}"
    rounded: "{rounded.square}"
  control-strip:
    textColor: "{colors.ink-2}"
    typography: "{typography.note}"
    padding: ".65rem .9rem"
  node:
    backgroundColor: "{colors.paper}"
    textColor: "{colors.ink}"
    rounded: "{rounded.square}"
    padding: ".5rem .55rem"
    height: "3.5rem"
  node-hover:
    backgroundColor: "{colors.tint}"
  node-selected:
    backgroundColor: "{colors.tint}"
  node-unknown:
    backgroundColor: "{colors.paper}"
    textColor: "{colors.pencil}"
  button:
    backgroundColor: "{colors.paper}"
    textColor: "{colors.form}"
    typography: "{typography.label}"
    rounded: "{rounded.hair}"
    padding: ".55rem .75rem"
    height: "{spacing.control}"
  button-hover:
    backgroundColor: "{colors.tint}"
  button-active:
    backgroundColor: "{colors.form}"
    textColor: "{colors.paper}"
  button-disabled:
    backgroundColor: "{colors.paper}"
    textColor: "{colors.pencil}"
  copy-button:
    backgroundColor: "{colors.paper}"
    textColor: "{colors.form}"
    typography: "{typography.label}"
    rounded: "{rounded.hair}"
    padding: ".4rem .55rem"
    height: "1.9rem"
  command-box:
    textColor: "{colors.ink}"
    typography: "{typography.mono-block}"
    rounded: "{rounded.square}"
    padding: ".6rem 4.6rem .6rem .7rem"
  facts-form:
    textColor: "{colors.ink}"
    typography: "{typography.facts}"
    padding: ".7rem 0 0"
  table-head:
    textColor: "{colors.form}"
    typography: "{typography.label}"
    padding: ".6rem .6rem .65rem"
  table-row-selected:
    backgroundColor: "{colors.tint}"
  code-chip:
    backgroundColor: "{colors.chip}"
    typography: "{typography.mono}"
    rounded: "{rounded.chip}"
    padding: ".06em .3em"
  unknown:
    textColor: "{colors.pencil}"
---

# Design System: Agentic Harness public pages (the project explainer)

Scope: public pages. Today that is one page, `docs/project-explainer.html`. It is one static file. Its tokens are CSS custom properties on `:root` with the same names as the keys above (`--paper`, `--form`, ...). The `-dark` keys are the dark values of the same property.

The plan-page system stays in `design/DESIGN.md` and `design/.impeccable/design.json`. This file does not replace it. The two systems share the colour tokens and the type roles. The shared values are equal in both files.

**Who decided what.**
- The owner, 2026-10-12: public pages are the same family as the plan pages, expanded.
- The owner, 2026-10-12: the structure of the explainer is the figure atlas.
- The owner, 2026-10-12: this surface has no margin rule.
- Every item marked "approved by the owner, 2026-10-13" below is new on this surface. It is recorded from the built page.

## Overview

**Creative North Star: "The Witnessed Notebook, as a figure atlas"**

The page is a book of plates. Nine numbered figures carry the explanation, and the text beside each figure is its caption. The reader selects a part of a figure, and a small form next to it states the facts for that part.

The paper is flat and cool. Rules and labels are printed in green-grey. Colour names who acts: green for the user, clay for Claude, cobalt for any other agent. Graphite pencil marks what is unknown, manual, or not built. Corners are square. There are no drop shadows.

**Key Characteristics:**
- A list of figures at the left is the contents.
- Each figure is a plate with a caption column.
- The figure number is part of the heading.
- Diagram lines are drawn from where the parts really are.
- One small square travels a line to show one rule in motion.
- Selected parts take a 7 percent form tint and an inset ring.
- Unknowns and manual steps are dashed.

## Colors

Low-chroma green-grey paper and form. Colour is kept for owners. Light and dark follow `prefers-color-scheme`. `data-theme` on `<html>` overrides the system setting, and a button in the top bar cycles auto, light, dark.

### Primary
- **Form Green-Grey** (`form`): labels, plate top rules, the facts-form top rule, section underlines, figure numbers, diagram lines and arrowheads, the travelling mark, links, the current row of the list of figures, button text and button borders.

### Secondary (owner inks)
- **User Green** (`user`): the border of nodes the user owns, the user lane, the marks in "You do by hand".
- **Claude Clay** (`claude`): the border of Claude nodes, the Claude lane, the dashed frame of the lock item.
- **Agent Cobalt** (`agent`): the border of every other agent's nodes and lanes. Also the focus ring, the caret, and text selection (24 percent mix).

### Neutral
- **Cool Paper** (`paper`): the page, and the fill behind every node, so lines pass behind parts.
- **Ink** (`ink`) / **Ink Two** (`ink-2`): text / secondary text (notes, sub-lines in nodes, line labels, the lead, the footer).
- **Graphite Pencil** (`pencil`): unknowns, test-session lines, disabled buttons, "not built" entries, limit notes.
- **Rule** (`rule`) / **Faint Rule** (`rule-2`): plate and pane borders / row separators.
- **Form Tint** (`tint`): form at 7 percent over paper. The fill of a hovered or selected part, and of a selected table row. Approved by the owner, 2026-10-13.
- **Code Chip** (`chip`): form at 10 percent. The fill behind inline code.

### Named Rules
**The Owner Ink Rule.** An owner ink marks who acts: node borders and lane labels. A node with no owner takes form green-grey. There are three owner inks and no fourth.

**The Pencil Rule.** What is unknown, not observed, or not built is written in pencil, in italics, with a dashed line or border.

**The No Margin Rule.** This surface has no margin rule. Margin pink-red is not a token here. (The owner, 2026-10-12.)

## Typography

**Display Font:** Archivo (Google Fonts, `wdth 62..125`, `wght 400..700`), with Arial Narrow, Helvetica Neue, system-ui fallback.
**Body Font:** system-ui stack.
**Label/Mono Font:** Archivo for labels; ui-monospace for code, paths, and digests.

**Character:** a condensed printed-form face over a plain reading sans. Width is set with `font-stretch`.

### Hierarchy
- **Display** (660, clamp 2.2rem to 3.4rem, line-height 1, width 76): the page title only. Approved by the owner, 2026-10-13.
- **Headline** (650, 1.625rem, line-height 1.15, width 80): each figure heading and each text-section heading. Size approved by the owner, 2026-10-13.
- **Title** (650, 1.2rem, width 85): the product name in the top bar.
- **Fact-lead** (650, 1.3rem, line-height 1.15, width 80): the first value of a facts form. It names the selected part. Approved by the owner, 2026-10-13.
- **Band** (700, 0.95rem, 0.06em, uppercase, width 80): sub-headings inside plates and text sections, in form.
- **Label** (600, 0.72rem, 0.09em, uppercase, width 82): form labels, table heads, figure numbers in the list of figures, button text, in form.
- **Lane** (650, 0.78rem, 0.06em, uppercase, width 85): owner lane names, in owner ink.
- **Lead** (1.125rem, line-height 1.45, ink-2): the one line under the title. Approved by the owner, 2026-10-13.
- **Body** (400, 16px, line-height 1.6): prose and lists. Measure 44rem.
- **Caption** (0.97rem, line-height 1.5): the text of the caption column.
- **Body-dense** (0.9rem): text inside plates. Sub-lines step down to 0.74 to 0.78rem in ink-2.
- **Facts** (0.875rem, line-height 1.42): facts-form rows.
- **Note** (0.8rem, line-height 1.45, ink-2): sources and limits under a figure.
- **Mono** (0.86em inline; 0.84rem, line-height 1.55 in command boxes): code.

### Named Rules
**The Folded Number Rule.** A figure heading reads "Fig. N." and then its title, in one heading. The number is in form green-grey. No label sits above a heading. Approved by the owner, 2026-10-13.

**The Form Label Rule.** A label names a form field or is the heading of its block. It is never stacked above a heading that already names the block.

**The Tabular Rule.** Figures stay tabular (`font-variant-numeric: tabular-nums` on body).

## Layout

- **Page:** max-width 90rem, centred. Side padding 3rem; 1.5rem at 900px and below; 1rem at 640px and below.
- **Top bar:** a thin bar on a 2px form top rule, 2.75rem high. Product name left; release, two links, and the theme button right.
- **Frame:** the list of figures (14.75rem, sticky) and the atlas, gap 2.5rem.
- **Title block:** display title, one lead line, then Fig. 1.
- **Spread:** each figure is a plate and a caption column (16.375rem), gap 2.25rem. The caption column holds the heading, a short text, the facts form, and a source note.
- **Order:** figures and text sections alternate. Text sections have no plate. Their heading sits on a 1px form underline.
- **Rhythm:** 7rem between sections; 5rem at 900px and below.
- **Breakpoints:** at 1180px and below, the caption stacks: heading, plate, body. At 900px and below, the list of figures becomes a sticky strip that scrolls sideways and keeps the current entry in view. At 640px and below, plates become one or two columns, tables stack, and touch targets are 2.75rem high.

The owner approved the layout above on 2026-10-13. The owner decided the structure (the figure atlas); the measures are from the build.

## Elevation & Depth

Flat. There are no drop shadows and no gradients. Depth comes from rules: a 2px form top rule opens the top bar, each plate, each facts form, and the footer. A 1px rule outlines plates and panes. Faint rules separate rows. Nodes take a paper fill so that lines pass behind them.

### Named Rules
**The Flat Paper Rule.** No drop shadows. A tint is a state, not a panel: form tint marks hover, selected, and the current table row. The only resting tint is the inline code chip.

**The Inset Ring Rule.** A selected part takes the form tint and an inset ring in its own border colour (1px or 1.5px, `box-shadow: inset`). The ring has no offset and no blur. Approved by the owner, 2026-10-13.

## Shapes

Square corners. The exceptions are 2px on buttons and the focus ring, 3px on inline code chips, and 1px on mark squares.

Marks are inline SVG at 1rem, drawn in `currentColor`:
- **Done:** filled square with a paper check, in form.
- **Open:** outlined square (stroke 1.5).
- **Fail:** outlined square with a cross. Approved by the owner, 2026-10-13.
- **Parked:** outlined square with two bars. Approved by the owner, 2026-10-13.
- **Unknown:** dashed circle with a question mark, in pencil.
- **Flag:** pennant on a staff.

**Diagram grammar** (approved by the owner, 2026-10-13):
- A node is a paper box with a 1.5px border in its owner ink, or in form when it has no owner.
- A line is 1.3px in form, with right-angle turns. A script measures the two parts and draws the line between them. It draws again on resize and when the font loads.
- An arrowhead is a filled triangle, 5px half-width, at the end of the line.
- A dashed form line (5 4) is a step that only the owner can do by hand.
- A dashed pencil line (5 4) is a test session or an unknown.
- A line label is 0.78rem in ink-2 on a paper patch. Labels are hidden when the plate is narrower than 560px.
- The line in use thickens to 2.4px.

## Components

Every component below is new on this surface unless it says "shared". The owner approved the new ones on 2026-10-13.

### Buttons
- **Shape:** 2px corners, 1px form border, paper fill, label type in form, 2.25rem high (2.75rem on a phone).
- **Hover:** form tint. **Active or pressed:** form fill with paper text.
- **Disabled:** pencil text and a dashed rule border.
- **Copy button:** the same button, smaller (1.9rem, 2.75rem on a phone), at the top right of a command box. It reads "Copy", then "Copied", or "Select it" when the copy fails. Shared idea; here its border is form and its weight is 600.

### Plate
- **Border:** 1px rule, with a 2px form top rule. Square. No fill.
- **Inside:** a stage for the figure, then an optional control strip on a 1px rule with buttons and one note.
- **Caption column:** heading with the folded number, a short text, a facts form, a source note.

### Diagram node
- **Rest:** paper fill, 1.5px owner-ink border, name at 0.95rem, sub-line in ink-2.
- **Hover:** form tint. **Selected:** form tint, inset ring, weight 650.
- **Unknown:** 1.3px dashed pencil border, pencil italic text.
- **Smaller relatives:** action chips, session moments, and run steps use a 1px border and the same tint and ring.
- **Keyboard:** Tab enters a figure once. Arrow keys, Home, and End move between its parts. The selected part holds the tab stop.

### Travelling mark
- One filled 9px square per plate, in form (pencil on a pencil line).
- It follows a line from start to end with an exponential ease-out (`1 - 2^(-9t)`), 380 to 640ms a hop. The facts form updates at each stop.
- Under reduced motion the mark does not travel. The line thickens, and the steps change in place with a longer pause.

### Facts form
- A two-column list on a 2px form top rule: label column 4.6rem in ink-2, value column in ink.
- The first value is fact-lead type. Rows with no value are left out.
- It is a live region, so a screen reader hears the change.

### Navigation: list of figures
- A label on a 1px form underline, then rows on faint rules. Each row has the figure number in label type (2.4rem column) and the name. Text sections have no number.
- **Current:** form, weight 650. **Hover:** ink.
- **Arrival:** a heading reached from the list shows a form tint (20 percent) that fades in 1.4s. No fade under reduced motion.
- **Phone:** a sticky strip on a 1px form bottom rule.

### Tables
- Head in label type on a 1px form rule; rows on faint rules; the selected row takes the form tint.
- **Stacked, at 640px and below:** the head is hidden. Each row becomes a block. Each cell shows its column name in label type in a 7.2rem column.
- A row name can be a text button with a rule-colour underline; pressed, it turns form.

### Command box
- 1px rule border, no fill, mono-block type, with the copy button at the top right.

### Other shared pieces
- **Code chip:** shared. Form 10 percent, 3px corners.
- **Unknown:** shared. Pencil italic. Here it has no dashed underline.
- **Limit note:** pencil italic text on a 1px dashed pencil top rule. It states a limit next to the claim it limits.
- **Focus:** shared. 2px agent outline, 2px offset.

### Motion
- State changes: background colour, 0.2 to 0.25s, `cubic-bezier(.16,1,.3,1)`.
- Nothing moves behind text. Reduced motion sets transitions to near zero and turns off smooth scroll.

## Do's and Don'ts

### Do:
- **Do** open every plate with a 2px form top rule and a 1px rule border.
- **Do** fold the figure number into the heading: "Fig. N." in form, then the title.
- **Do** colour a node border by its owner; use form when there is no owner.
- **Do** draw every diagram line from the measured position of its two parts.
- **Do** dash what is manual, and write what is unknown or not built in pencil.
- **Do** show selection with the form tint and an inset ring, and say it in `aria-pressed`.
- **Do** keep each plate to one travelling mark, and stop the travel under reduced motion.
- **Do** put a facts form next to each interactive figure.
- **Do** keep text at AA contrast on paper in both themes.

### Don't:
- **Don't** add a margin rule or margin pink-red to this surface.
- **Don't** add drop shadows, gradients, or rounded panels.
- **Don't** fill a resting panel with a tint; a tint means hover, selected, or current.
- **Don't** stack a label above a heading as a kicker.
- **Don't** add a fourth owner ink; any owner that is not Claude or the user is agent.
- **Don't** make content reachable by motion or hover alone.
