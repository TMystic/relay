---
version: alpha
name: Relay
description: A shared desktop coding workbench with a visible team network.
colors:
  background: "#181818"
  editor: "#1e1e1e"
  surface: "#252526"
  surface-raised: "#333333"
  border: "#3c3c3c"
  text: "#cccccc"
  muted: "#a0a0a0"
  primary: "#007acc"
  success: "#89b482"
  danger: "#d99494"
  warning: "#cca76b"
  scroll-thumb: "#555555"
  scroll-track: "#252526"
  scroll-hover: "#666666"
  scroll-active: "#777777"
typography:
  sans:
    fontFamily: "Segoe UI, system-ui, sans-serif"
  mono:
    fontFamily: "Cascadia Code, Consolas, monospace"
rounded:
  DEFAULT: "3px"
  dialog: "5px"
spacing:
  panel-padding: "17px"
  workspace-padding: "25px"
components:
  button:
    rounded: "3px"
  dialog:
    rounded: "5px"
---

## Overview

Relay is a product surface for teams who want a fix to appear in everyone's editor before a Git commit. The visual reference is the restrained VS Code desktop workbench: the code occupies the center and the team occupies a persistent right channel. English is the initial language; no market-specific assumptions. Desktop is primary, browser is a testing and join companion. There is no marketing route.

The signature is the team network channel: presence above an attributed change timeline, each change opening an exact before/after review. Preserve familiar editor behavior rather than introduce decorative diagrams.

Runtime ownership: src/professional.css :root owns app color and radius tokens; src/style.css owns font stacks and the global scrollbar baseline. This file mirrors those values; change both together. Monaco's theme in src/main.js adapts editor/background, text, primary, warning, and muted colors to its external API. Desktop and browser load the identical compiled renderer.

## Colors

Neutral charcoal surfaces separate code, navigation, and collaboration. Muted blue is reserved for primary actions and focus; the cursor is gray. Restrained green means synchronized, amber means pending, and muted red means disconnected/removal. Labels accompany all status colors. Contributor colors identify people, not permissions. Forced-colors uses system outlines and scrollbars.

## Typography

Segoe UI controls and Cascadia Code source text use installed system fonts to avoid network font loading. Source defaults to 14px with 22px lines; user settings adjust font size and line height together. Dialog forms are 16px. Secondary file and activity metadata is 12px; uppercase captions are small secondary labels. Strong actor names support scanning.

## Layout

Desktop workbench has a 48px activity bar, 220px explorer, flexible code panel, and 280px collaboration panel. A 38px title bar and 36px workspace strip replace the large prototype header. Each panel owns its scroll. Below 850px the network moves below code; below 550px the active sidebar moves above the code. Dialogs remain bounded by the viewport. The desktop minimum width is 760px.

## Elevation & Depth

Use flat borders for persistent panels. Reserve restrained shadows for modal dialogs and temporary status messages. No backdrop blur or glow.

## Shapes

Rectangular editor panels; 3px controls, 5px dialogs, round contributor initials. Avoid ornamental cards in the editor.

## Components

Buttons use native button semantics, hover, pressed, disabled, and visible blue focus. Native HTML dialogs provide modality, Escape, inert background, and focus restoration. All dialogs have accessible labels. One notification owner provides brief live-region feedback. Persistent connectivity errors remain visible as a banner. File tabs are ordinary selection buttons with aria-pressed, not an incomplete ARIA tab widget. Monaco owns editor keyboard and accessibility behavior.

Global scrollbar tokens apply to every owned scroller, with engine fallbacks and system forced-color behavior. Reduced motion disables transitions. Time follows the viewer's browser locale and timezone, with exact timezone shown in change review. No simulated users or fabricated activity.

## Do's and Don'ts

- Keep source code immediately accessible after joining.
- Show actual connection and acknowledgment status.
- Do not imply unlimited team capacity or production security.
- Do not add dead terminal, Git, or run buttons.

## Relay tools and navigation

The activity bar owns Explorer, Search, Extensions, Settings, and a collaboration toggle. Search is local to the current room and has an explicit clear button. Quick navigation uses an accessible modal with file and command buttons, keyboard shortcuts, and empty states. Tools are reviewed bundled modules, installed per device using a whitelist; no arbitrary code is downloaded or executed. Minimap, word wrap, bracket guides, and JSON formatting are the first catalog entries. VS Code extension compatibility is explicitly unavailable. No terminal, debugging, Git, or marketplace action is presented as working.
