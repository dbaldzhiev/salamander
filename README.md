# Node Graph Editor

A premium, dark-themed interactive node graph editor built with vanilla HTML5 Canvas and JavaScript.

## Features

- **Interactive Graph**: Create nodes, connect them, and drag them around.
- **Grid Snapping**: Nodes automatically snap to a 40px grid for clean layouts.
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
  - **Distance**: Auto-calculated Euclidean distance, or manually overrideable.
- **Flow Calculation**: Automatically propagates "People Count" from Start nodes through the network based on connection direction.
- **T/X Intersections**: Click on any connection to split it and create a new node at that point.

## How to Run

You need [Node.js](https://nodejs.org/) installed to run the local development server.

1. Open a terminal in this folder.
2. Run the following command to start the server:
   ```bash
   npx -y serve . -l 3000
   ```
3. Open **http://localhost:3000** in your web browser.

## key Shortcuts

- **V**: Select Mode (Drag to move, click to edit)
- **N**: Add Node Mode (Click empty space to add)
- **C**: Connect Mode (Click source then target, or click connection to split)
- **D**: Delete Mode (Click node/connection to remove)
- **Delete / Backspace**: Delete selected item
- **Escape**: Deselect
