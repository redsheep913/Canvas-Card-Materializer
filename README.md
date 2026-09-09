# Canvas Card-Materializer

[![GitHub release](https://img.shields.io/github/v/release/redsheep913/Canvas-Card-Materializer)](https://github.com/redsheep913/Canvas-Card-Materializer/releases)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Obsidian minAppVersion](https://img.shields.io/badge/Obsidian-%E2%89%A51.4.0-7c3aed.svg)](https://obsidian.md)

Materialize Canvas cards into permanent, organized Markdown files — bringing Heptabase-style card-based note-taking to Obsidian, with every connection and color preserved.

## Features

- **Materialize** — right-click one or more selected text cards on a Canvas and choose *Materialize cards to files*. Each becomes a real `.md` file, replacing the card in place; layout and arrows stay untouched.
- **Structured metadata** — every materialized file records its Canvas origin in frontmatter (see table below), so connections stay queryable data instead of one-off text.
- **Native links** — `canvas_out`/`canvas_in` are plain `[[wikilinks]]`, so they show up in Obsidian's Graph view and backlinks like any other link.
- **Visual sync** — drag a materialized file back onto a Canvas and its saved `canvas_color` is restored automatically.
- **Safe by default** — filenames are deduplicated against your whole vault, not just the current batch, so materializing never silently overwrites an unrelated file with the same name.

## Frontmatter fields

| Field | Type | Meaning |
|---|---|---|
| `canvas_id` | string | The original Canvas node ID, used to identify files this plugin created |
| `canvas_color` | string | The card's color at materialize time (`"0"`–`"6"`, or a custom hex) |
| `canvas_out` | string[] | `[[wikilinks]]` to other materialized cards this one points to |
| `canvas_in` | string[] | `[[wikilinks]]` from other materialized cards that point to this one |

## How to use

1. Select one or more text cards on a Canvas.
2. Right-click → **Materialize cards to files**.
3. Files land in `<canvas's folder>/<canvas name>/`.
4. Open a materialized file's Properties panel to see `canvas_out` / `canvas_in` — click through like any other link.

## Installation

Open **Settings → Community Plugins → Browse**, search for **Canvas Card-Materializer**, and install.

