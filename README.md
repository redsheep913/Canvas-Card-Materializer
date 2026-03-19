# 🚀 Canvas Card-Materializer

> "Transform your fluid brainstorming into structured knowledge, instantly."

**Canvas Card-Materializer** is a powerful Obsidian plugin designed to bridge the gap between visual thinking on Canvas and long-term knowledge management. Inspired by the Heptabase workflow, it allows you to "materialize" temporary text cards into permanent, organized Markdown files while preserving every visual connection and color code.

---

## ✨ Key Features

* **Atomic Materialization**: Convert Canvas text nodes into physical `.md` files with a single click. The nodes on your Canvas will be replaced by the newly created files, keeping your layout intact.
* **Automatic Folder Hierarchy**: Categorize your notes automatically based on card colors.
    * *e.g., Yellow cards go to `/Yellow`, Grey cards go to `/Default`.*
* **Persistent Connections**: All arrows (Edges) are preserved. The plugin even appends a **`Connected Nodes:`** section to each file, listing all linked notes as clickable backlinks.
* **Smart Metadata**: Automatically records `canvas_id` and `canvas_color` in the YAML frontmatter.
* **Visual Sync**: When you drag a materialized Markdown file back onto the Canvas, the plugin automatically restores its original card color.
* **Clean Titles**: Automatically sanitizes filenames by removing Markdown headers (`#`), backticks (`` ` ``), and illegal characters.

---

## 🛠️ How to Use

1.  **Select Cards**: Select one or multiple text cards on your Canvas.
2.  **Right-Click**: Choose **"Materialize cards to files"** from the context menu (works for both single and multiple selections).
3.  **Organize**: Your notes are instantly created in a folder named after your Canvas, sub-categorized by color.
4.  **Connect**: View the bottom of your new notes to see the **`Connected Nodes:`** list.

---

## 📂 Folder Structure Example

If you materialize cards in a canvas named `Project-ASR.canvas`, the plugin creates:

```text
Documents/
└── Project-ASR/
    ├── Default/        <-- Grey cards
    │   └── Theory-Note.md
    ├── Yellow/         <-- Yellow cards (e.g., Problems)
    │   └── Bug-Analysis.md
    └── Green/          <-- Green cards (e.g., Tasks)
        └── Command-List.md
```

-----

## 🎨 Recommended Color Workflow

| Color | Role | Purpose |
| :--- | :--- | :--- |
| **Yellow** | Problem | Error codes, observations, current status. |
| **Grey** | Theory | Underlying mechanisms, abstract concepts. |
| **Green** | Action | Specific commands, configurations, checklists. |
| **Purple** | MOC | Indices, navigation, project overviews. |

-----

## ⚙️ Installation

1.  Open **Obsidian Settings** \> **Community Plugins**.
2.  Ensure **Restricted mode** is off.
3.  Click **Browse** and search for `Canvas Card-Materializer` (once it's officially listed).
4.  Alternatively, install manually via the [Releases](https://github.com/redsheep913/Canvas-Card-Materializer/releases) page.
