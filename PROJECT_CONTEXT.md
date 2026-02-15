# Node Graph Editor - Project Context

## 1. Project Overview
A premium, dark-themed interactive node graph editor for modeling flow, built with vanilla HTML5 Canvas and JavaScript. The application focuses on clean design, intuitive interaction (drag-and-drop, smart snapping), and real-time flow simulation.

## 2. Technical Stack
- **Languages**: Vanilla JavaScript (ES6+), HTML5, CSS3.
- **Rendering**: HTML5 Canvas API for performance with many nodes.
- **Build System**: None required. Served via `npx serve`.
- **Dependencies**: None (Zero-dependency architecture).

## 3. Core Architecture
- **State Management**: Central `state` object in `app.js` holds:
  - `nodes`: Array of objects.
  - `connections`: Array of objects.
  - `nodeTypes` / `connTypes`: Definitions for styling and behavior.
  - `visual`: Zoom/Pan transforms (`cam`), selection state.
- **Rendering Loop**: `requestAnimationFrame` drives the connection/node drawing sequence.
- **Interaction**: Event listeners on canvas for mouse/touch inputs, mapped to virtual coordinates via `screenToWorld()`.

## 4. Key Systems & Logic

### A. Coordinate System & Grid
- **World Space**: Infinite canvas space.
- **Grid Snapping**: All node positions round to the nearest 40px (defined by `GRID_SIZE`).
- **Zoom/Pan**: Implemented via canvas context transforms (`ctx.scale`, `ctx.translate`).

### B. Node Logic
- **Types**:
  - **Sources (Start, Secondary Start)**: User manually inputs "number of people".
  - **Sinks/Flow (Waypoint, Exit, Default)**: "Number of people" is read-only and automatically calculated as the sum of incoming flow.
- **T/X Intersections**: Splitting a connection creates a new node at the click point, preserving flow properties.

### C. Connection Logic
- **Types**: Normal, Stairs Up, Stairs Down.
- **Direction**: Explicit `forward`, `backward`, or `both`.
- **Flow Propagation (`recalcPeopleCounts`)**:
  - A Breadth-First Search (BFS) algorithm propagates people counts from Source nodes through connections based on their Direction.
  - Updates automatically on any topology change.
- **Congestion**: Visual property (Green/Yellow/Red/Blocked) that overrides default connection color.
- **Distance**: Calculated Euclidean distance by default, but can be manually overridden by the user (persists during moves).

## 5. File Structure
- **`index.html`**: Main layout, toolbar, sidebar panels.
- **`style.css`**: Dark theme styles, glassmorphism UI, animations.
- **`app.js`**: ~1000 lines. Contains:
  - State initialization
  - Canvas rendering (drawNode, drawConnection)
  - Interaction logic (drag, connect, split)
  - Simulation logic (flow calculation)
  - UI event handlers

## 6. Design Rationale
- **Canvas vs DOM Nodes**: Canvas selected for high performance with complex graphs and custom drawing (arrows, dashed lines).
- **Immediate Mode Simulation**: Flow recalculates instantly on every change rather than requiring a "Run" button, providing immediate feedback.
- **Vanilla JS**: Chosen to keep the codebase simple, portable, and easily editable without a compilation step.

## 7. Setup & Run
1. Install Node.js.
2. Run `npx -y serve . -l 3000` in the project root.
3. Access at `http://localhost:3000`.
