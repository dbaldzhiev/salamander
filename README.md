# Salamander — VSODT Evacuation Time Calculator

A premium, dark-themed interactive node graph editor for modeling fire safety evacuation paths, built with vanilla HTML5 Canvas and JavaScript. Implements the Bulgarian Fire Safety Evacuation Norms (Ordinance Iz-1971, Annex 8a, DV бр. 91/2024).

## Features

- **Interactive Graph**: Create nodes, connect them, and drag them around.
- **Grid Snapping**: Nodes automatically snap to a 40px grid for clean layouts.
- **Pinning**: Pin nodes so the Order Graph solver keeps them fixed.
- **Node Types**:
  - **Start** (Green): User-definable people count.
  - **Secondary Start** (Teal): User-definable people count.
  - **Waypoint** (Orange): Auto-calculated people count.
  - **Exit** (Red): Auto-calculated people count.
  - **Default** (Blue): Standard node.
- **Connection Types**:
  - **Normal**: Solid blue line.
  - **Stairs Up**: Dashed purple line.
  - **Stairs Down**: Dashed orange line.
- **Advanced Connection Properties**:
  - **Direction**: Forward (→), Backward (←), or Bidirectional (↔).
  - **Congestion**: Visualize traffic jams with color coding (Green → Yellow → Orange → Red → Blocked).
  - **Desired Length**: Optional target length used by Order Graph.
  - **Distance**: Always matches geometric length; editing it moves graph geometry to enforce the new value.
- **Order Graph**: Toggle continuous orthogonal ordering so connections trend toward rectilinear 90° layouts.
- **Flow Calculation**: Automatically propagates "People Count" from Start nodes through the network based on connection direction.
- **T/X Intersections**: Click on any connection to split it and create a new node at that point.

## How to Run (Web App)

You need [Node.js](https://nodejs.org/) installed to run the local development server.

1. Open a terminal in this folder.
2. Run the following command to start the server:
   ```bash
   npx -y serve . -l 3000
   ```
3. Open **http://localhost:3000** in your web browser.

## CLI Usage (Terminal Calculation)

You can run the evacuation calculation directly from the terminal without opening the web app. This is useful for batch processing, scripting, or generating formal proof documents.

### Basic Usage

```bash
node core.js <input.json> [options]
```

### Options

| Flag | Description | Default |
|------|-------------|---------|
| `-p`, `--print` | Print the proof directly to the terminal (stdout) | *(off)* |
| `-o`, `--output <file>` | Write proof to a file | `mathproof.txt` |
| `-m`, `--method <A\|B>` | Calculation method: **A** (path length) or **B** (specific throughput) | `B` |
| `-r`, `--regs <file>` | Path to regulations JSON file | `./regulations.json` |
| `-h`, `--help` | Show help message | |

### Examples

**Print the full proof to your terminal:**
```bash
node core.js GraphExample.json --print
```

**Save the proof to a custom file:**
```bash
node core.js GraphExample.json -o evacuation_report.txt
```

**Use Method A instead of Method B:**
```bash
node core.js GraphExample.json --print --method A
```

**Use a custom regulations file:**
```bash
node core.js GraphExample.json -p -r ./custom_regs.json
```

### Proof Output

The proof includes:
- **Unicode formatting** with Greek letters (τ, δ, ℓ, ν) and box-drawing characters
- **Step-by-step formulas** with value substitution for every segment
- **Normative citations** referencing specific clauses of Annex 8a (e.g., `[Annex 8a, III.5(b)]`)
- **Bottleneck detection** with queue formation analysis
- **Final evacuation time** with critical path identification

## Key Shortcuts

- **V**: Select Mode (Drag to move, click to edit)
- **N**: Add Node Mode (Click empty space to add)
- **C**: Connect Mode (Click source then target, or click connection to split)
- **D**: Delete Mode (Click node/connection to remove)
- **Delete / Backspace**: Delete selected item
- **Escape**: Deselect
