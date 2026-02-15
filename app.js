/* ============================================================
   Node Graph Editor — app.js
   Interactive canvas-based graph editor with typed nodes,
   typed connections, and editable properties.
   ============================================================ */

(() => {
  'use strict';

  // ─── Data Model ───────────────────────────────────────────
  const state = {
    nodes: [],
    connections: [],
    nodeTypes: [
      { id: 'undefined', name: 'Undefined', color: '#6e7681' }, // Changed from default
      { id: 'start', name: 'Start', color: '#3fb950' },
      { id: 'start2', name: 'Secondary Start', color: '#39d2c0' },
      { id: 'waypoint', name: 'Waypoint', color: '#d29922' },
      { id: 'exit', name: 'Exit', color: '#f85149' },
    ],
    connTypes: [
      { id: 'normal', name: 'Normal', color: '#58a6ff', dash: [] },
      { id: 'stairs_up', name: 'Stairs Up', color: '#bc8cff', dash: [8, 4] },
      { id: 'stairs_down', name: 'Stairs Down', color: '#d29922', dash: [8, 4] },
    ],
    nextNodeId: 1,
    nextConnId: 1,
    regulations: null, // Loaded from regulations.json
    calculationMethod: 'A',
    totalEvacuationTime: 0,
  };

  let tool = 'select';  // select | addNode | connect | delete
  let selected = null;    // { type:'node'|'connection', id }
  let connectSource = null;
  let dragging = null;    // { nodeId, offsetX, offsetY }

  // Camera / transform
  let cam = { x: 0, y: 0, zoom: 1 };
  let isPanning = false;
  let panStart = { x: 0, y: 0 };

  const NODE_RADIUS = 24;
  const HIT_MARGIN = 8;
  const GRID_SIZE = 40;
  const PIXELS_PER_METER = 40; // 1m symbols 40px (1.2m ~= 48px node diam)

  function snapToGrid(v) {
    return Math.round(v / GRID_SIZE) * GRID_SIZE;
  }

  // ─── DOM refs ─────────────────────────────────────────────
  const canvas = document.getElementById('graphCanvas');
  const ctx = canvas.getContext('2d');
  const container = document.getElementById('canvas-container');
  const hint = document.getElementById('canvas-hint');

  // Sidebar panels
  const sidebarEmpty = document.getElementById('sidebar-empty');
  const sidebarNode = document.getElementById('sidebar-node');
  const sidebarConn = document.getElementById('sidebar-connection');

  // Node property inputs
  const inpNodeName = document.getElementById('nodeName');
  const inpNodeType = document.getElementById('nodeType');
  const inpNodeX = document.getElementById('nodeX');
  const inpNodeY = document.getElementById('nodeY');
  const nodeCustomPropsDiv = document.getElementById('nodeCustomProps');

  // Connection property inputs
  const inpConnType = document.getElementById('connType');
  const inpConnDir = document.getElementById('connDirection');
  const inpConnDist = document.getElementById('connDistance');
  const inpConnWidth = document.getElementById('connWidth');
  const inpConnSpeed = document.getElementById('connSpeed');
  const inpConnWeight = document.getElementById('connWeight');
  const inpConnCongestion = document.getElementById('connCongestion');
  const connCustomPropsDiv = document.getElementById('connCustomProps');

  // Calculation UI
  const methodRadios = document.querySelectorAll('input[name="calcMethod"]');
  const totalTimeDisplay = document.getElementById('totalTime');
  let calcMethod = 'A'; // 'A' or 'B'

  methodRadios.forEach(r => {
    r.addEventListener('change', (e) => {
      calcMethod = e.target.value;
      recalcFireSafety(); // We'll implement this
      render();
    });
  });

  // ... (Keep splitConnection, createConnection updates below)

  function updateSidebar() {
    sidebarEmpty.style.display = 'none';
    sidebarNode.style.display = 'none';
    sidebarConn.style.display = 'none';

    if (!selected) {
      sidebarEmpty.style.display = 'flex';
      return;
    }

    if (selected.type === 'node') {
      // ... (existing node logic)
      const node = state.nodes.find(n => n.id === selected.id);
      if (!node) { sidebarEmpty.style.display = 'flex'; return; }
      sidebarNode.style.display = 'block';
      inpNodeName.value = node.name;
      populateTypeSelect(inpNodeType, state.nodeTypes, node.typeId);
      inpNodeX.value = node.x;
      inpNodeY.value = node.y;
      const isSource = ['start', 'start2'].includes(node.typeId);
      inpNodePeople.value = node.people || '';
      inpNodePeople.readOnly = !isSource;
      if (isSource) {
        peopleHint.textContent = 'Enter number of people at this origin';
      } else {
        peopleHint.textContent = 'Auto-calculated from incoming connections';
      }
      renderCustomProps(nodeCustomPropsDiv, node.props, 'node');
    }

    if (selected.type === 'connection') {
      const conn = state.connections.find(c => c.id === selected.id);
      if (!conn) { sidebarEmpty.style.display = 'flex'; return; }
      sidebarConn.style.display = 'block';
      populateTypeSelect(inpConnType, state.connTypes, conn.typeId);
      inpConnDir.value = conn.direction || 'forward';
      inpConnDist.value = conn.distance;
      inpConnWidth.value = conn.width || 1.2; // New input
      inpConnSpeed.value = conn.speed || '';
      inpConnWeight.value = conn.weight || '';
      inpConnCongestion.value = conn.congestion || 'none';
      renderCustomProps(connCustomPropsDiv, conn.props, 'connection');
    }
  }

  // Node people count
  const inpNodePeople = document.getElementById('nodePeople');
  const peopleHint = document.getElementById('peopleHint');
  const peopleGroup = document.getElementById('peopleGroup');

  // Bottom Panel Refs
  const nodesTableBody = document.getElementById('nodesTableBody');
  const connectionsTableBody = document.getElementById('connectionsTableBody');
  const panelNodes = document.getElementById('panel-nodes');
  const panelConnections = document.getElementById('panel-connections');
  const panelTabs = document.querySelectorAll('.panel-tab');

  // Congestion color map
  const CONGESTION_COLORS = {
    none: null,
    low: '#3fb950',
    medium: '#d29922',
    high: '#f85149',
    blocked: '#6e7681',
  };
  const CONGESTION_WIDTH = {
    none: 2,
    low: 3,
    medium: 4,
    high: 5,
    blocked: 6,
  };

  // Type lists
  const nodeTypesList = document.getElementById('nodeTypesList');
  const connTypesList = document.getElementById('connTypesList');

  // ─── Helpers ──────────────────────────────────────────────
  const dist = (a, b) => Math.sqrt((a.x - b.x) ** 2 + (a.y - b.y) ** 2);
  const lerp = (a, b, t) => a + (b - a) * t;
  const uid = () => Math.random().toString(36).slice(2, 9);

  function screenToWorld(sx, sy) {
    return {
      x: (sx - cam.x) / cam.zoom,
      y: (sy - cam.y) / cam.zoom,
    };
  }

  function worldToScreen(wx, wy) {
    return {
      x: wx * cam.zoom + cam.x,
      y: wy * cam.zoom + cam.y,
    };
  }

  // ─── Canvas Sizing ────────────────────────────────────────
  function resizeCanvas() {
    const dpr = window.devicePixelRatio || 1;
    const rect = container.getBoundingClientRect();
    canvas.width = rect.width * dpr;
    canvas.height = rect.height * dpr;
    canvas.style.width = rect.width + 'px';
    canvas.style.height = rect.height + 'px';
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    render();
  }
  window.addEventListener('resize', resizeCanvas);

  // ─── Fire Safety Calculations ─────────────────────────────

  function getSegmentParams(conn) {
    if (!state.regulations) return null;

    // Map connection type to regulations type
    let type = 'horiz'; // Default
    if (conn.typeId === 'stairs_up') type = 'stair_up';
    else if (conn.typeId === 'stairs_down') type = 'stair_down';

    // Get dimensions and flow
    // Width: use custom prop or default 1.2m
    const width = parseFloat(conn.props.width || 1.2);
    const length = conn.distance || 0;

    // People: use source node's people count
    const src = state.nodes.find(n => n.id === conn.sourceId);
    const people = src ? (src.people || 0) : 0;

    return { type, width, length, people };
  }

  function lookupTable11(segType, density) {
    if (!state.regulations) return { v: 0, q: 0 };
    const table = state.regulations.table_11_flow_params.data;
    const colName = segType === 'horiz' ? 'horiz' :
      segType === 'stair_down' ? 'stair_down' :
        segType === 'stair_up' ? 'stair_up' : 'horiz';

    // Find first row where D >= density (conservative)
    // Table is sorted by D
    let row = table.find(r => r.D >= density);
    if (!row) row = table[table.length - 1]; // Cap at max

    const val = row[colName];
    return { v: val.v, q: val.q };
  }

  function calcMethodA() {
    // Method A: Sum of travel times (Length / Speed)
    // 1. Calculate time for each segment
    state.connections.forEach(conn => {
      const p = getSegmentParams(conn);
      if (!p) { conn.travelTime = 0; return; }

      const area = p.length * p.width;
      const density = area > 0 ? p.people / area : 0;

      const { v } = lookupTable11(p.type, density);

      // Time in minutes
      conn.travelTime = v > 0 ? p.length / v : 0;

      // Visualization: Color based on density? 
      // specific flow q = D * v. Compare to q_max?
      // For now, keep simple.
      conn.calcStats = { density, v, time: conn.travelTime };
    });

    // 2. Find longest path time (Critical Path)
    // DAG propagation: node.maxTime = max(incoming.maxTime + conn.time)

    // Reset maxTime
    state.nodes.forEach(n => n.maxTime = 0);

    // Topological sort or multi-pass
    // Since we handle loops naively in recalcPeople, let's do multi-pass here too
    for (let pass = 0; pass < state.nodes.length + 1; pass++) {
      let changed = false;
      for (const conn of state.connections) {
        const src = state.nodes.find(n => n.id === conn.sourceId);
        const tgt = state.nodes.find(n => n.id === conn.targetId);
        if (!src || !tgt) continue;

        const newTime = (src.maxTime || 0) + (conn.travelTime || 0);
        if (newTime > (tgt.maxTime || 0)) {
          tgt.maxTime = newTime;
          changed = true;
        }
      }
      if (!changed) break;
    }

    // Total time is the max of all Exit nodes (or all nodes?)
    // Usually max time to reach an Exit
    const exitNodes = state.nodes.filter(n => n.typeId === 'exit');
    let maxT = 0;
    if (exitNodes.length > 0) {
      maxT = Math.max(...exitNodes.map(n => n.maxTime));
    } else {
      maxT = Math.max(...state.nodes.map(n => n.maxTime));
    }

    state.totalEvacuationTime = maxT;
  }

  function recalcFireSafety() {
    if (!state.regulations) return;

    if (state.calculationMethod === 'A') {
      calcMethodA();
    } else {
      // Method B Placeholder
      // Fallback to A for now or implement partially
      calcMethodA();
      console.warn('Method B not fully implemented yet, fell back to A logic for internal times.');
    }

    // Update Display
    if (totalTimeDisplay) {
      totalTimeDisplay.textContent = state.totalEvacuationTime.toFixed(2);
    }
  }

  // ─── Rendering ────────────────────────────────────────────
  function render() {
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    ctx.clearRect(0, 0, w, h);

    // Background
    ctx.fillStyle = '#0d1117';
    ctx.fillRect(0, 0, w, h);

    // Grid
    drawGrid(w, h);

    // Connections
    for (const conn of state.connections) {
      drawConnection(conn);
    }

    // Temp connection line while connecting
    if (tool === 'connect' && connectSource && tempMouseWorld) {
      const src = state.nodes.find(n => n.id === connectSource);
      if (src) {
        const s = worldToScreen(src.x, src.y);
        const e = worldToScreen(tempMouseWorld.x, tempMouseWorld.y);
        ctx.beginPath();
        ctx.setLineDash([6, 4]);
        ctx.strokeStyle = 'rgba(88,166,255,.5)';
        ctx.lineWidth = 2;
        ctx.moveTo(s.x, s.y);
        ctx.lineTo(e.x, e.y);
        ctx.stroke();
        ctx.setLineDash([]);
      }
    }

    // Nodes
    for (const node of state.nodes) {
      drawNode(node);
    }

    // Update Table
    renderTable();
  }

  function drawGrid(w, h) {
    const gridSize = 40;
    const scaledGrid = gridSize * cam.zoom;

    if (scaledGrid < 8) return; // too zoomed out

    const offsetX = cam.x % scaledGrid;
    const offsetY = cam.y % scaledGrid;

    ctx.beginPath();
    ctx.strokeStyle = 'rgba(48,54,61,.6)';
    ctx.lineWidth = 1;

    for (let x = offsetX; x < w; x += scaledGrid) {
      ctx.moveTo(Math.round(x) + 0.5, 0);
      ctx.lineTo(Math.round(x) + 0.5, h);
    }
    for (let y = offsetY; y < h; y += scaledGrid) {
      ctx.moveTo(0, Math.round(y) + 0.5);
      ctx.lineTo(w, Math.round(y) + 0.5);
    }
    ctx.stroke();

    // Major gridlines
    const majorGrid = scaledGrid * 5;
    if (majorGrid >= 40) {
      const majorOffX = cam.x % majorGrid;
      const majorOffY = cam.y % majorGrid;
      ctx.beginPath();
      ctx.strokeStyle = 'rgba(48,54,61,1)';
      ctx.lineWidth = 1;
      for (let x = majorOffX; x < w; x += majorGrid) {
        ctx.moveTo(Math.round(x) + 0.5, 0);
        ctx.lineTo(Math.round(x) + 0.5, h);
      }
      for (let y = majorOffY; y < h; y += majorGrid) {
        ctx.moveTo(0, Math.round(y) + 0.5);
        ctx.lineTo(w, Math.round(y) + 0.5);
      }
      ctx.stroke();
    }
  }

  function drawNode(node) {
    const nt = state.nodeTypes.find(t => t.id === node.typeId) || state.nodeTypes[0];
    const s = worldToScreen(node.x, node.y);
    const r = NODE_RADIUS * cam.zoom;
    const isSelected = selected && selected.type === 'node' && selected.id === node.id;
    const isConnectSource = connectSource === node.id;

    // Glow
    if (isSelected || isConnectSource) {
      ctx.save();
      ctx.beginPath();
      ctx.arc(s.x, s.y, r + 8, 0, Math.PI * 2);
      const grad = ctx.createRadialGradient(s.x, s.y, r * 0.7, s.x, s.y, r + 12);
      grad.addColorStop(0, nt.color + '40');
      grad.addColorStop(1, 'transparent');
      ctx.fillStyle = grad;
      ctx.fill();
      ctx.restore();
    }

    // Outer ring
    ctx.beginPath();
    ctx.arc(s.x, s.y, r, 0, Math.PI * 2);
    const bodyGrad = ctx.createRadialGradient(s.x - r * 0.3, s.y - r * 0.3, 0, s.x, s.y, r);
    bodyGrad.addColorStop(0, lightenColor(nt.color, 30));
    bodyGrad.addColorStop(1, nt.color);
    ctx.fillStyle = bodyGrad;
    ctx.fill();

    // Inner circle
    ctx.beginPath();
    ctx.arc(s.x, s.y, r * 0.7, 0, Math.PI * 2);
    ctx.fillStyle = '#161b22';
    ctx.fill();

    // Border
    ctx.beginPath();
    ctx.arc(s.x, s.y, r, 0, Math.PI * 2);
    ctx.strokeStyle = isSelected ? '#fff' : nt.color;
    ctx.lineWidth = isSelected ? 2.5 : 1.5;
    ctx.stroke();

    // People count inside the node
    const people = node.people || 0;
    if (people > 0) {
      ctx.font = `600 ${Math.max(10, 12 * cam.zoom)}px Inter, sans-serif`;
      ctx.fillStyle = var_textPrimary;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(String(people), s.x, s.y);
    }

    // Label
    const label = node.name || `Node ${node.id}`;
    ctx.font = `${Math.max(10, 11 * cam.zoom)}px Inter, sans-serif`;
    ctx.fillStyle = var_textPrimary;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    ctx.fillText(label, s.x, s.y + r + 6);

    // Type badge
    ctx.font = `${Math.max(8, 9 * cam.zoom)}px Inter, sans-serif`;
    ctx.fillStyle = nt.color;
    ctx.fillText(nt.name, s.x, s.y + r + 6 + Math.max(12, 14 * cam.zoom));
  }

  const var_textPrimary = '#e6edf3';

  function drawConnection(conn) {
    const src = state.nodes.find(n => n.id === conn.sourceId);
    const tgt = state.nodes.find(n => n.id === conn.targetId);
    if (!src || !tgt) return;

    const ct = state.connTypes.find(t => t.id === conn.typeId) || state.connTypes[0];
    const isSelected = selected && selected.type === 'connection' && selected.id === conn.id;
    const dir = conn.direction || 'forward';
    const congestion = conn.congestion || 'none';

    // Width visualization
    const widthMeters = conn.width || 1.2;
    const pixelWidth = Math.max(2, widthMeters * PIXELS_PER_METER * cam.zoom);

    // Determine color: congestion overrides type color
    const congColor = CONGESTION_COLORS[congestion];
    const lineColor = isSelected ? '#fff' : (congColor || ct.color);
    // const lineWidth = isSelected ? 3 : (CONGESTION_WIDTH[congestion] || 2); 

    const s = worldToScreen(src.x, src.y);
    const e = worldToScreen(tgt.x, tgt.y);

    // For blocked congestion, draw X marks
    if (congestion === 'blocked' && !isSelected) {
      ctx.setLineDash([4, 8]);
    } else {
      ctx.setLineDash(ct.dash || []);
    }

    // Line (Transparent)
    ctx.save();
    ctx.globalAlpha = 0.6; // Make connection line semi-transparent
    ctx.beginPath();
    ctx.strokeStyle = lineColor;
    ctx.lineWidth = pixelWidth;
    ctx.lineCap = 'butt'; // clean ends for thick lines
    ctx.moveTo(s.x, s.y);
    ctx.lineTo(e.x, e.y);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.lineCap = 'round'; // reset
    ctx.restore(); // Restore alpha

    // Highlight border if selected (since color is white, maybe dark border?)
    if (isSelected) {
      ctx.beginPath();
      ctx.strokeStyle = '#58a6ff'; // selection blue
      ctx.lineWidth = 1;
      ctx.moveTo(s.x, s.y);
      ctx.lineTo(e.x, e.y);
      ctx.stroke();
    }

    // Width Handle (only if selected) - Moved to 1/3 position
    if (isSelected) {
      // Use 0.35 to be away from center (0.5) where text is
      const t = 0.35;
      const mx = s.x + (e.x - s.x) * t;
      const my = s.y + (e.y - s.y) * t;

      // Perpendicular vector
      const dx = e.x - s.x;
      const dy = e.y - s.y;
      const len = Math.sqrt(dx * dx + dy * dy);
      const nx = -dy / len;
      const ny = dx / len;

      // Handle position: offset by half width + padding
      const handleDist = pixelWidth / 2 + 10;
      const hx = mx + nx * handleDist;
      const hy = my + ny * handleDist;

      ctx.beginPath();
      ctx.arc(hx, hy, 5, 0, Math.PI * 2);
      ctx.fillStyle = '#fff';
      ctx.strokeStyle = '#000';
      ctx.lineWidth = 2;
      ctx.fill();
      ctx.stroke();
    }

    // Arrows based on direction (adjust size for width)
    const angle = Math.atan2(e.y - s.y, e.x - s.x);
    const arrowR = NODE_RADIUS * cam.zoom + 4;
    const arrowLen = Math.max(10 * cam.zoom, pixelWidth * 0.8);

    function drawArrow(tipX, tipY, ang) {
      ctx.beginPath();
      ctx.moveTo(tipX, tipY);
      ctx.lineTo(tipX - arrowLen * Math.cos(ang - 0.35), tipY - arrowLen * Math.sin(ang - 0.35));
      ctx.moveTo(tipX, tipY);
      ctx.lineTo(tipX - arrowLen * Math.cos(ang + 0.35), tipY - arrowLen * Math.sin(ang + 0.35));
      ctx.strokeStyle = lineColor;
      ctx.lineWidth = isSelected ? 2.5 : 2;
      ctx.stroke();
    }

    // Forward arrow (toward target)
    if (dir === 'forward' || dir === 'both') {
      const ax = e.x - Math.cos(angle) * arrowR;
      const ay = e.y - Math.sin(angle) * arrowR;
      drawArrow(ax, ay, angle);
    }
    // Backward arrow (toward source)
    if (dir === 'backward' || dir === 'both') {
      const bx = s.x + Math.cos(angle) * arrowR;
      const by = s.y + Math.sin(angle) * arrowR;
      drawArrow(bx, by, angle + Math.PI);
    }

    // Label (Distance + Time)
    const midX = (s.x + e.x) / 2;
    const midY = (s.y + e.y) / 2;

    let label = `${conn.distance}m`;
    if (conn.calcStats) {
      // Show Time (min) or Density?
      // Let's show time if it's significant
      const t = conn.calcStats.time;
      if (t !== undefined) label += ` • ${t.toFixed(2)}min`;
    }

    ctx.fillStyle = '#f0f6fc';
    ctx.font = '12px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';

    // Background for text
    const metrics = ctx.measureText(label);
    const textW = metrics.width;
    ctx.save();
    ctx.fillStyle = 'rgba(13,17,23, 0.8)';
    ctx.beginPath();
    ctx.roundRect(midX - textW / 2 - 4, midY - 10, textW + 8, 20, 4);
    ctx.fill();
    ctx.restore();

    ctx.fillText(label, midX, midY);

    // Distance label below
    // (Old distance label removed to avoid clutter)
  }

  function lightenColor(color, percent) {
    if (!color.startsWith('#')) return color; // can't lighten hsl/rgb easily, return as-is
    const num = parseInt(color.replace('#', ''), 16);
    const r = Math.min(255, (num >> 16) + percent);
    const g = Math.min(255, ((num >> 8) & 0x00FF) + percent);
    const b = Math.min(255, (num & 0x0000FF) + percent);
    return `rgb(${r},${g},${b})`;
  }

  function colorToHex(color) {
    if (color.startsWith('#')) return color;
    // Use a temp canvas to resolve any CSS color to hex
    const tempCtx = document.createElement('canvas').getContext('2d');
    tempCtx.fillStyle = color;
    return tempCtx.fillStyle; // browsers return hex
  }

  // ─── Hit Testing ──────────────────────────────────────────
  function hitTestNode(wx, wy) {
    for (let i = state.nodes.length - 1; i >= 0; i--) {
      const n = state.nodes[i];
      if (dist({ x: wx, y: wy }, n) <= NODE_RADIUS + HIT_MARGIN) return n;
    }
    return null;
  }

  function hitTestConnection(wx, wy) {
    for (let i = state.connections.length - 1; i >= 0; i--) {
      const c = state.connections[i];
      const src = state.nodes.find(n => n.id === c.sourceId);
      const tgt = state.nodes.find(n => n.id === c.targetId);
      if (!src || !tgt) continue;
      const d = pointToSegmentDist(wx, wy, src.x, src.y, tgt.x, tgt.y);
      if (d < 10 / cam.zoom) return c;
    }
    return null;
  }

  function pointToSegmentDist(px, py, x1, y1, x2, y2) {
    const dx = x2 - x1, dy = y2 - y1;
    const lenSq = dx * dx + dy * dy;
    if (lenSq === 0) return dist({ x: px, y: py }, { x: x1, y: y1 });
    let t = ((px - x1) * dx + (py - y1) * dy) / lenSq;
    t = Math.max(0, Math.min(1, t));
    return dist({ x: px, y: py }, { x: x1 + t * dx, y: y1 + t * dy });
  }

  // Returns the closest point on segment (x1,y1)-(x2,y2) to point (px,py)
  function projectOnSegment(px, py, x1, y1, x2, y2) {
    const dx = x2 - x1, dy = y2 - y1;
    const lenSq = dx * dx + dy * dy;
    if (lenSq === 0) return { x: x1, y: y1, t: 0 };
    let t = ((px - x1) * dx + (py - y1) * dy) / lenSq;
    t = Math.max(0, Math.min(1, t));
    return { x: x1 + t * dx, y: y1 + t * dy, t };
  }

  // Find closest connection to a world point, within threshold
  function hitTestConnectionWithPoint(wx, wy) {
    let best = null;
    let bestDist = Infinity;
    for (let i = state.connections.length - 1; i >= 0; i--) {
      const c = state.connections[i];
      const src = state.nodes.find(n => n.id === c.sourceId);
      const tgt = state.nodes.find(n => n.id === c.targetId);
      if (!src || !tgt) continue;
      const d = pointToSegmentDist(wx, wy, src.x, src.y, tgt.x, tgt.y);
      if (d < 10 / cam.zoom && d < bestDist) {
        const proj = projectOnSegment(wx, wy, src.x, src.y, tgt.x, tgt.y);
        best = { conn: c, proj, dist: d };
        bestDist = d;
      }
    }
    return best;
  }

  // Split a connection at a point, creating a new node and two new connections
  function splitConnection(conn, wx, wy) {
    const src = state.nodes.find(n => n.id === conn.sourceId);
    const tgt = state.nodes.find(n => n.id === conn.targetId);
    if (!src || !tgt) return null;

    // Create the new node at the snap point
    const sx = snapToGrid(wx);
    const sy = snapToGrid(wy);
    const newNode = {
      id: state.nextNodeId++,
      name: '',
      typeId: 'waypoint', // Split nodes vary are waypoints
      x: sx,
      y: sy,
      props: {},
    };
    state.nodes.push(newNode);

    // Create two new connections replacing the old one
    const conn1 = {
      id: state.nextConnId++,
      sourceId: conn.sourceId,
      targetId: newNode.id,
      typeId: conn.typeId,
      direction: conn.direction,
      distance: Math.round(dist(src, newNode) * 10) / 10,
      distanceManual: false,
      speed: conn.speed,
      weight: conn.weight,
      congestion: conn.congestion,
      props: { ...conn.props },
    };
    const conn2 = {
      id: state.nextConnId++,
      sourceId: newNode.id,
      targetId: conn.targetId,
      typeId: conn.typeId,
      direction: conn.direction,
      distance: Math.round(dist(newNode, tgt) * 10) / 10,
      distanceManual: false,
      speed: conn.speed,
      weight: conn.weight,
      congestion: conn.congestion,
      props: { ...conn.props },
    };

    // Remove old connection, add new ones
    state.connections = state.connections.filter(c => c.id !== conn.id);
    state.connections.push(conn1, conn2);

    recalcPeopleCounts();
    return newNode;
  }

  // ─── Node & Connection Ops ────────────────────────────────
  function createNode(wx, wy) {
    // Auto-assign type based on creation order
    let typeId = 'undefined';
    let people = 0;

    if (state.nodes.length === 0) {
      typeId = 'start';
      people = 10;
    } else if (state.nodes.length === 1) {
      typeId = 'exit';
      people = 0; // Exit nodes calculated from incoming
    } else {
      typeId = 'start2'; // Secondary Start for others
      people = 6;
    }

    const node = {
      id: state.nextNodeId++,
      name: '',
      typeId: typeId,
      x: snapToGrid(wx),
      y: snapToGrid(wy),
      people: people,
      props: {},
    };
    state.nodes.push(node);
    selectItem({ type: 'node', id: node.id });
    render();
    return node;
  }

  function createConnection(srcId, tgtId) {
    // Prevent duplicate
    if (state.connections.find(c =>
      (c.sourceId === srcId && c.targetId === tgtId) ||
      (c.sourceId === tgtId && c.targetId === srcId))) return null;
    if (srcId === tgtId) return null;

    const src = state.nodes.find(n => n.id === srcId);
    const tgt = state.nodes.find(n => n.id === tgtId);
    const d = src && tgt ? dist(src, tgt) : 0;

    const conn = {
      id: state.nextConnId++,
      sourceId: srcId,
      targetId: tgtId,
      typeId: state.connTypes[0].id,
      direction: 'forward',
      distance: Math.round(d * 10) / 10,
      distanceManual: false,
      speed: 0,
      weight: 1,
      congestion: 'none',
      props: {},
    };
    state.connections.push(conn);
    selectItem({ type: 'connection', id: conn.id });
    recalcPeopleCounts();
    render();
    return conn;
  }

  function deleteNode(nodeId) {
    state.nodes = state.nodes.filter(n => n.id !== nodeId);
    state.connections = state.connections.filter(c => c.sourceId !== nodeId && c.targetId !== nodeId);
    if (selected && selected.type === 'node' && selected.id === nodeId) clearSelection();
    recalcPeopleCounts();
    render();
  }

  function deleteConnection(connId) {
    state.connections = state.connections.filter(c => c.id !== connId);
    if (selected && selected.type === 'connection' && selected.id === connId) clearSelection();
    recalcPeopleCounts();
    render();
  }

  function updateConnectionDistances() {
    for (const c of state.connections) {
      if (c.distanceManual) continue;
      const src = state.nodes.find(n => n.id === c.sourceId);
      const tgt = state.nodes.find(n => n.id === c.targetId);
      if (src && tgt) c.distance = Math.round(dist(src, tgt) * 10) / 10;
    }
    recalcFireSafety();
  }

  // ─── People Count Calculation ─────────────────────────────
  const SOURCE_TYPES = ['start', 'start2'];

  function recalcPeopleCounts() {
    // Reset non-source nodes
    for (const node of state.nodes) {
      if (!SOURCE_TYPES.includes(node.typeId)) {
        node.people = 0;
      }
    }
    // Multi-pass propagation
    for (let pass = 0; pass < state.nodes.length; pass++) {
      let changed = false;
      for (const node of state.nodes) {
        if (SOURCE_TYPES.includes(node.typeId)) continue;
        const incoming = calcIncoming(node.id);
        if (node.people !== incoming) {
          node.people = incoming;
          changed = true;
        }
      }
      if (!changed) break;
    }
    state.connections.sort((a, b) => b.weight - a.weight); // render broad first?
    recalcFireSafety();
  }

  function calcIncoming(nodeId) {
    let total = 0;
    for (const conn of state.connections) {
      const dir = conn.direction || 'forward';
      if (dir === 'forward' || dir === 'both') {
        if (conn.targetId === nodeId) {
          const src = state.nodes.find(n => n.id === conn.sourceId);
          if (src) total += (src.people || 0);
        }
      }
      if (dir === 'backward' || dir === 'both') {
        if (conn.sourceId === nodeId) {
          const tgt = state.nodes.find(n => n.id === conn.targetId);
          if (tgt) total += (tgt.people || 0);
        }
      }
    }
    return total;
  }

  // ─── Selection ────────────────────────────────────────────
  function selectItem(item) {
    selected = item;
    updateSidebar();
    render();
  }

  function clearSelection() {
    selected = null;
    connectSource = null;
    updateSidebar();
    render();
  }

  // ─── Sidebar Updates ─────────────────────────────────────
  function updateSidebar() {
    sidebarEmpty.style.display = 'none';
    sidebarNode.style.display = 'none';
    sidebarConn.style.display = 'none';

    if (!selected) {
      sidebarEmpty.style.display = 'flex';
      return;
    }

    if (selected.type === 'node') {
      const node = state.nodes.find(n => n.id === selected.id);
      if (!node) { sidebarEmpty.style.display = 'flex'; return; }
      sidebarNode.style.display = 'block';
      inpNodeName.value = node.name;
      populateTypeSelect(inpNodeType, state.nodeTypes, node.typeId);
      inpNodeX.value = node.x;
      inpNodeY.value = node.y;
      // People count: editable for Start/Secondary Start, readonly for others
      const isSource = ['start', 'start2'].includes(node.typeId);
      inpNodePeople.value = node.people || '';
      inpNodePeople.readOnly = !isSource;
      if (isSource) {
        peopleHint.textContent = 'Enter number of people at this origin';
      } else {
        peopleHint.textContent = 'Auto-calculated from incoming connections';
      }
      renderCustomProps(nodeCustomPropsDiv, node.props, 'node');
    }

    if (selected.type === 'connection') {
      const conn = state.connections.find(c => c.id === selected.id);
      if (!conn) { sidebarEmpty.style.display = 'flex'; return; }
      sidebarConn.style.display = 'block';
      populateTypeSelect(inpConnType, state.connTypes, conn.typeId);
      inpConnDir.value = conn.direction || 'forward';
      inpConnDist.value = conn.distance;
      inpConnSpeed.value = conn.speed || '';
      inpConnWeight.value = conn.weight || '';
      inpConnCongestion.value = conn.congestion || 'none';
      renderCustomProps(connCustomPropsDiv, conn.props, 'connection');
    }
  }

  function populateTypeSelect(select, types, currentId) {
    select.innerHTML = '';
    for (const t of types) {
      const opt = document.createElement('option');
      opt.value = t.id;
      opt.textContent = t.name;
      if (t.id === currentId) opt.selected = true;
      select.appendChild(opt);
    }
  }

  function renderCustomProps(container, props, itemType) {
    container.innerHTML = '';
    for (const [key, val] of Object.entries(props)) {
      const row = document.createElement('div');
      row.className = 'custom-prop-row';
      row.innerHTML = `
        <input type="text" value="${escHtml(key)}" placeholder="Key" class="prop-key">
        <input type="text" value="${escHtml(String(val))}" placeholder="Value" class="prop-val">
        <button class="btn-remove-prop" title="Remove">×</button>
      `;
      row.querySelector('.prop-key').addEventListener('change', (e) => {
        const newKey = e.target.value.trim();
        if (newKey && newKey !== key) {
          props[newKey] = props[key];
          delete props[key];
          renderCustomProps(container, props, itemType);
        }
      });
      row.querySelector('.prop-val').addEventListener('change', (e) => {
        props[key] = e.target.value;
      });
      row.querySelector('.btn-remove-prop').addEventListener('click', () => {
        delete props[key];
        renderCustomProps(container, props, itemType);
      });
      container.appendChild(row);
    }
  }

  function escHtml(s) {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  // ─── Table Rendering ─────────────────────────────────────
  function renderTable() {
    // 1. Nodes Table
    let nHtml = '';
    for (const n of state.nodes) {
      const isSel = selected && selected.type === 'node' && selected.id === n.id;
      const type = state.nodeTypes.find(t => t.id === n.typeId);
      const typeName = type ? type.name : n.typeId;
      nHtml += `<tr class="${isSel ? 'selected' : ''}" onclick="window.selectNode(${n.id})">
        <td>${n.id}</td>
        <td>${escHtml(n.name)}</td>
        <td>${escHtml(typeName)}</td>
        <td>${n.people || 0}</td>
        <td>${n.x}</td>
        <td>${n.y}</td>
      </tr>`;
    }
    nodesTableBody.innerHTML = nHtml;

    // 2. Connections Table
    let cHtml = '';
    for (const c of state.connections) {
      const isSel = selected && selected.type === 'connection' && selected.id === c.id;
      const cType = state.connTypes.find(t => t.id === c.typeId);
      const cTypeName = cType ? cType.name : c.typeId;
      cHtml += `<tr class="${isSel ? 'selected' : ''}" onclick="window.selectConnection(${c.id})">
        <td>${c.id}</td>
        <td>${c.sourceId}</td>
        <td>${c.targetId}</td>
        <td>${escHtml(cTypeName)}</td>
        <td>${c.distance.toFixed(1)}</td>
        <td>${c.speed || '-'}</td>
        <td>${c.congestion || 'none'}</td>
      </tr>`;
    }
    connectionsTableBody.innerHTML = cHtml;
  }

  // Expose selection helpers to global scope for row clicks
  window.selectNode = (id) => {
    selectItem({ type: 'node', id: id });
    render(); // force render
  };
  window.selectConnection = (id) => {
    selectItem({ type: 'connection', id: id });
    render(); // force render
  };


  // ─── Regulations Data ─────────────────────────────────────
  let regulationsData = null;
  const regulationsTableBody = document.getElementById('regulationsTableBody');
  const panelRegulations = document.getElementById('panel-regulations');

  fetch('regulations.json')
    .then(res => res.json())
    .then(data => {
      regulationsData = data;
      renderRegulationsTable();
    })
    .catch(err => console.error('Failed to load regulations:', err));

  function renderRegulationsTable() {
    if (!regulationsData || !regulationsData.table_11_flow_params) return;

    let html = '';
    const rows = regulationsData.table_11_flow_params.data;

    for (const row of rows) {
      html += `<tr>
            <td>${row.D}</td>
            <td>${row.horiz.v}</td>
            <td>${row.horiz.q}</td>
            <td>${row.stair_down.v}</td>
            <td>${row.stair_down.q}</td>
            <td>${row.stair_up.v}</td>
            <td>${row.stair_up.q}</td>
            <td>${row.door_wide.v}</td>
            <td>${row.door_wide.q}</td>
        </tr>`;
    }
    regulationsTableBody.innerHTML = html;
  }

  // ─── Panel Tabs ──────────────────────────────────────────
  panelTabs.forEach(tab => {
    tab.addEventListener('click', () => {
      // Toggle active state
      panelTabs.forEach(t => t.classList.remove('active'));
      tab.classList.add('active');

      // Show/Hide Content
      const target = tab.dataset.tab;
      panelNodes.style.display = 'none';
      panelConnections.style.display = 'none';
      panelRegulations.style.display = 'none';

      if (target === 'nodes') {
        panelNodes.style.display = 'block';
      } else if (target === 'connections') {
        panelConnections.style.display = 'block';
      } else if (target === 'regulations') {
        panelRegulations.style.display = 'block';
      }
    });
  });

  // CSV Export
  document.getElementById('btnExportCSV').addEventListener('click', () => {
    // Determine active tab
    const isNodes = panelNodes.style.display !== 'none';
    let csvContent = "data:text/csv;charset=utf-8,";

    if (isNodes) {
      csvContent += "ID,Name,Type,People,X,Y\n";
      state.nodes.forEach(n => {
        const type = state.nodeTypes.find(t => t.id === n.typeId);
        const tName = type ? type.name : n.typeId;
        csvContent += `${n.id},"${n.name}","${tName}",${n.people || 0},${n.x},${n.y}\n`;
      });
    } else {
      csvContent += "ID,Source,Target,Type,Distance,Speed,Congestion\n";
      state.connections.forEach(c => {
        const type = state.connTypes.find(t => t.id === c.typeId);
        const tName = type ? type.name : c.typeId;
        csvContent += `${c.id},${c.sourceId},${c.targetId},"${tName}",${c.distance},${c.speed || 0},"${c.congestion}"\n`;
      });
    }

    const encodedUri = encodeURI(csvContent);
    const link = document.createElement("a");
    link.setAttribute("href", encodedUri);
    link.setAttribute("download", isNodes ? "nodes.csv" : "connections.csv");
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  });

  // ─── Sidebar Input Handlers ──────────────────────────────
  inpNodeName.addEventListener('input', () => {
    if (!selected || selected.type !== 'node') return;
    const node = state.nodes.find(n => n.id === selected.id);
    if (node) { node.name = inpNodeName.value; render(); }
  });

  inpNodeType.addEventListener('change', () => {
    if (!selected || selected.type !== 'node') return;
    const node = state.nodes.find(n => n.id === selected.id);
    if (node) {
      node.typeId = inpNodeType.value;
      recalcPeopleCounts();
      updateSidebar();
      render();
    }
  });

  inpNodeX.addEventListener('change', () => {
    if (!selected || selected.type !== 'node') return;
    const node = state.nodes.find(n => n.id === selected.id);
    if (node) { node.x = Number(inpNodeX.value); updateConnectionDistances(); updateSidebar(); render(); }
  });

  inpNodeY.addEventListener('change', () => {
    if (!selected || selected.type !== 'node') return;
    const node = state.nodes.find(n => n.id === selected.id);
    if (node) { node.y = Number(inpNodeY.value); updateConnectionDistances(); updateSidebar(); render(); }
  });

  inpConnType.addEventListener('change', () => {
    if (!selected || selected.type !== 'connection') return;
    const conn = state.connections.find(c => c.id === selected.id);
    if (conn) { conn.typeId = inpConnType.value; render(); }
  });

  inpConnDist.addEventListener('change', () => {
    if (!selected || selected.type !== 'connection') return;
    const conn = state.connections.find(c => c.id === selected.id);
    if (conn) {
      conn.distance = Number(inpConnDist.value) || 0;
      conn.distanceManual = true;
      recalcFireSafety();
    }
  });

  inpConnSpeed.addEventListener('change', () => {
    if (!selected || selected.type !== 'connection') return;
    const conn = state.connections.find(c => c.id === selected.id);
    if (conn) conn.speed = Number(inpConnSpeed.value) || 0;
  });

  inpConnWeight.addEventListener('change', () => {
    if (!selected || selected.type !== 'connection') return;
    const conn = state.connections.find(c => c.id === selected.id);
    if (conn) conn.weight = Number(inpConnWeight.value) || 1;
  });

  // Width handler
  inpConnWidth.addEventListener('change', () => {
    if (!selected || selected.type !== 'connection') return;
    const conn = state.connections.find(c => c.id === selected.id);
    if (conn) {
      conn.width = Number(inpConnWidth.value) || 1.2;
      recalcFireSafety();
      render();
    }
  });

  // People count handler
  inpNodePeople.addEventListener('change', () => {
    if (!selected || selected.type !== 'node') return;
    const node = state.nodes.find(n => n.id === selected.id);
    if (node && SOURCE_TYPES.includes(node.typeId)) {
      node.people = Math.max(0, parseInt(inpNodePeople.value) || 0);
      recalcPeopleCounts();
      render();
    }
  });

  // Direction handler
  inpConnDir.addEventListener('change', () => {
    if (!selected || selected.type !== 'connection') return;
    const conn = state.connections.find(c => c.id === selected.id);
    if (conn) {
      conn.direction = inpConnDir.value;
      recalcPeopleCounts();
      render();
    }
  });

  // Congestion handler
  inpConnCongestion.addEventListener('change', () => {
    if (!selected || selected.type !== 'connection') return;
    const conn = state.connections.find(c => c.id === selected.id);
    if (conn) { conn.congestion = inpConnCongestion.value; render(); }
  });

  // Add custom prop buttons
  document.getElementById('btnAddNodeProp').addEventListener('click', () => {
    if (!selected || selected.type !== 'node') return;
    const node = state.nodes.find(n => n.id === selected.id);
    if (!node) return;
    const key = `prop_${Object.keys(node.props).length + 1}`;
    node.props[key] = '';
    renderCustomProps(nodeCustomPropsDiv, node.props, 'node');
  });

  document.getElementById('btnAddConnProp').addEventListener('click', () => {
    if (!selected || selected.type !== 'connection') return;
    const conn = state.connections.find(c => c.id === selected.id);
    if (!conn) return;
    const key = `prop_${Object.keys(conn.props).length + 1}`;
    conn.props[key] = '';
    renderCustomProps(connCustomPropsDiv, conn.props, 'connection');
  });

  // ─── Type Manager ────────────────────────────────────────
  function renderTypeManager() {
    renderTypeList(nodeTypesList, state.nodeTypes, 'node');
    renderTypeList(connTypesList, state.connTypes, 'connection');
  }

  function renderTypeList(container, types, kind) {
    container.innerHTML = '';
    for (const t of types) {
      const item = document.createElement('div');
      item.className = 'type-item';
      item.innerHTML = `
        <div class="type-color" style="background:${t.color}" title="Click to change color"></div>
        <input type="color" class="type-color-input" value="${colorToHex(t.color)}">
        <input type="text" class="type-name" value="${escHtml(t.name)}">
        <button class="type-delete" title="Remove type">×</button>
      `;

      const colorSwatch = item.querySelector('.type-color');
      const colorInput = item.querySelector('.type-color-input');
      const nameInput = item.querySelector('.type-name');
      const deleteBtn = item.querySelector('.type-delete');

      colorSwatch.addEventListener('click', () => colorInput.click());
      colorInput.addEventListener('input', () => {
        t.color = colorInput.value;
        colorSwatch.style.background = t.color;
        render();
      });
      nameInput.addEventListener('change', () => {
        t.name = nameInput.value.trim() || t.name;
        render();
        updateSidebar();
      });
      deleteBtn.addEventListener('click', () => {
        if (types.length <= 1) return; // keep at least one
        const idx = types.indexOf(t);
        if (idx !== -1) types.splice(idx, 1);
        renderTypeManager();
        render();
        updateSidebar();
      });

      container.appendChild(item);
    }
  }

  document.getElementById('btnAddNodeType').addEventListener('click', () => {
    const hue = Math.floor(Math.random() * 360);
    state.nodeTypes.push({
      id: 'nt_' + uid(),
      name: 'New Type',
      color: `hsl(${hue}, 70%, 60%)`,
    });
    renderTypeManager();
    updateSidebar();
  });

  document.getElementById('btnAddConnType').addEventListener('click', () => {
    const hue = Math.floor(Math.random() * 360);
    state.connTypes.push({
      id: 'ct_' + uid(),
      name: 'New Type',
      color: `hsl(${hue}, 70%, 60%)`,
      dash: [],
    });
    renderTypeManager();
    updateSidebar();
  });

  // ─── Mouse Interactions ──────────────────────────────────
  let tempMouseWorld = null;

  function getConnectionHandlePos(conn) {
    const src = state.nodes.find(n => n.id === conn.sourceId);
    const tgt = state.nodes.find(n => n.id === conn.targetId);
    if (!src || !tgt) return null;

    const widthMeters = conn.width || 1.2;
    const pixelWidth = Math.max(2, widthMeters * PIXELS_PER_METER * cam.zoom);

    const s = worldToScreen(src.x, src.y);
    const e = worldToScreen(tgt.x, tgt.y);

    // Match drawing logic: 0.35
    const t = 0.35;
    const mx = s.x + (e.x - s.x) * t;
    const my = s.y + (e.y - s.y) * t;

    const dx = e.x - s.x;
    const dy = e.y - s.y;
    const len = Math.sqrt(dx * dx + dy * dy);
    if (len === 0) return { x: mx, y: my }; // should not happen

    const nx = -dy / len;
    const ny = dx / len;

    const handleDist = pixelWidth / 2 + 10;
    return {
      x: mx + nx * handleDist,
      y: my + ny * handleDist
    };
  }

  canvas.addEventListener('mousedown', (e) => {
    const rect = canvas.getBoundingClientRect();
    const sx = e.clientX - rect.left;
    const sy = e.clientY - rect.top;
    const w = screenToWorld(sx, sy);

    // Middle button or Ctrl+left => pan
    if (e.button === 1 || (e.button === 0 && (e.ctrlKey || e.metaKey))) {
      isPanning = true;
      panStart = { x: e.clientX - cam.x, y: e.clientY - cam.y };
      container.classList.add('panning');
      e.preventDefault();
      return;
    }

    if (e.button !== 0) return;

    // Check width handle click first (if connection selected)
    if (selected && selected.type === 'connection') {
      const conn = state.connections.find(c => c.id === selected.id);
      if (conn) {
        const hPos = getConnectionHandlePos(conn);
        if (hPos) {
          const d = Math.sqrt((sx - hPos.x) ** 2 + (sy - hPos.y) ** 2);
          if (d <= 8) { // 5 radius + margin
            dragging = { type: 'width', connId: conn.id };
            return;
          }
        }
      }
    }

    switch (tool) {
      case 'select': {
        const hitNode = hitTestNode(w.x, w.y);
        if (hitNode) {
          selectItem({ type: 'node', id: hitNode.id });
          dragging = {
            type: 'node',
            nodeId: hitNode.id,
            offsetX: w.x - hitNode.x,
            offsetY: w.y - hitNode.y,
          };
          container.classList.add('dragging-node');
        } else {
          const hitConn = hitTestConnection(w.x, w.y);
          if (hitConn) {
            selectItem({ type: 'connection', id: hitConn.id });
          } else {
            clearSelection();
          }
        }
        break;
      }
      case 'addNode': {
        // Check if clicking on a connection to split it
        const hitConn = hitTestConnectionWithPoint(w.x, w.y);
        if (hitConn) {
          const newNode = splitConnection(hitConn.conn, hitConn.proj.x, hitConn.proj.y);
          if (newNode) {
            selectItem({ type: 'node', id: newNode.id });
            render();
          }
        } else {
          // Otherwise create freestanding node
          createNode(w.x, w.y);
        }
        hideHint();
        break;
      }
      case 'connect': {
        const hitNode = hitTestNode(w.x, w.y);
        if (hitNode) {
          if (!connectSource) {
            connectSource = hitNode.id;
            render();
          } else {
            createConnection(connectSource, hitNode.id);
            connectSource = null;
          }
        } else {
          // T/X intersection: check if click is near a connection
          const hitConn = hitTestConnectionWithPoint(w.x, w.y);
          if (hitConn) {
            const newNode = splitConnection(hitConn.conn, hitConn.proj.x, hitConn.proj.y);
            if (newNode) {
              if (connectSource) {
                // Complete connection from source to the new split node
                createConnection(connectSource, newNode.id);
                connectSource = null;
              } else {
                // Start a connection from the new split node
                connectSource = newNode.id;
              }
              selectItem({ type: 'node', id: newNode.id });
              render();
            }
          } else {
            connectSource = null;
            render();
          }
        }
        break;
      }
      case 'delete': {
        const hitNode = hitTestNode(w.x, w.y);
        if (hitNode) { deleteNode(hitNode.id); return; }
        const hitConn = hitTestConnection(w.x, w.y);
        if (hitConn) deleteConnection(hitConn.id);
        break;
      }
    }
  });

  canvas.addEventListener('mousemove', (e) => {
    const rect = canvas.getBoundingClientRect();
    const sx = e.clientX - rect.left;
    const sy = e.clientY - rect.top;
    tempMouseWorld = screenToWorld(sx, sy);

    if (isPanning) {
      cam.x = e.clientX - panStart.x;
      cam.y = e.clientY - panStart.y;
      render();
      return;
    }

    if (dragging) {
      if (dragging.type === 'node') {
        const node = state.nodes.find(n => n.id === dragging.nodeId);
        if (node) {
          node.x = snapToGrid(tempMouseWorld.x - dragging.offsetX);
          node.y = snapToGrid(tempMouseWorld.y - dragging.offsetY);
          updateConnectionDistances();
          if (selected && selected.type === 'node' && selected.id === node.id) {
            inpNodeX.value = node.x;
            inpNodeY.value = node.y;
          }
          render();
        }
      } else if (dragging.type === 'width') {
        const conn = state.connections.find(c => c.id === dragging.connId);
        if (conn) {
          const src = state.nodes.find(n => n.id === conn.sourceId);
          const tgt = state.nodes.find(n => n.id === conn.targetId);
          if (src && tgt) {
            const s = worldToScreen(src.x, src.y);
            const e = worldToScreen(tgt.x, tgt.y);
            // Dist from point to line segment (unclamped infinite line is fine for width)
            // Actually standard layout is P to Line.
            // Let's use simple distance from center line
            // But we need signed distance or just magnitude?
            // Magnitude is fine, but we need to subtract the margin handle was at?
            // No, just set width based on distance from center * 2

            // Distance from mouse (sx,sy) to line (s)-(e)
            const A = sx - s.x;
            const B = sy - s.y;
            const C = e.x - s.x;
            const D = e.y - s.y;

            const dot = A * C + B * D;
            const lenSq = C * C + D * D;
            let param = -1;
            if (lenSq !== 0) param = dot / lenSq;

            let xx, yy;
            if (param < 0) {
              xx = s.x; yy = s.y;
            } else if (param > 1) {
              xx = e.x; yy = e.y;
            } else {
              xx = s.x + param * C;
              yy = s.y + param * D;
            }

            const dx = sx - xx;
            const dy = sy - yy;
            const distPx = Math.sqrt(dx * dx + dy * dy);

            // Radius is distPx. So width is distPx * 2. 
            // But handle is at edge + 10px padding.
            // So halfWidth = distPx - 10
            const halfWidthPx = Math.max(1, distPx - 10);
            const totalWidthPx = halfWidthPx * 2;

            // Convert back to meters
            const widthMeters = totalWidthPx / (PIXELS_PER_METER * cam.zoom);
            conn.width = Math.round(widthMeters * 10) / 10;
            if (conn.width < 0.1) conn.width = 0.1;

            inpConnWidth.value = conn.width;
            render();
          }
        }
      }
      return;
    }

    // Re-render when connecting to show temp line
    if (tool === 'connect' && connectSource) {
      render();
    }
  });

  canvas.addEventListener('mouseup', (e) => {
    if (isPanning) {
      isPanning = false;
      container.classList.remove('panning');
    }
    if (dragging) {
      dragging = null;
      container.classList.remove('dragging-node');
      updateConnectionDistances();
      updateSidebar();
    }
  });

  canvas.addEventListener('mouseleave', () => {
    if (dragging) {
      dragging = null;
      container.classList.remove('dragging-node');
    }
    tempMouseWorld = null;
  });

  // Zoom
  canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    const rect = canvas.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;

    const factor = e.deltaY < 0 ? 1.1 : 1 / 1.1;
    const newZoom = Math.max(0.1, Math.min(5, cam.zoom * factor));
    const ratio = newZoom / cam.zoom;

    cam.x = mx - (mx - cam.x) * ratio;
    cam.y = my - (my - cam.y) * ratio;
    cam.zoom = newZoom;

    document.getElementById('zoomLevel').textContent = Math.round(cam.zoom * 100) + '%';
    render();
  }, { passive: false });

  // ─── Keyboard Shortcuts ──────────────────────────────────
  document.addEventListener('keydown', (e) => {
    // Don't trigger shortcuts while typing
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT' || e.target.tagName === 'TEXTAREA') return;

    switch (e.key.toLowerCase()) {
      case 'v': setTool('select'); break;
      case 'n': setTool('addNode'); break;
      case 'c': setTool('connect'); break;
      case 'd': setTool('delete'); break;
      case 'delete':
      case 'backspace':
        if (selected) {
          if (selected.type === 'node') deleteNode(selected.id);
          else if (selected.type === 'connection') deleteConnection(selected.id);
        }
        break;
      case 'escape':
        clearSelection();
        connectSource = null;
        render();
        break;
    }
  });

  // ─── Tool Switching ──────────────────────────────────────
  function setTool(t) {
    tool = t;
    connectSource = null;
    document.querySelectorAll('.tool-btn').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.tool === t);
    });
    container.setAttribute('data-tool', t);
  }

  document.querySelectorAll('.tool-btn').forEach(btn => {
    btn.addEventListener('click', () => setTool(btn.dataset.tool));
  });

  // ─── Toolbar Actions ─────────────────────────────────────
  document.getElementById('btnClearAll').addEventListener('click', () => {
    if (state.nodes.length === 0 && state.connections.length === 0) return;
    if (!confirm('Clear all nodes and connections?')) return;
    state.nodes = [];
    state.connections = [];
    state.nextNodeId = 1;
    state.nextConnId = 1;
    clearSelection();
    render();
  });

  document.getElementById('btnExport').addEventListener('click', () => {
    const data = {
      nodes: state.nodes,
      connections: state.connections,
      nodeTypes: state.nodeTypes,
      connTypes: state.connTypes,
    };
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'graph.json';
    a.click();
    URL.revokeObjectURL(url);
  });

  document.getElementById('btnImport').addEventListener('click', () => {
    document.getElementById('importFile').click();
  });

  document.getElementById('importFile').addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
      try {
        const data = JSON.parse(ev.target.result);
        if (data.nodes) state.nodes = data.nodes;
        if (data.connections) state.connections = data.connections;
        if (data.nodeTypes) state.nodeTypes = data.nodeTypes;
        if (data.connTypes) state.connTypes = data.connTypes;
        state.nextNodeId = Math.max(0, ...state.nodes.map(n => n.id)) + 1;
        state.nextConnId = Math.max(0, ...state.connections.map(c => c.id)) + 1;
        clearSelection();
        renderTypeManager();
        render();
      } catch (err) {
        alert('Failed to import: ' + err.message);
      }
    };
    reader.readAsText(file);
    e.target.value = '';
  });

  // ─── Hint auto-hide ──────────────────────────────────────
  let hintHidden = false;
  function hideHint() {
    if (!hintHidden) {
      hint.style.opacity = '0';
      hintHidden = true;
      setTimeout(() => hint.style.display = 'none', 400);
    }
  }

  // ─── Init ────────────────────────────────────────────────
  function init() {
    // Load regulations
    fetch('regulations.json')
      .then(res => res.json())
      .then(data => {
        state.regulations = data;
        console.log('Regulations loaded:', data);
        recalcFireSafety();
        render(); // Re-render after load
      })
      .catch(err => console.error('Failed to load regulations:', err));

    // Center camera
    const rect = container.getBoundingClientRect();
    cam.x = rect.width / 2;
    cam.y = rect.height / 2;

    container.setAttribute('data-tool', tool);
    resizeCanvas();
    renderTypeManager();
    render();
  }

  // Wait for fonts
  if (document.fonts && document.fonts.ready) {
    document.fonts.ready.then(init);
  } else {
    window.addEventListener('load', init);
  }

  // Convert HSL colors to hex for type manager (when creating via random hue)
  // The canvas handles hsl() strings natively, so no conversion needed.
})();
