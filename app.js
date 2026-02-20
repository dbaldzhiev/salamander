/* ============================================================
   Node Graph Editor — app.js
   Interactive canvas-based graph editor with typed nodes,
   typed connections, and editable properties.
   ============================================================ */

(() => {
  'use strict';

  const DEFAULT_CONN_TYPES = [
    { id: 'normal', name: 'Normal', color: '#8b949e', dash: [] },
    { id: 'stairs_up', name: 'Stairs (Up)', color: '#d29922', dash: [5, 5] },
    { id: 'stairs_down', name: 'Stairs (Down)', color: '#a371f7', dash: [5, 5] },
  ];
  const ALLOWED_CONN_TYPE_IDS = new Set(DEFAULT_CONN_TYPES.map(t => t.id));
  const SALAMANDER_VERSION = '1.0.0';
  const SETTINGS_STORAGE_KEY = 'salamander.settings.v1';

  // ─── Data Model ───────────────────────────────────────────
  const state = {
    nodes: [],
    connections: [],
    nodeTypes: [
      { id: 'start', name: 'Start', color: '#3fb950' },   // Green
      { id: 'start2', name: 'Secondary Start', color: '#2da44e' },
      { id: 'exit', name: 'Exit', color: '#f85149' },    // Red
      { id: 'normal', name: 'Normal', color: '#8b949e' }, // Grey
      { id: 'waypoint', name: 'Waypoint', color: '#58a6ff' }, // Blue (Split)
      { id: 'door', name: 'Door Node', color: '#d29922' }, // Door node (rect)
    ],
    connTypes: DEFAULT_CONN_TYPES.map(t => ({ ...t, dash: [...(t.dash || [])] })),
    nextNodeId: 1,
    nextConnId: 1,
    regulations: null, // Loaded regulation data
    calculationMethod: 'B', // Default to Method B
    totalEvacuationTime: 0,
    metadata: {
      salamanderVersion: SALAMANDER_VERSION,
      author: '',
      company: '',
      project: '',
      dateTime: '',
      createdAt: '',
      exportedAt: '',
      notes: '',
    },
  };

  let appSettings = {
    defaultAuthor: '',
    defaultCompany: '',
  };

  // Editor State
  let tool = 'select'; // select, addNode, addDoor, connect, delete
  let selectedItems = new Set(); // Set of strings "{type}:{id}"
  let connectSource = null;
  let isPanning = false;
  let isDraggingNode = false;
  let dragging = null;
  let selectionBox = null;
  let dragStart = { x: 0, y: 0 };
  let lastMouse = { x: 0, y: 0 };
  let panStart = { x: 0, y: 0 };
  let cam = { x: 0, y: 0, zoom: 1 };
  const ZOOM_MIN = 0.1, ZOOM_MAX = 5;
  const HISTORY_LIMIT = 100;
  const historyStack = [];
  let historyIndex = -1;
  let lastHistorySignature = '';
  let applyingHistory = false;
  let orderGraphEnabled = false;
  let orderGraphRafId = null;
  let orderGraphDirty = false;

  // Constants
  const PIXELS_PER_METER = 30; // 1m = 30px, tuned for 20-30m schematics
  const GRID_SIZE_METERS = 0.1; // 10cm snapping for metric layout precision
  const GRID_SIZE = GRID_SIZE_METERS * PIXELS_PER_METER;

  const NODE_RADIUS = 15;
  const NODE_RADIUS_MIN_PX = 7;
  const NODE_RADIUS_MAX_PX = 32;
  const NODE_ZOOM_CURVE = 0.65;
  const HIT_MARGIN = 5;

  function snapToGrid(v) {
    return Math.round(v / GRID_SIZE) * GRID_SIZE;
  }

  // DOM Elements
  const container = document.getElementById('canvas-container');
  const canvas = document.getElementById('graphCanvas');
  const ctx = canvas.getContext('2d');
  const canvasHint = document.getElementById('canvas-hint');
  const btnZoomFit = document.getElementById('btnZoomFit');
  const zoomLevelDisplay = document.getElementById('zoomLevel');
  const btnMetadata = document.getElementById('btnMetadata');
  const btnSettings = document.getElementById('btnSettings');
  const btnOrderGraph = document.getElementById('btnOrderGraph');
  const btnRenumber = document.getElementById('btnRenumber');
  if (btnOrderGraph) btnOrderGraph.setAttribute('aria-pressed', 'false');

  // Properties Panel Elements
  const propsHeader = document.getElementById('properties-header');
  const propsContent = document.getElementById('properties-content');
  const sidebarEmpty = document.getElementById('sidebar-empty');
  const legendContent = document.getElementById('legend-content');

  // Bottom Panel
  const bottomPanel = document.getElementById('bottom-panel');
  const panelTabs = document.querySelectorAll('.panel-tab');
  const panelNodes = document.getElementById('panel-nodes');
  const panelConnections = document.getElementById('panel-connections');
  const panelRegulations = document.getElementById('panel-regulations');
  const nodesTableBody = document.querySelector('#panel-nodes tbody');
  const connectionsTableBody = document.querySelector('#panel-connections tbody');
  const regulationsContent = document.getElementById('regulations-content');

  const metadataModal = document.getElementById('metadata-modal');
  const btnCloseMetadata = document.getElementById('btnCloseMetadata');
  const btnSaveMetadata = document.getElementById('btnSaveMetadata');
  const metaVersionInput = document.getElementById('metaVersion');
  const metaAuthorInput = document.getElementById('metaAuthor');
  const metaCompanyInput = document.getElementById('metaCompany');
  const metaProjectInput = document.getElementById('metaProject');
  const metaDateTimeInput = document.getElementById('metaDateTime');
  const metaCreatedAtInput = document.getElementById('metaCreatedAt');
  const metaExportedAtInput = document.getElementById('metaExportedAt');
  const metaNotesInput = document.getElementById('metaNotes');

  const settingsModal = document.getElementById('settings-modal');
  const btnCloseSettings = document.getElementById('btnCloseSettings');
  const btnSaveSettings = document.getElementById('btnSaveSettings');
  const settingsDefaultAuthorInput = document.getElementById('settingsDefaultAuthor');
  const settingsDefaultCompanyInput = document.getElementById('settingsDefaultCompany');

  // Calculation UI
  const methodRadios = document.querySelectorAll('input[name="calcMethod"]');
  const totalTimeDisplay = document.getElementById('totalTime');
  let calcMethod = 'A'; // 'A' or 'B'

  methodRadios.forEach(r => {
    r.addEventListener('change', (e) => {
      state.calculationMethod = e.target.value;
      recalcFireSafety();
      render();
    });
  });

  // ... (Keep splitConnection, createConnection updates below)





  // ─── Helpers ──────────────────────────────────────────────
  const dist = (a, b) => Math.sqrt((a.x - b.x) ** 2 + (a.y - b.y) ** 2);
  const lerp = (a, b, t) => a + (b - a) * t;
  const uid = () => Math.random().toString(36).slice(2, 9);
  const clamp = (v, min, max) => Math.max(min, Math.min(max, v));
  const roundDistanceMeters = (m) => Math.round(m * 20) / 20; // 0.05m precision
  const roundWidthMeters = (m) => Math.round(m * 20) / 20; // 0.05m precision

  function getNodeRadiusPx(zoom = cam.zoom) {
    const scaled = NODE_RADIUS * Math.pow(Math.max(zoom, 0.01), NODE_ZOOM_CURVE);
    return Math.max(NODE_RADIUS_MIN_PX, Math.min(NODE_RADIUS_MAX_PX, scaled));
  }

  function getDoorWidthFactor(node) {
    return Math.max(0.4, Math.min(3, (node.width || 1.2) / 1.2));
  }

  function getDoorAxisAngle(node) {
    const incident = state.connections.filter(c => c.sourceId === node.id || c.targetId === node.id);
    if (incident.length === 0) return Math.PI / 2;

    const neighborIds = Array.from(new Set(incident.map(c => (c.sourceId === node.id ? c.targetId : c.sourceId))));
    const neighbors = neighborIds
      .map(id => state.nodes.find(n => n.id === id))
      .filter(Boolean);

    if (neighbors.length === 0) return Math.PI / 2;

    if (neighbors.length === 1) {
      const vAng = Math.atan2(neighbors[0].y - node.y, neighbors[0].x - node.x);
      return vAng + Math.PI / 2;
    }

    // Use the farthest neighbor pair as the primary corridor vector.
    let bestA = neighbors[0];
    let bestB = neighbors[1];
    let bestDistSq = -1;
    for (let i = 0; i < neighbors.length; i++) {
      for (let j = i + 1; j < neighbors.length; j++) {
        const dx = neighbors[j].x - neighbors[i].x;
        const dy = neighbors[j].y - neighbors[i].y;
        const d2 = dx * dx + dy * dy;
        if (d2 > bestDistSq) {
          bestDistSq = d2;
          bestA = neighbors[i];
          bestB = neighbors[j];
        }
      }
    }

    if (bestDistSq <= 0) {
      const fallbackAng = Math.atan2(bestA.y - node.y, bestA.x - node.x);
      return fallbackAng + Math.PI / 2;
    }

    const corridorAng = Math.atan2(bestB.y - bestA.y, bestB.x - bestA.x);
    return corridorAng + Math.PI / 2;
  }

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

  function cloneData(v) {
    return JSON.parse(JSON.stringify(v));
  }

  function toLocalDateTimeValue(date = new Date()) {
    const pad = (n) => String(n).padStart(2, '0');
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
  }

  function normalizeMetadata(meta = {}) {
    const now = toLocalDateTimeValue();
    return {
      salamanderVersion: String(meta.salamanderVersion || SALAMANDER_VERSION),
      author: String(meta.author || ''),
      company: String(meta.company || ''),
      project: String(meta.project || ''),
      dateTime: String(meta.dateTime || now),
      createdAt: String(meta.createdAt || now),
      exportedAt: String(meta.exportedAt || ''),
      notes: String(meta.notes || ''),
    };
  }

  function applySettingsDefaultsToMetadata() {
    if (!state.metadata.author && appSettings.defaultAuthor) {
      state.metadata.author = appSettings.defaultAuthor;
    }
    if (!state.metadata.company && appSettings.defaultCompany) {
      state.metadata.company = appSettings.defaultCompany;
    }
    if (!state.metadata.salamanderVersion) {
      state.metadata.salamanderVersion = SALAMANDER_VERSION;
    }
    if (!state.metadata.dateTime) {
      state.metadata.dateTime = toLocalDateTimeValue();
    }
    if (!state.metadata.createdAt) {
      state.metadata.createdAt = toLocalDateTimeValue();
    }
  }

  function loadSettingsFromStorage() {
    try {
      const raw = localStorage.getItem(SETTINGS_STORAGE_KEY);
      if (!raw) return;
      const data = JSON.parse(raw);
      appSettings.defaultAuthor = String(data.defaultAuthor || '');
      appSettings.defaultCompany = String(data.defaultCompany || '');
    } catch (err) {
      console.warn('Settings load from localStorage failed:', err);
    }
  }

  function saveSettingsToStorage() {
    const payload = {
      defaultAuthor: appSettings.defaultAuthor || '',
      defaultCompany: appSettings.defaultCompany || '',
    };
    try {
      localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(payload));
      return true;
    } catch (err) {
      console.warn('Settings save to localStorage failed:', err);
      return false;
    }
  }

  function normalizeConnectionTypes() {
    const safeConnTypes = Array.isArray(state.connTypes) ? state.connTypes : [];
    state.connTypes = DEFAULT_CONN_TYPES.map((base) => {
      const match = safeConnTypes.find(t => t && t.id === base.id);
      if (!match) return { ...base, dash: [...(base.dash || [])] };
      return {
        ...base,
        ...match,
        id: base.id,
        dash: Array.isArray(match.dash) ? [...match.dash] : [...(base.dash || [])],
      };
    });

    const fallbackTypeId = state.connTypes[0]?.id || 'normal';
    state.connections.forEach((c) => {
      if (!ALLOWED_CONN_TYPE_IDS.has(c.typeId)) {
        c.typeId = fallbackTypeId;
      }
    });
  }

  function snapshotState() {
    return {
      nodes: cloneData(state.nodes),
      connections: cloneData(state.connections),
      nodeTypes: cloneData(state.nodeTypes),
      connTypes: cloneData(state.connTypes),
      metadata: cloneData(state.metadata),
      nextNodeId: state.nextNodeId,
      nextConnId: state.nextConnId,
      calculationMethod: state.calculationMethod,
      selectedItems: Array.from(selectedItems),
      connectSource,
    };
  }

  function applySnapshot(snap) {
    applyingHistory = true;
    state.nodes = cloneData(snap.nodes || []);
    state.connections = cloneData(snap.connections || []);
    state.nodeTypes = cloneData(snap.nodeTypes || state.nodeTypes);
    state.connTypes = cloneData(snap.connTypes || state.connTypes);
    state.metadata = normalizeMetadata(snap.metadata || state.metadata);
    normalizeConnectionTypes();
    applySettingsDefaultsToMetadata();
    state.nextNodeId = snap.nextNodeId || 1;
    state.nextConnId = snap.nextConnId || 1;
    state.calculationMethod = snap.calculationMethod || state.calculationMethod;
    selectedItems = new Set(snap.selectedItems || []);
    connectSource = snap.connectSource || null;
    if (connectSource && !state.nodes.some(n => n.id === connectSource)) {
      connectSource = null;
    }
    const methodRadio = document.querySelector(`input[name="calcMethod"][value="${state.calculationMethod}"]`);
    if (methodRadio) methodRadio.checked = true;
    recalcPeopleCounts();
    renderLegend();
    updatePropertiesPanel();
    render();
    applyingHistory = false;
  }

  function commitHistory() {
    if (applyingHistory) return;
    const snap = snapshotState();
    const signature = JSON.stringify(snap);
    if (signature === lastHistorySignature) return;

    if (historyIndex < historyStack.length - 1) {
      historyStack.splice(historyIndex + 1);
    }
    historyStack.push(snap);
    if (historyStack.length > HISTORY_LIMIT) {
      historyStack.shift();
    }
    historyIndex = historyStack.length - 1;
    lastHistorySignature = signature;
  }

  function undoHistory() {
    if (historyIndex <= 0) return;
    historyIndex -= 1;
    applySnapshot(historyStack[historyIndex]);
    lastHistorySignature = JSON.stringify(historyStack[historyIndex]);
  }

  function redoHistory() {
    if (historyIndex >= historyStack.length - 1) return;
    historyIndex += 1;
    applySnapshot(historyStack[historyIndex]);
    lastHistorySignature = JSON.stringify(historyStack[historyIndex]);
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

  function setZoomLevelDisplay() {
    if (zoomLevelDisplay) {
      zoomLevelDisplay.textContent = `${Math.round(cam.zoom * 100)}%`;
    }
  }

  function zoomToFitGraph(options = {}) {
    const { paddingPx = 56, skipRender = false } = options;
    const rect = canvas.getBoundingClientRect();
    if (rect.width <= 2 || rect.height <= 2) return;

    if (state.nodes.length === 0) {
      cam.zoom = 1;
      cam.x = rect.width / 2;
      cam.y = rect.height / 2;
      setZoomLevelDisplay();
      if (!skipRender) render();
      return;
    }

    const bounds = computeGraphBoundsWorld(state.nodes);
    const padWorld = PIXELS_PER_METER * 0.9;
    const minX = bounds.minX - padWorld;
    const maxX = bounds.maxX + padWorld;
    const minY = bounds.minY - padWorld;
    const maxY = bounds.maxY + padWorld;

    const spanW = Math.max(1, maxX - minX);
    const spanH = Math.max(1, maxY - minY);
    const usableW = Math.max(10, rect.width - paddingPx * 2);
    const usableH = Math.max(10, rect.height - paddingPx * 2);
    const fitZoom = clamp(Math.min(usableW / spanW, usableH / spanH), ZOOM_MIN, ZOOM_MAX);

    const centerX = (minX + maxX) * 0.5;
    const centerY = (minY + maxY) * 0.5;
    cam.zoom = fitZoom;
    cam.x = rect.width * 0.5 - centerX * cam.zoom;
    cam.y = rect.height * 0.5 - centerY * cam.zoom;
    setZoomLevelDisplay();
    if (!skipRender) render();
  }

  function runOrderGraphIterations(maxIterations = 180) {
    if (state.connections.length === 0 || state.nodes.length < 2) return false;
    let changed = false;
    for (let i = 0; i < maxIterations; i++) {
      const stepChanged = orderGraphStep();
      if (!stepChanged) break;
      changed = true;
    }
    if (changed) updateConnectionDistances();
    return changed;
  }

  // ─── Fire Safety Calculations ─────────────────────────────

  function getSegmentParams(conn) {
    if (!state.regulations) return null;

    // Map connection type to regulations type
    let type = 'horiz'; // Default
    if (conn.typeId === 'stairs_up') type = 'stair_up';
    else if (conn.typeId === 'stairs_down') type = 'stair_down';

    // Get dimensions and flow
    // Width: use direct property (conn.width) if available and valid
    let width = (conn.width !== undefined && conn.width !== null) ? Number(conn.width) : 1.2;
    if (isNaN(width) || width <= 0) width = 1.2;
    width = Math.max(0.05, roundWidthMeters(width));
    // Keep state in sync with the rounded width
    conn.width = width;
    // Fallback to props.width if conn.width failed? No, UI sets conn.width.

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

  function getLimitParams(typeId) {
    if (!state.regulations || !state.regulations.limits) return { q_max: 164, q_gran: 135, v_gran: 14 };

    const limits = state.regulations.limits;
    let grp = limits.horizontal;
    if (typeId === 'stairs_up' || typeId === 'stair_up') grp = limits.stairs_up;
    else if (typeId === 'stairs_down' || typeId === 'stair_down') grp = limits.stairs_down;

    return {
      q_max: grp.q_max,
      q_gran: grp.q_gran,
      v_gran: grp.v_gran
    };
  }

  function sortConnectionsTopologically() {
    // Basic Kahn's algorithm or DFS based on graph structure
    // We need to order connections so we process upstream before downstream

    // 1. Build adjacency
    const adj = new Map();
    state.nodes.forEach(n => adj.set(n.id, []));
    state.connections.forEach(c => {
      if (!adj.has(c.sourceId)) adj.set(c.sourceId, []);
      adj.get(c.sourceId).push(c);
    });

    // 2. Compute in-degree for CONNECTIONS?
    // Actually we need to traverse from Start Nodes.
    // Let's do a BFS/Traversal from all Start nodes.

    const sorted = [];
    const visited = new Set();
    const queue = [];

    // Find start nodes
    const startNodes = state.nodes.filter(n => ['start', 'start2'].includes(n.typeId));
    startNodes.forEach(n => {
      if (adj.has(n.id)) {
        adj.get(n.id).forEach(c => {
          if (!visited.has(c.id)) {
            visited.add(c.id);
            queue.push(c);
          }
        });
      }
    });

    // This simple BFS might not respect true topology if there are merges where one branch is longer.
    // Standard approach: Assign "order" to nodes.
    // Let's stick to the existing propagation logic in 'propagateMaxTime' which was repeated pass.
    // BUT for flow propagation, we need rigorous order.

    // Alternative: Kahn's algo on the graph of segments.
    // Node In-Degree.
    const nodeInDegree = new Map();
    state.nodes.forEach(n => nodeInDegree.set(n.id, 0));
    state.connections.forEach(c => {
      const d = nodeInDegree.get(c.targetId) || 0;
      nodeInDegree.set(c.targetId, d + 1);
    });

    const nodeQueue = state.nodes.filter(n => (nodeInDegree.get(n.id) || 0) === 0);
    const sortedNodes = [];

    while (nodeQueue.length > 0) {
      const n = nodeQueue.shift();
      sortedNodes.push(n);

      const outConns = state.connections.filter(c => c.sourceId === n.id);
      outConns.forEach(c => {
        const tgtId = c.targetId;
        nodeInDegree.set(tgtId, (nodeInDegree.get(tgtId) || 0) - 1);
        if (nodeInDegree.get(tgtId) === 0) {
          const tgtNode = state.nodes.find(x => x.id === tgtId);
          if (tgtNode) nodeQueue.push(tgtNode);
        }
      });
    }

    // If graph has cycles, some nodes won't be in sortedNodes.
    // Fallback: add remaining nodes.
    state.nodes.forEach(n => {
      if (!sortedNodes.includes(n)) sortedNodes.push(n);
    });

    // Now flatten to connections
    const sortedConns = [];
    sortedNodes.forEach(n => {
      const out = state.connections.filter(c => c.sourceId === n.id);
      sortedConns.push(...out);
    });

    return sortedConns;
  }

  function getLimitParams(typeId) {
    if (!state.regulations || !state.regulations.limits) return { q_max: 164, q_gran: 135, v_gran: 14 };

    const limits = state.regulations.limits;
    let grp = limits.horizontal;
    if (typeId === 'stairs_up') grp = limits.stairs_up;
    else if (typeId === 'stairs_down') grp = limits.stairs_down;

    return {
      q_max: grp.q_max,
      q_gran: grp.q_gran,
      v_gran: grp.v_gran
    };
  }

  function sortConnectionsTopologically() {
    // Basic Kahn's algorithm or DFS based on graph structure
    // We need to order connections so we process upstream before downstream

    // 1. Build adjacency
    const adj = new Map();
    state.nodes.forEach(n => adj.set(n.id, []));
    state.connections.forEach(c => {
      if (!adj.has(c.sourceId)) adj.set(c.sourceId, []);
      adj.get(c.sourceId).push(c);
    });

    // 2. Compute in-degree for CONNECTIONS?
    // Actually we need to traverse from Start Nodes.
    // Let's do a BFS/Traversal from all Start nodes.

    const sorted = [];
    const visited = new Set();
    const queue = [];

    // Find start nodes
    const startNodes = state.nodes.filter(n => ['start', 'start2'].includes(n.typeId));
    startNodes.forEach(n => {
      if (adj.has(n.id)) {
        adj.get(n.id).forEach(c => {
          if (!visited.has(c.id)) {
            visited.add(c.id);
            queue.push(c);
          }
        });
      }
    });

    // This simple BFS might not respect true topology if there are merges where one branch is longer.
    // Standard approach: Assign "order" to nodes.
    // Let's stick to the existing propagation logic in 'propagateMaxTime' which was repeated pass.
    // BUT for flow propagation, we need rigorous order.

    // Alternative: Kahn's algo on the graph of segments.
    // Node In-Degree.
    const nodeInDegree = new Map();
    state.nodes.forEach(n => nodeInDegree.set(n.id, 0));
    state.connections.forEach(c => {
      const d = nodeInDegree.get(c.targetId) || 0;
      nodeInDegree.set(c.targetId, d + 1);
    });

    const nodeQueue = state.nodes.filter(n => (nodeInDegree.get(n.id) || 0) === 0);
    const sortedNodes = [];

    while (nodeQueue.length > 0) {
      const n = nodeQueue.shift();
      sortedNodes.push(n);

      const outConns = state.connections.filter(c => c.sourceId === n.id);
      outConns.forEach(c => {
        const tgtId = c.targetId;
        nodeInDegree.set(tgtId, (nodeInDegree.get(tgtId) || 0) - 1);
        if (nodeInDegree.get(tgtId) === 0) {
          const tgtNode = state.nodes.find(x => x.id === tgtId);
          if (tgtNode) nodeQueue.push(tgtNode);
        }
      });
    }

    // If graph has cycles, some nodes won't be in sortedNodes.
    // Fallback: add remaining nodes.
    state.nodes.forEach(n => {
      if (!sortedNodes.includes(n)) sortedNodes.push(n);
    });

    // Now flatten to connections
    const sortedConns = [];
    sortedNodes.forEach(n => {
      const out = state.connections.filter(c => c.sourceId === n.id);
      sortedConns.push(...out);
    });

    return sortedConns;
  }

  function calcMethodA() {
    // Method A: Sum of travel times (Length / Speed)
    state.connections.forEach(conn => {
      const p = getSegmentParams(conn);
      if (!p) { conn.travelTime = 0; return; }

      const area = p.length * p.width;
      const density = area > 0 ? p.people / area : 0;

      const { v } = lookupTable11(p.type, density);

      // Time in minutes = Length (m) / Speed (m/min)
      // If speed is 0, time is infinite? Or blocked.
      // For static calc, if v=0, usually means blocked.
      conn.travelTime = v > 0.1 ? p.length / v : 9999;

      conn.calcStats = { density, v, q: 0, time: conn.travelTime, method: 'A' };
    });

    propagateMaxTime();
  }

  function calcMethodB() {
    // Method B: Capacity / Throughput (Number of People / (Specific Throughput * Width))
    // t = N / Q, where Q = q * w

    // Reset state: congestion, time, temporary flow tracking
    state.connections.forEach(c => {
      c.congestion = 'none';
      c.travelTime = 0;
      c.flowState = { Q_in: 0, q_spec: 0, Q_out: 0, hasQueue: false };
    });

    // 2. Topological Sort to ensure upstream is processed first
    const sortedConns = sortConnectionsTopologically();

    sortedConns.forEach(conn => {
      const src = state.nodes.find(n => n.id === conn.sourceId);
      const p = getSegmentParams(conn);
      if (!p || !src) return;

      let q_curr = 0;   // Specific flow (p/m/min)
      let Q_curr = 0;   // Total flow (p/min)
      let v_curr = 0;   // Speed (m/min)

      // --- Step 1: Determine Incoming Flow ---
      const incomingConns = state.connections.filter(c => c.targetId === conn.sourceId);
      const isInitial = incomingConns.length === 0 || ['start', 'start2'].includes(src.typeId);

      if (isInitial) {
        // Initial: Compute from Density (D = N/A)
        const area = p.length * p.width;
        const density = area > 0 ? (src.people || 0) / area : 0;
        const table = lookupTable11(p.type, density);
        v_curr = table.v;
        q_curr = table.q;
        Q_curr = q_curr * p.width;

        // Formula 1: t = L / v
        conn.travelTime = v_curr > 0.1 ? p.length / v_curr : 0;
      } else {
        // Downstream: Propagate Flow (Sum of Q_prev)
        let Q_total_in = 0;
        incomingConns.forEach(inc => {
          Q_total_in += (inc.flowState ? inc.flowState.Q_out : 0);
        });

        // Distribute flow if branching (proportional to width)
        const outConns = state.connections.filter(c => c.sourceId === conn.sourceId);
        const totalOutWidth = outConns.reduce((sum, c) => sum + (parseFloat(c.props.width) || 1.2), 0);
        const ratio = totalOutWidth > 0 ? (p.width / totalOutWidth) : 1;

        Q_curr = Q_total_in * ratio;
        q_curr = p.width > 0 ? Q_curr / p.width : 0;
      }

      // --- Step 2: Bottleneck Check & Queue Handling ---
      const limits = getLimitParams(p.type);
      const q_max = limits.q_max;

      let hasQueue = false;
      let final_Q_out = Q_curr;

      if (q_curr > q_max) {
        // Case B: Queue Forms
        hasQueue = true;
        conn.congestion = 'blocked';

        // Formula 2 (Norm 2, pg 6):
        // t = (L / v_gran) + N * (1/Q_out - 1/Q_in)

        const N_total = p.people || 0;
        const Q_out = p.width * limits.q_gran;
        const Q_in = Q_curr;

        // Norm 2 Clause I.11 Dynamic Reduction
        // Instead of v_free (100 m/min), we use the actual speed based on density (D = N/A).
        // This gives a more realistic "Time to Cross" for the population.

        const area = p.length * p.width;
        const density = area > 0 ? (p.people || 0) / area : 0;
        const table = lookupTable11(p.type, density);
        const v_density = table.v > 0.1 ? table.v : 100; // Fallback to 100 if v=0 (jammed? no, v=0 at high D)

        // Time to cross for the group
        const t_filling = (p.length / v_density);

        const N_out = Q_out * t_filling;
        const N_eff = Math.max(0, N_total - N_out);

        // Store for report
        conn.dynamicStats = { N_total, t_filling, N_out, N_eff, v_density, density };

        // Travel Term (now t_filling)
        let travelTerm = t_filling;

        // Delay Term
        let delayTerm = 0;
        if (Q_out > 0.1 && Q_in > 0.1) {
          // If Q_in > Q_out, we have a bottleneck delay
          // The formula technically subtracts arrival rate.
          // t = L/v + N*(1/Q_out - 1/Q_in)
          // If N is large, this term dominates.
          // If Q_in is very large (instant arrival), 1/Q_in -> 0.
          const val = (1 / Q_out) - (1 / Q_in);
          // Ensure term is non-negative?
          // If Q_in < Q_out (no queue should form), but check logic says q > q_max.
          // q > q_max implies Q_in/w > q_max.
          // Q_out = w * q_gran.
          // Usually q_gran < q_max. So Q_in might be > Q_out.
          delayTerm = N_eff * Math.max(0, val);
        } else if (Q_out > 0.1) {
          // Fallback if Q_in is 0? 
          delayTerm = N_total / Q_out;
        }

        conn.travelTime = travelTerm + delayTerm;

        // Propagate BOUNDARY flow downstream
        final_Q_out = Q_out;

      } else {
        // Case A: No Queue
        conn.congestion = 'none';
        final_Q_out = Q_curr;

        if (!isInitial) {
          // Determine speed from q_curr (Conservative lookup)
          const tableData = state.regulations.table_11_flow_params.data;
          // Find row where table_q >= q_curr
          let row = tableData.find(r => {
            const cell = (r[p.type] || r['horiz']);
            return cell.q >= q_curr;
          });
          if (!row) row = tableData[tableData.length - 1];

          const cell = (row[p.type === 'horiz' ? 'horiz' : p.type] || row['horiz']);
          v_curr = cell.v || 100;

          conn.travelTime = v_curr > 0.1 ? p.length / v_curr : 0;
        }
      }

      // Store state for downstream
      conn.flowState = {
        Q_in: Q_curr,
        q_spec: q_curr,
        Q_out: final_Q_out,
        hasQueue: hasQueue
      };

      conn.calcStats = {
        density: 0,
        v: v_curr,
        q: q_curr,
        Q: Q_curr,
        time: conn.travelTime,
        method: 'B',
        q_max: q_max,
        q_gran: limits.q_gran,
        v_gran: limits.v_gran
      };
    });

    propagateMaxTime();
  }

  function propagateMaxTime() {
    // Reset maxTime
    state.nodes.forEach(n => n.maxTime = 0);

    // Initial time at Source nodes?
    // Usually 0 unless start delay.

    // Topological sort or multi-pass
    for (let pass = 0; pass < state.nodes.length + 1; pass++) {
      let changed = false;
      for (const conn of state.connections) {
        const src = state.nodes.find(n => n.id === conn.sourceId);
        const tgt = state.nodes.find(n => n.id === conn.targetId);
        if (!src || !tgt) continue;

        // Cumulative time
        const newTime = (src.maxTime || 0) + (conn.travelTime || 0);
        if (newTime > (tgt.maxTime || 0)) {
          tgt.maxTime = newTime;
          changed = true;
        }
      }
      if (!changed) break;
    }

    // Total time is the max of all Exit nodes
    const exitNodes = state.nodes.filter(n => n.typeId === 'exit');
    let maxT = 0;
    if (exitNodes.length > 0) {
      maxT = Math.max(...exitNodes.map(n => n.maxTime));
    } else {
      maxT = Math.max(...state.nodes.map(n => n.maxTime), 0);
    }
    state.totalEvacuationTime = maxT;
  }

  function recalcFireSafety() {
    if (!state.regulations) return;

    if (state.calculationMethod === 'A') {
      calcMethodA();
    } else {
      calcMethodB();
    }

    // Update Display
    if (totalTimeDisplay) {
      totalTimeDisplay.textContent = state.totalEvacuationTime.toFixed(3);
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

    drawSelectionBox();
    drawCanvasInfoOverlay(w, h);
    drawMetadataOverlay(w, h);

    // Update Table
    renderTable();
  }

  function computeGraphBoundsWorld(nodes = state.nodes) {
    if (!Array.isArray(nodes) || nodes.length === 0) {
      return {
        minX: 0,
        maxX: 0,
        minY: 0,
        maxY: 0,
        widthPx: 0,
        heightPx: 0,
        widthM: 0,
        heightM: 0,
      };
    }

    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    nodes.forEach((n) => {
      minX = Math.min(minX, n.x);
      maxX = Math.max(maxX, n.x);
      minY = Math.min(minY, n.y);
      maxY = Math.max(maxY, n.y);
    });

    const widthPx = Math.max(0, maxX - minX);
    const heightPx = Math.max(0, maxY - minY);
    return {
      minX,
      maxX,
      minY,
      maxY,
      widthPx,
      heightPx,
      widthM: roundDistanceMeters(widthPx / PIXELS_PER_METER),
      heightM: roundDistanceMeters(heightPx / PIXELS_PER_METER),
    };
  }

  function getCanvasInsights() {
    const bounds = computeGraphBoundsWorld(state.nodes);
    const counts = {
      start: 0,
      start2: 0,
      exit: 0,
      door: 0,
      waypoint: 0,
      other: 0,
    };

    state.nodes.forEach((n) => {
      if (Object.prototype.hasOwnProperty.call(counts, n.typeId)) counts[n.typeId] += 1;
      else counts.other += 1;
    });

    const totalPeople = state.nodes.reduce((acc, n) => {
      if (n.typeId === 'start' || n.typeId === 'start2') return acc + (Number(n.people) || 0);
      return acc;
    }, 0);

    const blockedCount = state.connections.filter(c => c.congestion === 'blocked').length;
    const queueCount = state.connections.filter(c => c.flowState && c.flowState.hasQueue).length;
    const bottleneckCount = state.connections.filter(c => c.congestion === 'blocked' || (c.flowState && c.flowState.hasQueue)).length;
    const pinnedCount = state.nodes.reduce((sum, n) => sum + (n.pinned ? 1 : 0), 0);
    const exits = state.nodes.filter(n => n.typeId === 'exit');
    const criticalExits = exits.filter(n => Math.abs((Number(n.maxTime) || 0) - (Number(state.totalEvacuationTime) || 0)) < 0.01).length;
    const modeLabel = tool === 'addNode' ? 'Add Node' :
      tool === 'addDoor' ? 'Add Door' :
        tool === 'connect' ? 'Connect' :
          tool === 'delete' ? 'Delete' : 'Select';
    const methodLabel = state.calculationMethod === 'B' ? 'Method B' : 'Method A';

    return {
      bounds,
      counts,
      totalPeople,
      blockedCount,
      queueCount,
      bottleneckCount,
      pinnedCount,
      criticalExits,
      modeLabel,
      methodLabel,
      selectedCount: selectedItems.size,
      connectionCount: state.connections.length,
      totalTime: state.totalEvacuationTime || 0,
    };
  }

  function drawCanvasInfoOverlay(w, h) {
    const info = getCanvasInsights();
    const projectName = (state.metadata && state.metadata.project) ? state.metadata.project : 'Untitled';
    const lines = [
      `Project: ${projectName} | Method: ${info.methodLabel}`,
      `Mode: ${info.modeLabel} | Order Graph: ${orderGraphEnabled ? 'ON' : 'OFF'} | Zoom: ${Math.round(cam.zoom * 100)}%`,
      `Nodes: ${state.nodes.length} (Start ${info.counts.start + info.counts.start2}, Exit ${info.counts.exit}, Door ${info.counts.door}, Waypoint ${info.counts.waypoint}, Pinned ${info.pinnedCount})`,
      `Connections: ${info.connectionCount} | Bottlenecks: ${info.bottleneckCount} | Blocked: ${info.blockedCount} | Queues: ${info.queueCount}`,
      `Total People: ${info.totalPeople} | Evac Time: ${info.totalTime.toFixed(3)} min | Critical Exits: ${info.criticalExits}`,
      `Graph Size: ${info.bounds.widthM.toFixed(2)}m x ${info.bounds.heightM.toFixed(2)}m | Selection: ${info.selectedCount} item${info.selectedCount === 1 ? '' : 's'}`,
    ];

    ctx.save();
    ctx.font = '12px Inter, sans-serif';
    const padding = 10;
    const lineHeight = 16;
    const boxW = Math.max(...lines.map(line => ctx.measureText(line).width), 340) + padding * 2;
    const boxH = lines.length * lineHeight + padding * 2;
    const x = 14;
    const y = h - boxH - 14;

    ctx.fillStyle = 'rgba(22,27,34,0.92)';
    ctx.strokeStyle = 'rgba(48,54,61,0.95)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.roundRect(x, y, boxW, boxH, 8);
    ctx.fill();
    ctx.stroke();

    ctx.fillStyle = '#e6edf3';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    lines.forEach((line, idx) => {
      ctx.fillText(line, x + padding, y + padding + idx * lineHeight);
    });
    ctx.restore();
  }

  function drawMetadataOverlay(w, h) {
    const meta = state.metadata || {};
    const lines = [];
    lines.push(`Project: ${meta.project || 'Untitled'}`);
    lines.push(`Author: ${meta.author || '-'}`);
    lines.push(`Company: ${meta.company || '-'}`);
    lines.push(`Date: ${meta.dateTime || '-'}`);
    lines.push(`Created: ${meta.createdAt || '-'}`);
    lines.push(`Exported: ${meta.exportedAt || '-'}`);
    lines.push(`Version: ${meta.salamanderVersion || SALAMANDER_VERSION}`);
    if (meta.notes) {
      const compact = meta.notes.replace(/\s+/g, ' ').trim();
      const clipped = compact.length > 90 ? `${compact.slice(0, 87)}...` : compact;
      lines.push(`Notes: ${clipped}`);
    }

    ctx.save();
    ctx.font = '12px Inter, sans-serif';
    const padding = 10;
    const lineHeight = 16;
    const textWidths = lines.map(line => ctx.measureText(line).width);
    const boxW = Math.max(230, ...textWidths) + padding * 2;
    const boxH = lines.length * lineHeight + padding * 2;
    const x = w - boxW - 14;
    const y = 14;

    ctx.fillStyle = 'rgba(22,27,34,0.92)';
    ctx.strokeStyle = 'rgba(48,54,61,0.95)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.roundRect(x, y, boxW, boxH, 8);
    ctx.fill();
    ctx.stroke();

    ctx.fillStyle = '#e6edf3';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    lines.forEach((line, idx) => {
      ctx.fillText(line, x + padding, y + padding + idx * lineHeight);
    });
    ctx.restore();
  }

  function drawSelectionBox() {
    if (!selectionBox) return;
    const x = Math.min(selectionBox.startX, selectionBox.endX);
    const y = Math.min(selectionBox.startY, selectionBox.endY);
    const w = Math.abs(selectionBox.endX - selectionBox.startX);
    const h = Math.abs(selectionBox.endY - selectionBox.startY);
    if (w < 1 && h < 1) return;

    ctx.save();
    ctx.fillStyle = 'rgba(88,166,255,0.16)';
    ctx.strokeStyle = 'rgba(88,166,255,0.9)';
    ctx.lineWidth = 1;
    ctx.setLineDash([6, 4]);
    ctx.fillRect(x, y, w, h);
    ctx.strokeRect(x, y, w, h);
    ctx.restore();
  }

  function drawGrid(w, h) {
    // Use global GRID_SIZE
    const gridSize = GRID_SIZE;
    const scaledGrid = gridSize * cam.zoom;

    if (scaledGrid < 4) return; // too zoomed out

    const offsetX = cam.x % scaledGrid;
    const offsetY = cam.y % scaledGrid;

    ctx.beginPath();
    ctx.strokeStyle = 'rgba(48,54,61,.35)';
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
    if (majorGrid >= 24) {
      const majorOffX = cam.x % majorGrid;
      const majorOffY = cam.y % majorGrid;
      ctx.beginPath();
      ctx.strokeStyle = 'rgba(48,54,61,.75)';
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
    const r = getNodeRadiusPx();
    const isSelected = selectedItems.has(`node:${node.id}`);
    const isConnectSource = connectSource === node.id;
    const isDoorNode = node.typeId === 'door';
    const doorWidthFactor = getDoorWidthFactor(node);
    const doorHalfLong = r * 1.2 * doorWidthFactor;
    const doorHalfShort = Math.max(3, r * 0.38);
    const doorAngle = getDoorAxisAngle(node);

    // Glow
    if (isSelected || isConnectSource) {
      ctx.save();
      if (isDoorNode) {
        ctx.translate(s.x, s.y);
        // Rectangle long axis follows connection-perpendicular angle.
        ctx.rotate(doorAngle);
        ctx.beginPath();
        ctx.roundRect(-(doorHalfLong + 6), -(doorHalfShort + 6), (doorHalfLong + 6) * 2, (doorHalfShort + 6) * 2, 5);
      } else {
        ctx.beginPath();
        ctx.arc(s.x, s.y, r + 8, 0, Math.PI * 2);
      }
      const grad = ctx.createRadialGradient(s.x, s.y, r * 0.7, s.x, s.y, r + 12);
      grad.addColorStop(0, nt.color + '40');
      grad.addColorStop(1, 'transparent');
      ctx.fillStyle = grad;
      ctx.fill();
      ctx.restore();
    }

    if (isDoorNode) {
      ctx.save();
      ctx.translate(s.x, s.y);
      ctx.rotate(doorAngle);

      ctx.beginPath();
      ctx.roundRect(-doorHalfLong, -doorHalfShort, doorHalfLong * 2, doorHalfShort * 2, 3);
      const bodyGrad = ctx.createLinearGradient(0, -doorHalfShort, 0, doorHalfShort);
      bodyGrad.addColorStop(0, lightenColor(nt.color, 30));
      bodyGrad.addColorStop(1, nt.color);
      ctx.fillStyle = bodyGrad;
      ctx.fill();

      ctx.beginPath();
      ctx.roundRect(-doorHalfLong + 2, -doorHalfShort + 2, doorHalfLong * 2 - 4, doorHalfShort * 2 - 4, 2);
      ctx.fillStyle = '#161b22';
      ctx.fill();

      ctx.beginPath();
      ctx.roundRect(-doorHalfLong, -doorHalfShort, doorHalfLong * 2, doorHalfShort * 2, 3);
      ctx.strokeStyle = isSelected ? '#fff' : nt.color;
      ctx.lineWidth = isSelected ? 2.5 : 1.5;
      ctx.stroke();
      ctx.restore();
    } else {
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
    }

    // People count inside the node
    const people = node.people || 0;
    if (people > 0) {
      const peopleFontPx = Math.max(10, Math.min(18, r * 0.8));
      ctx.font = `600 ${peopleFontPx}px Inter, sans-serif`;
      ctx.fillStyle = var_textPrimary;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(String(people), s.x, s.y);
    }

    // Label
    const label = node.name || `Node ${node.id}`;
    const labelFontPx = Math.max(10, Math.min(16, 10 + r * 0.2));
    ctx.font = `${labelFontPx}px Inter, sans-serif`;
    ctx.fillStyle = var_textPrimary;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    ctx.fillText(label, s.x, s.y + r + 6);

    // Type badge
    const badgeFontPx = Math.max(8, Math.min(13, 8 + r * 0.18));
    ctx.font = `${badgeFontPx}px Inter, sans-serif`;
    ctx.fillStyle = nt.color;
    ctx.fillText(nt.name, s.x, s.y + r + 6 + Math.max(12, labelFontPx + 2));

    if (node.pinned) {
      const px = s.x + r * 0.62;
      const py = s.y - r * 0.7;
      ctx.save();
      ctx.fillStyle = '#e3b341';
      ctx.strokeStyle = '#161b22';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.arc(px, py, 3.2, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(px, py + 2.5);
      ctx.lineTo(px, py + 8);
      ctx.stroke();
      ctx.restore();
    }
  }

  const var_textPrimary = '#e6edf3';

  function drawConnection(conn) {
    const src = state.nodes.find(n => n.id === conn.sourceId);
    const tgt = state.nodes.find(n => n.id === conn.targetId);
    if (!src || !tgt) return;

    const ct = state.connTypes.find(t => t.id === conn.typeId) || state.connTypes[0];
    const isSelected = selectedItems.has(`connection:${conn.id}`);
    const dir = conn.direction || 'forward';
    const congestion = conn.congestion || 'none';

    // Width visualization
    const widthMeters = conn.width || 1.2;
    const pixelWidth = Math.max(2, widthMeters * PIXELS_PER_METER * cam.zoom);

    // Restore lineColor for arrows and base line
    // Normal representation = type color (unless selected)
    const lineColor = isSelected ? '#fff' : ct.color;

    const s = worldToScreen(src.x, src.y);
    const e = worldToScreen(tgt.x, tgt.y);

    // Dash pattern based on type
    ctx.setLineDash(ct.dash || []);

    // 1. Draw Base Line (Normal Representation)
    ctx.save();
    ctx.globalAlpha = 0.6;
    ctx.beginPath();
    ctx.strokeStyle = lineColor;
    ctx.lineWidth = pixelWidth;
    ctx.lineCap = 'butt';
    ctx.moveTo(s.x, s.y);
    ctx.lineTo(e.x, e.y);
    ctx.stroke();
    ctx.restore();

    // 2. Zig-Zag Overlay for Congestion
    if (congestion === 'blocked') {
      ctx.save();
      const wx = tgt.x - src.x;
      const wy = tgt.y - src.y;
      const wLen = Math.hypot(wx, wy);

      if (wLen > 1e-3) {
        const ux = wx / wLen;
        const uy = wy / wLen;
        const nx = -uy;
        const ny = ux;

        // Keep zigzag count stable in world space so zoom does not make it flicker.
        const zigzagStepWorld = 24; // world units (px @ zoom=1)
        const zigzagCount = Math.max(2, Math.min(260, Math.round(wLen / zigzagStepWorld)));
        const segWorld = wLen / zigzagCount;

        // Convert desired screen amplitude to world space for smooth zoom behavior.
        const ampScreen = Math.max(3, Math.min(11, pixelWidth * 0.45));
        const ampWorld = ampScreen / Math.max(cam.zoom, 0.01);

        ctx.beginPath();
        ctx.strokeStyle = '#f85149';
        ctx.lineWidth = Math.max(4, Math.min(8, pixelWidth * 0.55));
        ctx.lineJoin = 'round';
        ctx.lineCap = 'round';
        ctx.globalAlpha = 0.95;

        ctx.moveTo(s.x, s.y);
        for (let i = 1; i < zigzagCount; i++) {
          const d = segWorld * i;
          const side = i % 2 === 0 ? -1 : 1;
          const wxi = src.x + ux * d + nx * side * ampWorld;
          const wyi = src.y + uy * d + ny * side * ampWorld;
          const pi = worldToScreen(wxi, wyi);
          ctx.lineTo(pi.x, pi.y);
        }
        ctx.lineTo(e.x, e.y);
        ctx.stroke();
      }
      ctx.restore();
    }

    // Restore context state (though save/restore handles it)
    ctx.setLineDash([]);

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
    const arrowR = getNodeRadiusPx() + 4;
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

    // Label (Distance + Time) rotated along connection for readability
    const dx = e.x - s.x;
    const dy = e.y - s.y;
    const len = Math.hypot(dx, dy);
    const ux = len > 1e-6 ? dx / len : 1;
    const uy = len > 1e-6 ? dy / len : 0;
    const nx = -uy;
    const ny = ux;

    const rawTime = conn.calcStats ? Number(conn.calcStats.time) : NaN;
    const timeLabel = Number.isFinite(rawTime) ? formatNumeric(rawTime, 3, '0.000') : '--';
    const fullLabel = `L=${formatNumeric(conn.distance, 2)}m, t=${timeLabel}min`;
    const shortLabel = `L=${formatNumeric(conn.distance, 2)}, t=${timeLabel}`;
    const compactLabel = `L=${formatNumeric(conn.distance, 2)},t=${timeLabel}`;
    const fontPx = Math.max(8, Math.min(10, 8 + cam.zoom * 0.7));
    ctx.save();
    ctx.font = `${fontPx}px Inter, sans-serif`;
    const fullW = ctx.measureText(fullLabel).width;
    const shortW = ctx.measureText(shortLabel).width;
    ctx.restore();
    const available = Math.max(14, len - pixelWidth * 1.5);
    let label = fullLabel;
    if (fullW > available) label = shortLabel;
    if (shortW > available) label = compactLabel;

    const midX = (s.x + e.x) / 2 + nx * Math.max(5, Math.min(11, pixelWidth * 0.45));
    const midY = (s.y + e.y) / 2 + ny * Math.max(5, Math.min(11, pixelWidth * 0.45));
    let labelAngle = angle;
    if (labelAngle > Math.PI / 2 || labelAngle < -Math.PI / 2) labelAngle += Math.PI;
    if (labelAngle > Math.PI) labelAngle -= Math.PI * 2;
    if (labelAngle < -Math.PI) labelAngle += Math.PI * 2;
    labelAngle = clamp(labelAngle, -Math.PI / 4, Math.PI / 4);

    ctx.save();
    ctx.translate(midX, midY);
    ctx.rotate(labelAngle);
    ctx.font = `${fontPx}px Inter, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const textW = ctx.measureText(label).width;
    ctx.fillStyle = 'rgba(13,17,23, 0.84)';
    ctx.beginPath();
    ctx.roundRect(-textW / 2 - 3, -6, textW + 6, 12, 3);
    ctx.fill();
    ctx.fillStyle = '#f0f6fc';
    ctx.fillText(label, 0, 0);
    ctx.restore();

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
    const rWorld = getNodeRadiusPx() / cam.zoom;
    const marginWorld = HIT_MARGIN / cam.zoom;
    for (let i = state.nodes.length - 1; i >= 0; i--) {
      const n = state.nodes[i];
      if (n.typeId === 'door') {
        const doorWidthFactor = getDoorWidthFactor(n);
        const halfLong = rWorld * 1.2 * doorWidthFactor + marginWorld;
        const halfShort = rWorld * 0.38 + marginWorld;
        const angle = getDoorAxisAngle(n);
        const dx = wx - n.x;
        const dy = wy - n.y;
        const localX = dx * Math.cos(angle) + dy * Math.sin(angle);
        const localY = -dx * Math.sin(angle) + dy * Math.cos(angle);
        if (Math.abs(localX) <= halfLong && Math.abs(localY) <= halfShort) return n;
      } else if (dist({ x: wx, y: wy }, n) <= rWorld + marginWorld) {
        return n;
      }
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

  function getSelectionRect(box) {
    return {
      left: Math.min(box.startX, box.endX),
      right: Math.max(box.startX, box.endX),
      top: Math.min(box.startY, box.endY),
      bottom: Math.max(box.startY, box.endY),
    };
  }

  function isPointInRect(x, y, rect) {
    return x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;
  }

  function ccw(ax, ay, bx, by, cx, cy) {
    return (cy - ay) * (bx - ax) > (by - ay) * (cx - ax);
  }

  function segmentsIntersect(p1x, p1y, p2x, p2y, p3x, p3y, p4x, p4y) {
    return ccw(p1x, p1y, p3x, p3y, p4x, p4y) !== ccw(p2x, p2y, p3x, p3y, p4x, p4y) &&
      ccw(p1x, p1y, p2x, p2y, p3x, p3y) !== ccw(p1x, p1y, p2x, p2y, p4x, p4y);
  }

  function segmentIntersectsRect(x1, y1, x2, y2, rect) {
    if (isPointInRect(x1, y1, rect) || isPointInRect(x2, y2, rect)) return true;
    const l = rect.left, r = rect.right, t = rect.top, b = rect.bottom;
    return segmentsIntersect(x1, y1, x2, y2, l, t, r, t) ||
      segmentsIntersect(x1, y1, x2, y2, r, t, r, b) ||
      segmentsIntersect(x1, y1, x2, y2, r, b, l, b) ||
      segmentsIntersect(x1, y1, x2, y2, l, b, l, t);
  }

  function applySelectionBox(box) {
    const rect = getSelectionRect(box);
    if (!box.multi) selectedItems.clear();

    state.nodes.forEach(n => {
      const s = worldToScreen(n.x, n.y);
      if (isPointInRect(s.x, s.y, rect)) {
        selectedItems.add(`node:${n.id}`);
      }
    });

    state.connections.forEach(c => {
      const src = state.nodes.find(n => n.id === c.sourceId);
      const tgt = state.nodes.find(n => n.id === c.targetId);
      if (!src || !tgt) return;
      const s = worldToScreen(src.x, src.y);
      const e = worldToScreen(tgt.x, tgt.y);
      if (segmentIntersectsRect(s.x, s.y, e.x, e.y, rect)) {
        selectedItems.add(`connection:${c.id}`);
      }
    });

    updatePropertiesPanel();
  }

  // Split a connection at a point, creating a new node and two new connections
  function splitConnection(conn, wx, wy, options = {}) {
    const { skipHistory = false, nodeTypeId = 'waypoint' } = options;
    const src = state.nodes.find(n => n.id === conn.sourceId);
    const tgt = state.nodes.find(n => n.id === conn.targetId);
    if (!src || !tgt) return null;

    // Create the new node at the snap point
    const sx = snapToGrid(wx);
    const sy = snapToGrid(wy);
    const newNode = {
      id: state.nextNodeId++,
      name: '',
      typeId: nodeTypeId,
      x: sx,
      y: sy,
      width: nodeTypeId === 'door' ? 1.2 : undefined,
      pinned: false,
      props: {},
    };
    state.nodes.push(newNode);

    // Create two new connections replacing the old one
    const dSrcMid = dist(src, newNode);
    const dMidTgt = dist(newNode, tgt);
    const conn1 = {
      id: state.nextConnId++,
      sourceId: conn.sourceId,
      targetId: newNode.id,
      typeId: conn.typeId,
      direction: conn.direction,
      distance: roundDistanceMeters(dSrcMid / PIXELS_PER_METER),
      speed: conn.speed,
      weight: conn.weight,
      congestion: conn.congestion,
      width: roundWidthMeters(conn.width || 1.2),
      props: { ...conn.props },
    };
    const conn1Specified = Number(conn.specifiedDistance);
    if (Number.isFinite(conn1Specified) && conn1Specified > 0) {
      conn1.specifiedDistance = roundDistanceMeters(dSrcMid / PIXELS_PER_METER);
    }
    const conn2 = {
      id: state.nextConnId++,
      sourceId: newNode.id,
      targetId: conn.targetId,
      typeId: conn.typeId,
      direction: conn.direction,
      distance: roundDistanceMeters(dMidTgt / PIXELS_PER_METER),
      speed: conn.speed,
      weight: conn.weight,
      congestion: conn.congestion,
      width: roundWidthMeters(conn.width || 1.2),
      props: { ...conn.props },
    };
    const conn2Specified = Number(conn.specifiedDistance);
    if (Number.isFinite(conn2Specified) && conn2Specified > 0) {
      conn2.specifiedDistance = roundDistanceMeters(dMidTgt / PIXELS_PER_METER);
    }

    // Remove old connection, add new ones
    state.connections = state.connections.filter(c => c.id !== conn.id);
    state.connections.push(conn1, conn2);

    recalcPeopleCounts();
    if (!skipHistory) commitHistory();
    return newNode;
  }

  // ─── Node & Connection Ops ────────────────────────────────
  function createNode(wx, wy, options = {}) {
    const { forcedTypeId = null, skipHistory = false } = options;
    // Auto-assign type based on creation order
    let typeId = 'undefined';
    let people = 0;

    if (forcedTypeId) {
      typeId = forcedTypeId;
      people = 0;
    } else if (state.nodes.length === 0) {
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
      width: typeId === 'door' ? 1.2 : undefined,
      pinned: false,
      people: people,
      props: {},
    };
    state.nodes.push(node);
    selectItem({ type: 'node', id: node.id });
    if (!skipHistory) commitHistory();
    render();
    return node;
  }

  function createConnection(srcId, tgtId, options = {}) {
    const { skipHistory = false } = options;
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
      distance: roundDistanceMeters(d / PIXELS_PER_METER),
      speed: 0,
      weight: 1,
      congestion: 'none',
      props: {},
    };
    state.connections.push(conn);
    selectItem({ type: 'connection', id: conn.id });
    recalcPeopleCounts();
    if (!skipHistory) commitHistory();
    render();
    return conn;
  }

  function canTraverseConnection(conn, fromId, toId) {
    const dir = conn.direction || 'forward';
    if (conn.sourceId === fromId && conn.targetId === toId) {
      return dir === 'forward' || dir === 'both';
    }
    if (conn.sourceId === toId && conn.targetId === fromId) {
      return dir === 'backward' || dir === 'both';
    }
    return false;
  }

  function tryMergeWaypointDeletion(nodeId) {
    const node = state.nodes.find(n => n.id === nodeId);
    if (!node || !['waypoint', 'door'].includes(node.typeId)) return null;
    const incident = state.connections.filter(c => c.sourceId === nodeId || c.targetId === nodeId);
    if (incident.length !== 2) return null;
    const [c1, c2] = incident;
    if (c1.typeId !== c2.typeId) return null;

    const n1 = c1.sourceId === nodeId ? c1.targetId : c1.sourceId;
    const n2 = c2.sourceId === nodeId ? c2.targetId : c2.sourceId;
    const n1Node = state.nodes.find(n => n.id === n1);
    const n2Node = state.nodes.find(n => n.id === n2);
    if (n1 === n2) return null;
    if (state.connections.some(c =>
      (c.sourceId === n1 && c.targetId === n2) ||
      (c.sourceId === n2 && c.targetId === n1))) {
      return null;
    }

    const can12 = (canTraverseConnection(c1, n1, nodeId) && canTraverseConnection(c2, nodeId, n2)) ||
      (canTraverseConnection(c2, n1, nodeId) && canTraverseConnection(c1, nodeId, n2));
    const can21 = (canTraverseConnection(c1, n2, nodeId) && canTraverseConnection(c2, nodeId, n1)) ||
      (canTraverseConnection(c2, n2, nodeId) && canTraverseConnection(c1, nodeId, n1));

    let direction = 'both';
    if (can12 && !can21) direction = 'forward';
    if (!can12 && can21) direction = 'backward';
    if (!can12 && !can21) return null;

    const mergedConn = {
      id: state.nextConnId++,
      sourceId: n1,
      targetId: n2,
      typeId: c1.typeId,
      direction,
      distance: n1Node && n2Node ? roundDistanceMeters(dist(n1Node, n2Node) / PIXELS_PER_METER) : roundDistanceMeters((c1.distance || 0) + (c2.distance || 0)),
      speed: (c1.speed || c2.speed || 0),
      weight: Math.max(c1.weight || 1, c2.weight || 1),
      congestion: c1.congestion === c2.congestion ? c1.congestion : 'none',
      width: roundWidthMeters(((c1.width || 1.2) + (c2.width || 1.2)) / 2),
      props: { ...c1.props, ...c2.props },
    };
    const c1Specified = Number(c1.specifiedDistance);
    const c2Specified = Number(c2.specifiedDistance);
    if ((Number.isFinite(c1Specified) && c1Specified > 0) || (Number.isFinite(c2Specified) && c2Specified > 0)) {
      mergedConn.specifiedDistance = mergedConn.distance;
    }
    return mergedConn;
  }

  function deleteNode(nodeId, options = {}) {
    const { skipHistory = false } = options;
    const restoredConn = tryMergeWaypointDeletion(nodeId);

    state.nodes = state.nodes.filter(n => n.id !== nodeId);
    state.connections = state.connections.filter(c => c.sourceId !== nodeId && c.targetId !== nodeId);
    if (restoredConn) {
      state.connections.push(restoredConn);
    }
    selectedItems.delete(`node:${nodeId}`);
    sanitizeSelection();
    recalcPeopleCounts();
    if (!skipHistory) commitHistory();
    updatePropertiesPanel();
    render();
  }

  function deleteConnection(connId, options = {}) {
    const { skipHistory = false } = options;
    state.connections = state.connections.filter(c => c.id !== connId);
    selectedItems.delete(`connection:${connId}`);
    sanitizeSelection();
    recalcPeopleCounts();
    if (!skipHistory) commitHistory();
    updatePropertiesPanel();
    render();
  }

  function updateConnectionDistances() {
    state.connections.forEach(c => {
      const src = state.nodes.find(n => n.id === c.sourceId);
      const tgt = state.nodes.find(n => n.id === c.targetId);
      if (src && tgt) {
        // Distance in meters
        c.distance = roundDistanceMeters(dist(src, tgt) / PIXELS_PER_METER);
      }
    });
    recalcFireSafety();
  }

  const LENGTH_MISMATCH_TOLERANCE_M = 0.025;

  function getConnectionActualDistanceMeters(conn) {
    const explicit = Number(conn.distance);
    if (Number.isFinite(explicit) && explicit > 0) {
      return roundDistanceMeters(explicit);
    }
    const src = state.nodes.find(n => n.id === conn.sourceId);
    const tgt = state.nodes.find(n => n.id === conn.targetId);
    if (!src || !tgt) return 0;
    return roundDistanceMeters(dist(src, tgt) / PIXELS_PER_METER);
  }

  function getConnectionSpecifiedDistanceMeters(conn) {
    const specified = Number(conn.specifiedDistance);
    if (Number.isFinite(specified) && specified > 0) {
      return roundDistanceMeters(specified);
    }
    return null;
  }

  function getConnectionLengthDeltaInfo(conn) {
    const actual = getConnectionActualDistanceMeters(conn);
    const specified = getConnectionSpecifiedDistanceMeters(conn);
    if (specified == null) {
      return {
        actual,
        specified: null,
        delta: 0,
        mismatch: false,
      };
    }
    const delta = roundDistanceMeters(actual - specified);
    const mismatch = Math.abs(delta) > LENGTH_MISMATCH_TOLERANCE_M;
    return {
      actual,
      specified,
      delta,
      mismatch,
    };
  }

  function getConnectionDesiredDistance(conn) {
    const specified = Number(conn.specifiedDistance);
    if (Number.isFinite(specified) && specified > 0) {
      return roundDistanceMeters(specified);
    }
    const fallback = Number(conn.distance);
    if (Number.isFinite(fallback) && fallback > 0) {
      return roundDistanceMeters(fallback);
    }
    return GRID_SIZE_METERS;
  }

  function getNodeDegree(nodeId) {
    let degree = 0;
    for (const c of state.connections) {
      if (c.sourceId === nodeId || c.targetId === nodeId) degree++;
    }
    return degree;
  }

  function forceConnectionDistanceGeometry(conn, desiredMeters) {
    const src = state.nodes.find(n => n.id === conn.sourceId);
    const tgt = state.nodes.find(n => n.id === conn.targetId);
    if (!src || !tgt) return false;

    const targetMeters = Math.max(GRID_SIZE_METERS, roundDistanceMeters(desiredMeters));
    const targetPx = targetMeters * PIXELS_PER_METER;
    const srcDegree = getNodeDegree(src.id);
    const tgtDegree = getNodeDegree(tgt.id);
    const srcPinned = !!src.pinned;
    const tgtPinned = !!tgt.pinned;

    let anchor = src;
    let moving = tgt;
    if (srcPinned && !tgtPinned) {
      anchor = src;
      moving = tgt;
    } else if (tgtPinned && !srcPinned) {
      anchor = tgt;
      moving = src;
    } else if (tgtDegree > srcDegree) {
      anchor = tgt;
      moving = src;
    }

    let vx = moving.x - anchor.x;
    let vy = moving.y - anchor.y;
    let len = Math.hypot(vx, vy);

    if (len < 1e-6) {
      vx = 1;
      vy = 0;
      len = 1;
    }

    const ux = vx / len;
    const uy = vy / len;
    moving.x = snapToGrid(anchor.x + ux * targetPx);
    moving.y = snapToGrid(anchor.y + uy * targetPx);
    conn.distance = targetMeters;
    conn.specifiedDistance = targetMeters;
    return true;
  }

  function orderGraphStep() {
    if (state.connections.length === 0 || state.nodes.length < 2) return false;
    if (isPanning || dragging || selectionBox) return false;

    const deltas = new Map();
    const nodeById = new Map(state.nodes.map(n => [n.id, n]));
    const ensureDelta = (id) => {
      if (!deltas.has(id)) deltas.set(id, { x: 0, y: 0, count: 0 });
      return deltas.get(id);
    };
    const gain = 0.28;
    const maxMove = GRID_SIZE * 1.5;
    const snapBlend = 0.2;

    for (const c of state.connections) {
      const src = nodeById.get(c.sourceId);
      const tgt = nodeById.get(c.targetId);
      if (!src || !tgt) continue;
      const srcPinned = !!src.pinned;
      const tgtPinned = !!tgt.pinned;
      if (srcPinned && tgtPinned) continue;

      const dx = tgt.x - src.x;
      const dy = tgt.y - src.y;
      const len = Math.hypot(dx, dy);
      if (len < 1e-6) continue;

      const targetLen = Math.max(GRID_SIZE, getConnectionDesiredDistance(c) * PIXELS_PER_METER);
      const horizontal = Math.abs(dx) >= Math.abs(dy);

      let desiredDx = 0;
      let desiredDy = 0;
      if (horizontal) {
        desiredDx = (dx >= 0 ? 1 : -1) * targetLen;
      } else {
        desiredDy = (dy >= 0 ? 1 : -1) * targetLen;
      }

      const errX = desiredDx - dx;
      const errY = desiredDy - dy;
      if (Math.abs(errX) < 1e-4 && Math.abs(errY) < 1e-4) continue;

      const corrX = errX * gain;
      const corrY = errY * gain;
      if (srcPinned) {
        const tgtDelta = ensureDelta(tgt.id);
        tgtDelta.x += corrX;
        tgtDelta.y += corrY;
        tgtDelta.count += 1;
      } else if (tgtPinned) {
        const srcDelta = ensureDelta(src.id);
        srcDelta.x -= corrX;
        srcDelta.y -= corrY;
        srcDelta.count += 1;
      } else {
        const moveX = corrX * 0.5;
        const moveY = corrY * 0.5;
        const srcDelta = ensureDelta(src.id);
        srcDelta.x -= moveX;
        srcDelta.y -= moveY;
        srcDelta.count += 1;

        const tgtDelta = ensureDelta(tgt.id);
        tgtDelta.x += moveX;
        tgtDelta.y += moveY;
        tgtDelta.count += 1;
      }
    }

    let changed = false;
    deltas.forEach((d, nodeId) => {
      const node = nodeById.get(nodeId);
      if (!node || d.count === 0 || node.pinned) return;
      const moveX = clamp(d.x / d.count, -maxMove, maxMove);
      const moveY = clamp(d.y / d.count, -maxMove, maxMove);
      if (Math.abs(moveX) < 1e-4 && Math.abs(moveY) < 1e-4) return;

      const rawX = node.x + moveX;
      const rawY = node.y + moveY;
      const nextX = lerp(rawX, snapToGrid(rawX), snapBlend);
      const nextY = lerp(rawY, snapToGrid(rawY), snapBlend);
      if (Math.abs(nextX - node.x) > 1e-4 || Math.abs(nextY - node.y) > 1e-4) {
        node.x = nextX;
        node.y = nextY;
        changed = true;
      }
    });

    return changed;
  }

  function orderGraphTick() {
    if (!orderGraphEnabled) {
      orderGraphRafId = null;
      return;
    }

    if (orderGraphStep()) {
      orderGraphDirty = true;
      updateConnectionDistances();
      render();
    }

    orderGraphRafId = requestAnimationFrame(orderGraphTick);
  }

  function setOrderGraphEnabled(enabled) {
    orderGraphEnabled = !!enabled;
    if (btnOrderGraph) {
      btnOrderGraph.classList.toggle('active', orderGraphEnabled);
      btnOrderGraph.setAttribute('aria-pressed', orderGraphEnabled ? 'true' : 'false');
    }

    if (orderGraphEnabled) {
      if (!orderGraphRafId) {
        orderGraphRafId = requestAnimationFrame(orderGraphTick);
      }
      return;
    }

    if (orderGraphRafId) {
      cancelAnimationFrame(orderGraphRafId);
      orderGraphRafId = null;
    }

    if (orderGraphDirty) {
      updateConnectionDistances();
      commitHistory();
      orderGraphDirty = false;
      render();
    }
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

  function getNodeTypeSortPriority(typeId) {
    if (typeId === 'start') return 0;
    if (typeId === 'start2') return 1;
    if (typeId === 'waypoint') return 2;
    if (typeId === 'door') return 3;
    if (typeId === 'normal') return 4;
    if (typeId === 'exit') return 5;
    return 6;
  }

  function getEvacuationReachableNodeIds() {
    const starts = state.nodes.filter(n => SOURCE_TYPES.includes(n.typeId)).map(n => n.id);
    const visited = new Set(starts);
    const queue = [...starts];

    while (queue.length > 0) {
      const curr = queue.shift();
      for (const conn of state.connections) {
        if (conn.sourceId === curr) {
          const nextId = conn.targetId;
          if (canTraverseConnection(conn, curr, nextId) && !visited.has(nextId)) {
            visited.add(nextId);
            queue.push(nextId);
          }
        }
        if (conn.targetId === curr) {
          const nextId = conn.sourceId;
          if (canTraverseConnection(conn, curr, nextId) && !visited.has(nextId)) {
            visited.add(nextId);
            queue.push(nextId);
          }
        }
      }
    }

    return visited;
  }

  function getEvacuationOrderedNodes() {
    const reachable = getEvacuationReachableNodeIds();

    return [...state.nodes].sort((a, b) => {
      const aIsStart = SOURCE_TYPES.includes(a.typeId);
      const bIsStart = SOURCE_TYPES.includes(b.typeId);
      if (aIsStart !== bIsStart) return aIsStart ? -1 : 1;

      const aReach = reachable.has(a.id);
      const bReach = reachable.has(b.id);
      if (aReach !== bReach) return aReach ? -1 : 1;

      const aTime = Number.isFinite(Number(a.maxTime)) ? Number(a.maxTime) : 0;
      const bTime = Number.isFinite(Number(b.maxTime)) ? Number(b.maxTime) : 0;
      if (Math.abs(aTime - bTime) > 1e-6) return aTime - bTime;

      const typeDelta = getNodeTypeSortPriority(a.typeId) - getNodeTypeSortPriority(b.typeId);
      if (typeDelta !== 0) return typeDelta;

      if (Math.abs(a.y - b.y) > 1e-6) return a.y - b.y;
      if (Math.abs(a.x - b.x) > 1e-6) return a.x - b.x;
      return a.id - b.id;
    });
  }

  function getConnectionEvacuationSortKey(conn, nodeMap, nodeRank) {
    const src = nodeMap.get(conn.sourceId);
    const tgt = nodeMap.get(conn.targetId);
    const srcTime = Number.isFinite(Number(src?.maxTime)) ? Number(src.maxTime) : 0;
    const tgtTime = Number.isFinite(Number(tgt?.maxTime)) ? Number(tgt.maxTime) : 0;
    const srcRank = nodeRank.get(conn.sourceId) ?? Number.MAX_SAFE_INTEGER;
    const tgtRank = nodeRank.get(conn.targetId) ?? Number.MAX_SAFE_INTEGER;

    let fromId = conn.sourceId;
    let toId = conn.targetId;
    let fromTime = srcTime;
    let toTime = tgtTime;

    const dir = conn.direction || 'forward';
    if (dir === 'backward') {
      fromId = conn.targetId;
      toId = conn.sourceId;
      fromTime = tgtTime;
      toTime = srcTime;
    } else if (dir === 'both') {
      const swap = (tgtTime < srcTime - 1e-6) || (Math.abs(tgtTime - srcTime) <= 1e-6 && tgtRank < srcRank);
      if (swap) {
        fromId = conn.targetId;
        toId = conn.sourceId;
        fromTime = tgtTime;
        toTime = srcTime;
      }
    }

    return {
      fromId,
      toId,
      fromRank: nodeRank.get(fromId) ?? Number.MAX_SAFE_INTEGER,
      toRank: nodeRank.get(toId) ?? Number.MAX_SAFE_INTEGER,
      fromTime,
      toTime,
    };
  }

  function compareConnectionsByEvacuationTraversal(a, b, nodeMap, nodeRank) {
    const aKey = getConnectionEvacuationSortKey(a, nodeMap, nodeRank);
    const bKey = getConnectionEvacuationSortKey(b, nodeMap, nodeRank);

    if (Math.abs(aKey.fromTime - bKey.fromTime) > 1e-6) return aKey.fromTime - bKey.fromTime;
    if (Math.abs(aKey.toTime - bKey.toTime) > 1e-6) return aKey.toTime - bKey.toTime;
    if (aKey.fromRank !== bKey.fromRank) return aKey.fromRank - bKey.fromRank;
    if (aKey.toRank !== bKey.toRank) return aKey.toRank - bKey.toRank;
    const typeCmp = String(a.typeId || '').localeCompare(String(b.typeId || ''));
    if (typeCmp !== 0) return typeCmp;
    return a.id - b.id;
  }

  function renumberGraphByEvacuationLogic(options = {}) {
    const { skipHistory = false, skipRender = false } = options;
    if (state.nodes.length === 0 && state.connections.length === 0) return;

    recalcPeopleCounts();

    const orderedNodes = getEvacuationOrderedNodes();
    const nodeMap = new Map(state.nodes.map(n => [n.id, n]));
    const nodeRank = new Map(orderedNodes.map((n, idx) => [n.id, idx]));
    const orderedConnections = [...state.connections].sort((a, b) => (
      compareConnectionsByEvacuationTraversal(a, b, nodeMap, nodeRank)
    ));

    const nodeIdMap = new Map();
    orderedNodes.forEach((node, idx) => {
      nodeIdMap.set(node.id, idx + 1);
    });

    const connIdMap = new Map();
    orderedConnections.forEach((conn, idx) => {
      connIdMap.set(conn.id, idx + 1);
    });

    state.nodes.forEach((node) => {
      const nextId = nodeIdMap.get(node.id);
      if (nextId != null) node.id = nextId;
    });

    state.connections.forEach((conn) => {
      const nextConnId = connIdMap.get(conn.id);
      const nextSrcId = nodeIdMap.get(conn.sourceId);
      const nextTgtId = nodeIdMap.get(conn.targetId);

      if (nextConnId != null) conn.id = nextConnId;
      if (nextSrcId != null) conn.sourceId = nextSrcId;
      if (nextTgtId != null) conn.targetId = nextTgtId;
    });

    state.nodes.sort((a, b) => a.id - b.id);
    state.connections.sort((a, b) => a.id - b.id);

    const remappedSelection = new Set();
    selectedItems.forEach((key) => {
      const [kind, idStr] = key.split(':');
      const id = parseInt(idStr, 10);
      if (!Number.isFinite(id)) return;

      if (kind === 'node') {
        const nextNodeId = nodeIdMap.get(id);
        if (nextNodeId != null) remappedSelection.add(`node:${nextNodeId}`);
      } else if (kind === 'connection') {
        const nextConnId = connIdMap.get(id);
        if (nextConnId != null) remappedSelection.add(`connection:${nextConnId}`);
      }
    });
    selectedItems = remappedSelection;

    if (connectSource != null) {
      connectSource = nodeIdMap.get(connectSource) || null;
    }

    state.nextNodeId = state.nodes.length + 1;
    state.nextConnId = state.connections.length + 1;

    sanitizeSelection();
    recalcPeopleCounts();
    updatePropertiesPanel();
    if (!skipHistory) commitHistory();
    if (!skipRender) render();
  }

  // ─── Selection ────────────────────────────────────────────
  // ─── Interaction Helpers ─────────────────────────────────
  function hideHint() {
    if (canvasHint) canvasHint.style.display = 'none';
  }
  function showHint(text) {
    if (!canvasHint) return;
    canvasHint.textContent = text;
    canvasHint.style.display = 'block';
  }

  function openMetadataModal() {
    if (!metadataModal) return;
    state.metadata = normalizeMetadata(state.metadata);
    if (metaVersionInput) metaVersionInput.value = state.metadata.salamanderVersion || SALAMANDER_VERSION;
    if (metaAuthorInput) metaAuthorInput.value = state.metadata.author || '';
    if (metaCompanyInput) metaCompanyInput.value = state.metadata.company || '';
    if (metaProjectInput) metaProjectInput.value = state.metadata.project || '';
    if (metaDateTimeInput) metaDateTimeInput.value = state.metadata.dateTime || toLocalDateTimeValue();
    if (metaCreatedAtInput) metaCreatedAtInput.value = state.metadata.createdAt || toLocalDateTimeValue();
    if (metaExportedAtInput) metaExportedAtInput.value = state.metadata.exportedAt || '';
    if (metaNotesInput) metaNotesInput.value = state.metadata.notes || '';
    metadataModal.style.display = 'flex';
  }

  function closeMetadataModal() {
    if (metadataModal) metadataModal.style.display = 'none';
  }

  function saveMetadataFromModal() {
    state.metadata = normalizeMetadata({
      salamanderVersion: metaVersionInput ? metaVersionInput.value : SALAMANDER_VERSION,
      author: metaAuthorInput ? metaAuthorInput.value : '',
      company: metaCompanyInput ? metaCompanyInput.value : '',
      project: metaProjectInput ? metaProjectInput.value : '',
      dateTime: metaDateTimeInput ? metaDateTimeInput.value : toLocalDateTimeValue(),
      createdAt: state.metadata.createdAt,
      exportedAt: state.metadata.exportedAt,
      notes: metaNotesInput ? metaNotesInput.value : '',
    });
    applySettingsDefaultsToMetadata();
    commitHistory();
    closeMetadataModal();
    render();
  }

  function openSettingsModal() {
    if (!settingsModal) return;
    if (settingsDefaultAuthorInput) settingsDefaultAuthorInput.value = appSettings.defaultAuthor || '';
    if (settingsDefaultCompanyInput) settingsDefaultCompanyInput.value = appSettings.defaultCompany || '';
    settingsModal.style.display = 'flex';
  }

  function closeSettingsModal() {
    if (settingsModal) settingsModal.style.display = 'none';
  }
  function escHtml(s) {
    if (s == null) return '';
    const str = String(s);
    return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  // ─── Table Rendering ─────────────────────────────────────
  function renderTable() {
    // 1. Nodes Table
    let nHtml = '';
    for (const n of state.nodes) {
      const isSel = selectedItems.has(`node:${n.id}`);
      const type = state.nodeTypes.find(t => t.id === n.typeId);
      const typeName = type ? type.name : n.typeId;
      nHtml += `<tr class="${isSel ? 'selected' : ''}" onclick="window.selectNode(${n.id})">
        <td>${n.id}</td>
        <td>${escHtml(n.name)}</td>
        <td>${escHtml(typeName)}</td>
        <td>${n.people || 0}</td>
        <td>${(n.maxTime || 0).toFixed(2)}</td>
        <td>${n.x}</td>
        <td>${n.y}</td>
      </tr>`;
    }
    nodesTableBody.innerHTML = nHtml;

    // 2. Connections Table
    let cHtml = '';
    for (const c of state.connections) {
      const isSel = selectedItems.has(`connection:${c.id}`);
      const cType = state.connTypes.find(t => t.id === c.typeId);
      const cTypeName = cType ? cType.name : c.typeId;

      const stats = c.calcStats || { density: 0, v: 0, q: 0, Q: 0, time: 0 };
      const width = c.width || 1.2;
      const area = width * c.distance;
      const timeStr = stats.time >= 9999 ? 'Inf' : (stats.time || 0).toFixed(2);

      cHtml += `<tr class="${isSel ? 'selected' : ''}" onclick="window.selectConnection(${c.id})">
        <td>${c.id}</td>
        <td>${c.sourceId}</td>
        <td>${c.targetId}</td>
        <td>${escHtml(cTypeName)}</td>
        <td>${width.toFixed(2)}</td>
        <td>${area.toFixed(2)}</td>
        <td>${c.distance.toFixed(2)}</td>
        <td>${stats.density.toFixed(2)}</td>
        <td>${(stats.q || 0).toFixed(2)}</td>
        <td>${(stats.Q || 0).toFixed(2)}</td>
        <td>${(stats.v || 0).toFixed(2)}</td>
        <td>${timeStr}</td>
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
  // panelRegulations already declared above

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
      csvContent += "ID,Name,Type,People,MaxTime,X,Y\n";
      state.nodes.forEach(n => {
        const type = state.nodeTypes.find(t => t.id === n.typeId);
        const tName = type ? type.name : n.typeId;
        csvContent += `${n.id},"${n.name}","${tName}",${n.people || 0},${(n.maxTime || 0).toFixed(2)},${n.x},${n.y}\n`;
      });
    } else {
      csvContent += "ID,Source,Target,Type,Width,Area,Distance,Density,SpFlow,Capacity,Speed,Time,Congestion\n";
      state.connections.forEach(c => {
        const type = state.connTypes.find(t => t.id === c.typeId);
        const tName = type ? type.name : c.typeId;
        const stats = c.calcStats || { density: 0, v: 0, q: 0, Q: 0, time: 0 };
        const width = c.width || 1.2;
        const area = width * c.distance;

        csvContent += `${c.id},${c.sourceId},${c.targetId},"${tName}",${width.toFixed(2)},${area.toFixed(2)},${c.distance.toFixed(2)},${stats.density.toFixed(2)},${(stats.q || 0).toFixed(2)},${(stats.Q || 0).toFixed(2)},${(stats.v || 0).toFixed(2)},${(stats.time || 0).toFixed(2)},"${c.congestion}"\n`;
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

    // Check width handle click first (if any connection selected)
    // We only support width dragging for single selection for simplicity, or we check all.
    // Let's check all selected connections.
    for (const key of selectedItems) {
      if (key.startsWith('connection:')) {
        const id = parseInt(key.split(':')[1]);
        const conn = state.connections.find(c => c.id === id);
        if (conn) {
          const hPos = getConnectionHandlePos(conn);
          if (hPos) {
            const d = Math.sqrt((sx - hPos.x) ** 2 + (sy - hPos.y) ** 2);
            if (d <= 8) {
              dragging = { type: 'width', connId: conn.id, changed: false };
              return;
            }
          }
        }
      }
    }

    switch (tool) {
      case 'select': {
        const hitNode = hitTestNode(w.x, w.y);
        const multi = e.shiftKey || e.ctrlKey || e.metaKey;

        if (hitNode) {
          selectItem({ type: 'node', id: hitNode.id }, multi);
          dragging = {
            type: 'node',
            nodeId: hitNode.id,
            offsetX: w.x - hitNode.x,
            offsetY: w.y - hitNode.y,
            changed: false,
          };
          container.classList.add('dragging-node');
        } else {
          const hitConn = hitTestConnection(w.x, w.y);
          if (hitConn) {
            selectItem({ type: 'connection', id: hitConn.id }, multi);
          } else {
            selectionBox = {
              startX: sx,
              startY: sy,
              endX: sx,
              endY: sy,
              multi,
            };
            dragging = { type: 'box' };
            render();
          }
        }
        break;
      }
      case 'addNode': {
        const hitNode = hitTestNode(w.x, w.y);
        if (hitNode) {
          setTool('connect');
          connectSource = hitNode.id;
          showHint('Connect mode: click the next node or a segment');
          render();
          break;
        }

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
      case 'addDoor': {
        const hitNode = hitTestNode(w.x, w.y);
        if (hitNode) {
          break;
        }

        const hitConn = hitTestConnectionWithPoint(w.x, w.y);
        if (hitConn) {
          const newDoor = splitConnection(hitConn.conn, hitConn.proj.x, hitConn.proj.y, { nodeTypeId: 'door' });
          if (newDoor) {
            selectItem({ type: 'node', id: newDoor.id });
            render();
          }
        } else {
          createNode(w.x, w.y, { forcedTypeId: 'door' });
          hideHint();
        }
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
            hideHint();
          }
        } else {
          // T/X intersection: check if click is near a connection
          const hitConn = hitTestConnectionWithPoint(w.x, w.y);
          if (hitConn) {
            const newNode = splitConnection(hitConn.conn, hitConn.proj.x, hitConn.proj.y, { skipHistory: true });
            if (newNode) {
              if (connectSource) {
                // Complete connection from source to the new split node
                createConnection(connectSource, newNode.id, { skipHistory: true });
                connectSource = null;
                hideHint();
              } else {
                // Start a connection from the new split node
                connectSource = newNode.id;
              }
              selectItem({ type: 'node', id: newNode.id });
              commitHistory();
              render();
            }
          } else {
            connectSource = null;
            hideHint();
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
          const nx = snapToGrid(tempMouseWorld.x - dragging.offsetX);
          const ny = snapToGrid(tempMouseWorld.y - dragging.offsetY);
          if (node.x !== nx || node.y !== ny) {
            dragging.changed = true;
          }
          node.x = nx;
          node.y = ny;
          updateConnectionDistances();
          // Update properties panel to reflect new coordinates
          if (selectedItems.has(`node:${node.id}`)) {
            updatePropertiesPanel();
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
            const nextWidth = Math.max(0.05, roundWidthMeters(widthMeters));
            if (conn.width !== nextWidth) {
              dragging.changed = true;
              conn.width = nextWidth;
              recalcFireSafety();
            }

            updatePropertiesPanel();
            render();
          }
        }
      } else if (dragging.type === 'box') {
        selectionBox.endX = sx;
        selectionBox.endY = sy;
        render();
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
      if (dragging.type === 'node') {
        if (dragging.changed) {
          updateConnectionDistances();
          commitHistory();
        }
        container.classList.remove('dragging-node');
        updatePropertiesPanel();
      } else if (dragging.type === 'width') {
        if (dragging.changed) {
          commitHistory();
        }
      } else if (dragging.type === 'box') {
        const dx = Math.abs(selectionBox.endX - selectionBox.startX);
        const dy = Math.abs(selectionBox.endY - selectionBox.startY);
        if (dx < 3 && dy < 3) {
          if (!selectionBox.multi) clearSelection();
        } else {
          applySelectionBox(selectionBox);
        }
        selectionBox = null;
        render();
      }
      dragging = null;
    }
  });

  canvas.addEventListener('mouseleave', () => {
    if (dragging) {
      if (dragging.type === 'node' && dragging.changed) {
        updateConnectionDistances();
        commitHistory();
      }
      dragging = null;
      container.classList.remove('dragging-node');
      if (selectionBox) {
        selectionBox = null;
        render();
      }
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

    setZoomLevelDisplay();
    render();
  }, { passive: false });

  // ─── Keyboard Shortcuts ──────────────────────────────────
  document.addEventListener('keydown', (e) => {
    // Don't trigger shortcuts while typing
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT' || e.target.tagName === 'TEXTAREA') return;

    const key = e.key.toLowerCase();
    if ((e.ctrlKey || e.metaKey) && !e.shiftKey && key === 'z') {
      e.preventDefault();
      undoHistory();
      return;
    }
    if ((e.ctrlKey || e.metaKey) && (key === 'y' || (e.shiftKey && key === 'z'))) {
      e.preventDefault();
      redoHistory();
      return;
    }

    if (e.ctrlKey || e.metaKey || e.altKey) return;

    switch (key) {
      case 'v': setTool('select'); break;
      case 'n': setTool('addNode'); break;
      case 'o': setTool('addDoor'); break;
      case 'c': setTool('connect'); break;
      case 'd': setTool('delete'); break;
      case 'f':
        zoomToFitGraph();
        break;
      case 'r':
        renumberGraphByEvacuationLogic();
        break;
      case 'delete':
      case 'backspace':
        deleteSelection();
        break;
      case 'escape':
        clearSelection();
        connectSource = null;
        hideHint();
        render();
        break;
    }
  });

  // ─── Tool Switching ──────────────────────────────────────
  function setTool(t) {
    tool = t;
    connectSource = null;
    selectionBox = null;
    if (t !== 'connect') hideHint();
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
    state.metadata = normalizeMetadata({
      ...state.metadata,
      dateTime: toLocalDateTimeValue(),
      createdAt: toLocalDateTimeValue(),
      exportedAt: '',
    });
    applySettingsDefaultsToMetadata();
    clearSelection();
    commitHistory();
    render();
  });

  if (btnOrderGraph) {
    btnOrderGraph.addEventListener('click', () => {
      setOrderGraphEnabled(!orderGraphEnabled);
    });
  }

  if (btnRenumber) {
    btnRenumber.addEventListener('click', () => {
      renumberGraphByEvacuationLogic();
    });
  }

  if (btnZoomFit) {
    btnZoomFit.addEventListener('click', () => {
      zoomToFitGraph();
    });
  }

  if (btnMetadata) {
    btnMetadata.addEventListener('click', openMetadataModal);
  }
  if (btnCloseMetadata) {
    btnCloseMetadata.addEventListener('click', closeMetadataModal);
  }
  if (btnSaveMetadata) {
    btnSaveMetadata.addEventListener('click', saveMetadataFromModal);
  }
  if (metadataModal) {
    metadataModal.addEventListener('click', (e) => {
      if (e.target === metadataModal) closeMetadataModal();
    });
  }

  if (btnSettings) {
    btnSettings.addEventListener('click', openSettingsModal);
  }
  if (btnCloseSettings) {
    btnCloseSettings.addEventListener('click', closeSettingsModal);
  }
  if (btnSaveSettings) {
    btnSaveSettings.addEventListener('click', () => {
      appSettings.defaultAuthor = settingsDefaultAuthorInput ? settingsDefaultAuthorInput.value.trim() : '';
      appSettings.defaultCompany = settingsDefaultCompanyInput ? settingsDefaultCompanyInput.value.trim() : '';
      const saved = saveSettingsToStorage();
      if (saved) {
        applySettingsDefaultsToMetadata();
        commitHistory();
        closeSettingsModal();
        render();
      } else {
        alert('Failed to save settings in this browser.');
      }
    });
  }
  if (settingsModal) {
    settingsModal.addEventListener('click', (e) => {
      if (e.target === settingsModal) closeSettingsModal();
    });
  }

  const btnExport = document.getElementById('btnExport');
  if (btnExport) {
    btnExport.addEventListener('click', () => {
      state.metadata = normalizeMetadata({
        ...state.metadata,
        exportedAt: toLocalDateTimeValue(),
      });
      const data = {
        nodes: state.nodes,
        connections: state.connections,
        nodeTypes: state.nodeTypes,
        connTypes: state.connTypes,
        metadata: state.metadata,
      };
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'graph.json';
      a.click();
      URL.revokeObjectURL(url);
      render();
    });
  }

  const btnImport = document.getElementById('btnImport');
  if (btnImport) {
    btnImport.addEventListener('click', () => {
      const fileInput = document.getElementById('importFile');
      if (fileInput) fileInput.click();
    });
  }

  const importFile = document.getElementById('importFile');
  if (importFile) {
    importFile.addEventListener('change', (e) => {
      const file = e.target.files[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = (ev) => {
        try {
          const data = JSON.parse(ev.target.result);
          if (data.nodes) {
            state.nodes = data.nodes.map((n) => ({ ...n, pinned: !!n.pinned }));
          }
          if (data.connections) {
            state.connections = data.connections.map((c) => {
              const next = { ...c };
              const specified = Number(next.specifiedDistance);
              const legacyDesired = Number(next.desiredDistance);
              if (Number.isFinite(specified) && specified > 0) {
                next.specifiedDistance = roundDistanceMeters(specified);
              } else if (Number.isFinite(legacyDesired) && legacyDesired > 0) {
                next.specifiedDistance = roundDistanceMeters(legacyDesired);
              } else {
                delete next.specifiedDistance;
              }
              delete next.distanceManual;
              delete next.desiredDistance;
              return next;
            });
          }
          if (data.nodeTypes) state.nodeTypes = data.nodeTypes;
          if (data.connTypes) state.connTypes = data.connTypes;
          state.metadata = normalizeMetadata(data.metadata || state.metadata);
          normalizeConnectionTypes();
          applySettingsDefaultsToMetadata();
          state.nextNodeId = Math.max(0, ...state.nodes.map(n => n.id)) + 1;
          state.nextConnId = Math.max(0, ...state.connections.map(c => c.id)) + 1;
          updateConnectionDistances();
          recalcPeopleCounts();
          runOrderGraphIterations(220);
          renumberGraphByEvacuationLogic({ skipHistory: true, skipRender: true });
          selectedItems.clear();
          connectSource = null;
          sanitizeSelection();
          updatePropertiesPanel();
          zoomToFitGraph({ skipRender: true });
          renderLegend();
          commitHistory();
          render();
        } catch (err) {
          alert('Failed to import: ' + err.message);
        }
      };
      reader.readAsText(file);
      e.target.value = '';
    });
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

    loadSettingsFromStorage();
    state.metadata = normalizeMetadata(state.metadata);
    applySettingsDefaultsToMetadata();
    normalizeConnectionTypes();

    // Center camera
    const rect = container.getBoundingClientRect();
    cam.x = rect.width / 2;
    cam.y = rect.height / 2;
    cam.zoom = 1;
    setZoomLevelDisplay();

    container.setAttribute('data-tool', tool);
    resizeCanvas();
    renderLegend();
    commitHistory();
    render();
  }

  // Wait for fonts
  if (document.fonts && document.fonts.ready) {
    document.fonts.ready.then(() => {
      init();
    });
  } else {
    window.addEventListener('load', () => {
      init();
    });
  }

  // Convert HSL colors to hex for type manager (when creating via random hue)
  // The canvas handles hsl() strings natively, so no conversion needed.
  // ─── Report Generation ────────────────────────────────────
  const reportModal = document.getElementById('report-modal');
  const btnReport = document.getElementById('btnReport');
  const btnRefreshReport = document.getElementById('btnRefreshReport');
  const btnExportReportPdf = document.getElementById('btnExportReportPdf');
  const btnCloseReport = document.getElementById('btnCloseReport');
  const repTotalTime = document.getElementById('repTotalTime');
  const repTotalPeople = document.getElementById('repTotalPeople');
  const repCriticalPath = document.getElementById('repCriticalPath');
  const repConnCount = document.getElementById('repConnCount');
  const repBottlenecks = document.getElementById('repBottlenecks');
  const repGraphSize = document.getElementById('repGraphSize');
  const repMethod = document.getElementById('repMethod');
  const repGeneratedAt = document.getElementById('repGeneratedAt');
  const reportExecutiveSummary = document.getElementById('reportExecutiveSummary');
  const reportMetaGrid = document.getElementById('reportMetaGrid');
  const reportTableHead = document.getElementById('reportTableHead');
  const reportTableBody = document.getElementById('reportTableBody');
  const mathProofContent = document.getElementById('mathProofContent');
  const reportCanvas = document.getElementById('reportCanvas');
  const repCtx = reportCanvas && reportCanvas.getContext('2d'); // Check existence
  let lastReportContext = null;

  if (btnReport) btnReport.addEventListener('click', () => showReport(true));
  if (btnRefreshReport) btnRefreshReport.addEventListener('click', () => showReport(true));
  if (btnExportReportPdf) btnExportReportPdf.addEventListener('click', exportReportPdf);
  if (btnCloseReport) btnCloseReport.addEventListener('click', () => reportModal.style.display = 'none');
  if (reportModal) reportModal.addEventListener('click', (e) => {
    if (e.target === reportModal) reportModal.style.display = 'none';
  });

  // Report implementation

  function formatDateTimeForDisplay(rawValue) {
    if (!rawValue) return '-';
    const normalized = String(rawValue).trim();
    if (!normalized) return '-';

    if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(normalized)) {
      return normalized.replace('T', ' ');
    }
    if (/^\d{4}-\d{2}-\d{2}$/.test(normalized)) {
      return `${normalized} 00:00`;
    }

    const d = new Date(normalized);
    if (Number.isNaN(d.getTime())) return normalized;
    const pad = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  }

  function formatNumeric(value, digits = 2, fallback = '-') {
    const v = Number(value);
    if (!Number.isFinite(v)) return fallback;
    return v.toFixed(digits);
  }

  function connectionDirectionLabel(direction) {
    const dir = direction || 'forward';
    if (dir === 'backward') return '<-';
    if (dir === 'both') return '<->';
    return '->';
  }

  function connectionSeverityLabel(severity) {
    if (severity === 'n_a') return 'N/A';
    if (severity === 'queued') return 'Queue';
    if (severity === 'blocked') return 'Blocked';
    return 'None';
  }

  function getConnectionSeverity(conn, method, flowState = conn.flowState || {}) {
    if (method !== 'B') return 'n_a';
    if ((conn.congestion || 'none') === 'blocked') return 'blocked';
    if (flowState && flowState.hasQueue) return 'queued';
    if ((conn.congestion || 'none') !== 'none') return 'queued';
    return 'none';
  }

  function buildReportContext(refreshGeneratedAt = true) {
    recalcPeopleCounts();

    const nodeMap = new Map(state.nodes.map(n => [n.id, n]));
    const connTypeMap = new Map(state.connTypes.map(t => [t.id, t]));
    const bounds = computeGraphBoundsWorld(state.nodes);
    const metadata = normalizeMetadata(state.metadata);

    const generatedAtRaw = (refreshGeneratedAt || !lastReportContext || !lastReportContext.generatedAtRaw)
      ? new Date().toISOString()
      : lastReportContext.generatedAtRaw;

    const nodeCounts = {
      start: 0,
      start2: 0,
      exit: 0,
      normal: 0,
      waypoint: 0,
      door: 0,
      other: 0,
      pinned: 0,
    };

    state.nodes.forEach((n) => {
      if (Object.prototype.hasOwnProperty.call(nodeCounts, n.typeId)) nodeCounts[n.typeId] += 1;
      else nodeCounts.other += 1;
      if (n.pinned) nodeCounts.pinned += 1;
    });

    const totalPeople = state.nodes.reduce((sum, n) => (
      SOURCE_TYPES.includes(n.typeId) ? sum + (Number(n.people) || 0) : sum
    ), 0);

    const exits = state.nodes.filter(n => n.typeId === 'exit');
    const totalTime = Number(state.totalEvacuationTime) || 0;
    const criticalExits = exits.filter(e => Math.abs((Number(e.maxTime) || 0) - totalTime) < 0.01);
    const method = state.calculationMethod === 'B' ? 'B' : 'A';

    const orderedNodes = getEvacuationOrderedNodes();
    const nodeRank = new Map(orderedNodes.map((n, idx) => [n.id, idx]));
    const sortedConns = [...state.connections].sort((a, b) => (
      compareConnectionsByEvacuationTraversal(a, b, nodeMap, nodeRank)
    ));

    const rows = [];
    sortedConns.forEach((conn, idx) => {
      const src = nodeMap.get(conn.sourceId);
      const tgt = nodeMap.get(conn.targetId);
      if (!src || !tgt) return;

      const ct = connTypeMap.get(conn.typeId) || { name: conn.typeId || 'normal', color: '#8b949e', dash: [] };
      const limits = getLimitParams(conn.typeId);

      const lengthInfo = getConnectionLengthDeltaInfo(conn);
      const length = lengthInfo.actual;
      const specifiedLength = lengthInfo.specified;
      const deltaLength = lengthInfo.delta;
      const lengthMismatch = lengthInfo.mismatch;

      const width = Math.max(0.05, roundWidthMeters(Number(conn.width) || 1.2));
      const stats = conn.calcStats || {};
      const flow = conn.flowState || {};
      const dyn = conn.dynamicStats || {};

      const densityRaw = Number.isFinite(Number(stats.density)) ? Number(stats.density) : null;
      const flowQSpec = Number(flow.q_spec);
      const flowQOut = Number(flow.Q_out);
      const flowQIn = Number(flow.Q_in);
      const qRaw = Number.isFinite(Number(stats.q))
        ? Number(stats.q)
        : (Number.isFinite(flowQSpec) ? flowQSpec : null);
      const QRaw = Number.isFinite(Number(stats.Q))
        ? Number(stats.Q)
        : (Number.isFinite(flowQOut) ? flowQOut : (Number.isFinite(flowQIn) ? flowQIn : null));
      const density = method === 'A' ? densityRaw : null;
      const q = method === 'B' ? qRaw : null;
      const Q = method === 'B' ? QRaw : null;

      const qMax = Number.isFinite(Number(stats.q_max)) ? Number(stats.q_max) : (Number(limits.q_max) || 0);
      const qGran = Number.isFinite(Number(stats.q_gran)) ? Number(stats.q_gran) : (Number(limits.q_gran) || 0);
      const vGran = Number.isFinite(Number(stats.v_gran)) ? Number(stats.v_gran) : (Number(limits.v_gran) || 0);

      let speed = Number(stats.v);
      if (!Number.isFinite(speed) || speed <= 0) speed = vGran > 0 ? vGran : 0;

      let time = Number(stats.time);
      if (!Number.isFinite(time) || time < 0) time = Number(conn.travelTime) || 0;

      const severity = getConnectionSeverity(conn, method, flow);
      const rowClassList = [];
      if (severity === 'blocked') rowClassList.push('report-row-risk');
      else if (severity === 'queued') rowClassList.push('report-row-warning');
      if (lengthMismatch) rowClassList.push('report-row-length-warning');
      const rowClass = rowClassList.join(' ');

      const peopleIn = Number.isFinite(Number(dyn.N_total))
        ? Number(dyn.N_total)
        : (Number(src.people) || 0);

      rows.push({
        step: idx + 1,
        connId: conn.id,
        conn,
        src,
        tgt,
        fromName: src.name || `Node ${src.id}`,
        toName: tgt.name || `Node ${tgt.id}`,
        typeName: ct.name || conn.typeId || 'normal',
        typeColor: ct.color || '#8b949e',
        typeDash: Array.isArray(ct.dash) ? ct.dash : [],
        direction: conn.direction || 'forward',
        directionLabel: connectionDirectionLabel(conn.direction || 'forward'),
        length,
        specifiedLength,
        deltaLength,
        lengthMismatch,
        width,
        peopleIn,
        density,
        q,
        Q,
        qMax,
        qGran,
        speed,
        vGran,
        time,
        hasQueue: !!(flow.hasQueue),
        severity,
        severityLabel: connectionSeverityLabel(severity),
        congestionRaw: conn.congestion || 'none',
        dynamicStats: dyn,
        rowClass,
      });
    });

    const bottleneckCount = rows.filter(r => r.severity === 'blocked' || r.severity === 'queued' || r.hasQueue).length;
    const blockedCount = rows.filter(r => r.severity === 'blocked').length;
    const queueCount = rows.filter(r => r.hasQueue).length;
    const lengthMismatchCount = rows.filter(r => r.lengthMismatch).length;
    const totalLength = rows.reduce((sum, r) => sum + (Number(r.length) || 0), 0);
    const avgWidth = rows.length > 0 ? rows.reduce((sum, r) => sum + (Number(r.width) || 0), 0) / rows.length : 0;
    const avgDensity = method === 'A'
      ? (rows.length > 0 ? rows.reduce((sum, r) => sum + (Number(r.density) || 0), 0) / rows.length : 0)
      : null;
    const avgSpeed = rows.length > 0 ? rows.reduce((sum, r) => sum + (Number(r.speed) || 0), 0) / rows.length : 0;

    const maxTimeRow = rows.reduce((best, row) => (!best || row.time > best.time ? row : best), null);
    const maxDensityRow = method === 'A'
      ? rows.reduce((best, row) => (!best || (Number(row.density) || 0) > (Number(best.density) || 0) ? row : best), null)
      : null;

    const graphSizeLabel = `${formatNumeric(bounds.widthM, 2, '0.00')} m x ${formatNumeric(bounds.heightM, 2, '0.00')} m`;
    const methodLabel = state.calculationMethod === 'B'
      ? 'Method B - Capacity/Throughput'
      : 'Method A - Travel Speed';

    return {
      generatedAtRaw,
      generatedAtDisplay: formatDateTimeForDisplay(generatedAtRaw),
      metadata,
      bounds,
      graphSizeLabel,
      methodLabel,
      method,
      totalPeople,
      totalTime,
      criticalExits,
      nodeCounts,
      rows,
      connectionCount: rows.length,
      bottleneckCount,
      blockedCount,
      queueCount,
      lengthMismatchCount,
      totalLength,
      avgWidth,
      avgDensity,
      avgSpeed,
      maxTimeRow,
      maxDensityRow,
      orderGraphEnabled: !!orderGraphEnabled,
      zoomPercent: Math.round(cam.zoom * 100),
    };
  }

  function showReport(refreshGeneratedAt = true) {
    if (!reportModal) return;
    reportModal.style.display = 'flex';
    const report = buildReportContext(refreshGeneratedAt);
    lastReportContext = report;
    generateReportSummary(report);
    generateReportDiagram(report);
    generateReportTable(report);
    generateMathProof(report);
  }

  function generateReportSummary(report = lastReportContext) {
    if (!report) return;

    if (repTotalTime) repTotalTime.textContent = formatNumeric(report.totalTime, 3, '0.000');
    if (repTotalPeople) repTotalPeople.textContent = String(Math.round(report.totalPeople));
    if (repCriticalPath) repCriticalPath.textContent = String(report.criticalExits.length);
    if (repConnCount) repConnCount.textContent = String(report.connectionCount);
    if (repBottlenecks) repBottlenecks.textContent = String(report.bottleneckCount);
    if (repGraphSize) repGraphSize.textContent = report.graphSizeLabel;
    if (repMethod) repMethod.textContent = report.methodLabel;
    if (repGeneratedAt) repGeneratedAt.textContent = report.generatedAtDisplay;

    const longest = report.maxTimeRow
      ? `Connection #${report.maxTimeRow.connId} (${report.maxTimeRow.fromName} -> ${report.maxTimeRow.toName}) at ${formatNumeric(report.maxTimeRow.time, 3, '0.000')} min`
      : 'No segment data is available yet.';

    const riskLine = report.bottleneckCount > 0
      ? `${report.bottleneckCount} bottleneck segments were found (${report.blockedCount} blocked, ${report.queueCount} with queues).`
      : 'No bottlenecks or blocked segments were detected.';
    const densityLine = (report.method === 'A' && report.maxDensityRow)
      ? `Connection #${report.maxDensityRow.connId} has the highest density at ${formatNumeric(report.maxDensityRow.density, 2)} p/m2.`
      : '';
    const lengthWarningLine = report.lengthMismatchCount > 0
      ? `${report.lengthMismatchCount} connections deviate from user-specified length and are currently highlighted as warnings.`
      : '';

    if (reportExecutiveSummary) {
      reportExecutiveSummary.innerHTML = [
        `<p><strong>Outcome:</strong> Total evacuation time is <strong>${formatNumeric(report.totalTime, 3, '0.000')} min</strong> for <strong>${Math.round(report.totalPeople)}</strong> people using <strong>${escHtml(report.methodLabel)}</strong>.</p>`,
        `<p><strong>Risk Profile:</strong> ${escHtml(riskLine)}</p>`,
        densityLine ? `<p><strong>Density:</strong> ${escHtml(densityLine)}</p>` : '',
        lengthWarningLine ? `<p><strong>Length Warning:</strong> ${escHtml(lengthWarningLine)}</p>` : '',
        `<p><strong>Geometry:</strong> The graph covers <strong>${escHtml(report.graphSizeLabel)}</strong> with ${report.rows.length} modeled connections. Longest segment time contribution: ${escHtml(longest)}.</p>`,
      ].filter(Boolean).join('');
    }

    if (reportMetaGrid) {
      const meta = report.metadata || {};
      const metaItems = [
        ['Project', meta.project || 'Untitled'],
        ['Author', meta.author || '-'],
        ['Company', meta.company || '-'],
        ['Scenario Date/Time', formatDateTimeForDisplay(meta.dateTime)],
        ['Created', formatDateTimeForDisplay(meta.createdAt)],
        ['Exported', formatDateTimeForDisplay(meta.exportedAt)],
        ['Salamander Version', meta.salamanderVersion || SALAMANDER_VERSION],
        ['Nodes', `${state.nodes.length} (Start ${report.nodeCounts.start + report.nodeCounts.start2}, Exit ${report.nodeCounts.exit}, Door ${report.nodeCounts.door}, Waypoint ${report.nodeCounts.waypoint})`],
        ['Pinned Nodes', String(report.nodeCounts.pinned)],
        ['Total Connection Length', `${formatNumeric(report.totalLength, 2, '0.00')} m`],
        ['Average Width', `${formatNumeric(report.avgWidth, 2, '0.00')} m`],
        ['Average Speed', `${formatNumeric(report.avgSpeed, 2, '0.00')} m/min`],
        ['Length Mismatch Warnings', String(report.lengthMismatchCount)],
        ['Ordering', report.orderGraphEnabled ? 'Enabled' : 'Disabled'],
      ];
      if (report.method === 'A') {
        metaItems.splice(11, 0, ['Average Density', `${formatNumeric(report.avgDensity, 2, '0.00')} p/m2`]);
      }

      reportMetaGrid.innerHTML = metaItems.map(([label, value]) => `
        <div class="report-meta-item">
          <div class="report-meta-label">${escHtml(label)}</div>
          <div class="report-meta-value">${escHtml(value)}</div>
        </div>
      `).join('');
    }
  }

  function generateReportDiagram(report = lastReportContext, options = {}) {
    if (!reportCanvas || !repCtx || !report) return;
    const theme = options && options.theme === 'light' ? 'light' : 'dark';
    const isLight = theme === 'light';

    const containerEl = reportCanvas.parentElement;
    const cssW = Math.max(900, Math.round((containerEl ? containerEl.clientWidth : 900) - 2));
    const cssH = Math.max(460, Math.round((containerEl ? containerEl.clientHeight : 470) - 2));
    const dpr = Math.max(1, window.devicePixelRatio || 1);

    reportCanvas.width = Math.round(cssW * dpr);
    reportCanvas.height = Math.round(cssH * dpr);
    reportCanvas.style.width = `${cssW}px`;
    reportCanvas.style.height = `${cssH}px`;

    repCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
    repCtx.clearRect(0, 0, cssW, cssH);

    const bg = repCtx.createLinearGradient(0, 0, 0, cssH);
    if (isLight) {
      bg.addColorStop(0, '#f8fafc');
      bg.addColorStop(1, '#eef2f7');
    } else {
      bg.addColorStop(0, '#0d1117');
      bg.addColorStop(1, '#111827');
    }
    repCtx.fillStyle = bg;
    repCtx.fillRect(0, 0, cssW, cssH);

    if (state.nodes.length === 0) {
      repCtx.fillStyle = isLight ? '#6b7280' : '#9ca3af';
      repCtx.font = '600 14px Inter, sans-serif';
      repCtx.textAlign = 'center';
      repCtx.textBaseline = 'middle';
      repCtx.fillText('No graph data to render', cssW / 2, cssH / 2);
      return;
    }

    const bounds = report.bounds;
    const pad = 56;
    const spanW = Math.max(1, bounds.widthPx);
    const spanH = Math.max(1, bounds.heightPx);
    const usableW = Math.max(1, cssW - pad * 2);
    const usableH = Math.max(1, cssH - pad * 2);
    const scale = Math.max(0.001, Math.min(usableW / spanW, usableH / spanH));
    const drawW = spanW * scale;
    const drawH = spanH * scale;
    const offsetX = pad + (usableW - drawW) * 0.5;
    const offsetY = pad + (usableH - drawH) * 0.5;

    const toPoint = (n) => ({
      x: offsetX + (n.x - bounds.minX) * scale,
      y: offsetY + (n.y - bounds.minY) * scale,
    });

    const meterStepWorld = PIXELS_PER_METER;
    const meterStepPx = meterStepWorld * scale;
    if (meterStepPx >= 10) {
      repCtx.beginPath();
      repCtx.strokeStyle = isLight ? 'rgba(100,116,139,0.28)' : 'rgba(107,114,128,0.22)';
      repCtx.lineWidth = 1;
      const gx0 = Math.floor(bounds.minX / meterStepWorld) * meterStepWorld;
      const gy0 = Math.floor(bounds.minY / meterStepWorld) * meterStepWorld;
      for (let gx = gx0; gx <= bounds.maxX + meterStepWorld; gx += meterStepWorld) {
        const x = offsetX + (gx - bounds.minX) * scale;
        repCtx.moveTo(x, offsetY);
        repCtx.lineTo(x, offsetY + drawH);
      }
      for (let gy = gy0; gy <= bounds.maxY + meterStepWorld; gy += meterStepWorld) {
        const y = offsetY + (gy - bounds.minY) * scale;
        repCtx.moveTo(offsetX, y);
        repCtx.lineTo(offsetX + drawW, y);
      }
      repCtx.stroke();
    }

    const severityColor = {
      n_a: '#58a6ff',
      none: '#58a6ff',
      queued: '#e3b341',
      blocked: '#f85149',
    };

    report.rows.forEach((row) => {
      const s = toPoint(row.src);
      const t = toPoint(row.tgt);
      const dx = t.x - s.x;
      const dy = t.y - s.y;
      const len = Math.hypot(dx, dy);
      if (len < 1e-6) return;

      const isStairs = row.conn && (row.conn.typeId === 'stairs_up' || row.conn.typeId === 'stairs_down');
      const baseTypeColor = row.typeColor || severityColor.none;
      const lineColor = (row.severity === 'none' || row.severity === 'n_a')
        ? baseTypeColor
        : (severityColor[row.severity] || baseTypeColor);
      const lineWidth = Math.max(1.8, Math.min(20, row.width * PIXELS_PER_METER * scale));

      repCtx.save();
      repCtx.strokeStyle = lineColor;
      repCtx.lineWidth = isStairs ? lineWidth * 1.05 : lineWidth;
      repCtx.lineCap = 'round';
      repCtx.globalAlpha = 0.85;
      if (isStairs) {
        if (row.conn.typeId === 'stairs_up') repCtx.setLineDash([Math.max(6, 8 * scale), Math.max(4, 5 * scale)]);
        else repCtx.setLineDash([Math.max(2, 3 * scale), Math.max(4, 6 * scale)]);
      } else if (row.typeDash.length) {
        repCtx.setLineDash(row.typeDash.map(v => Math.max(2, v * scale)));
      } else {
        repCtx.setLineDash([]);
      }
      repCtx.beginPath();
      repCtx.moveTo(s.x, s.y);
      repCtx.lineTo(t.x, t.y);
      repCtx.stroke();
      repCtx.restore();

      if (isStairs) {
        const ux = dx / len;
        const uy = dy / len;
        const nx = -uy;
        const ny = ux;
        const markCount = Math.max(3, Math.min(32, Math.floor(len / 18)));
        const markHalf = Math.max(3, Math.min(10, lineWidth * 0.42));
        repCtx.save();
        repCtx.strokeStyle = isLight ? 'rgba(15,23,42,0.55)' : 'rgba(248,250,252,0.55)';
        repCtx.lineWidth = Math.max(1, lineWidth * 0.2);
        repCtx.setLineDash([]);
        for (let i = 1; i < markCount; i++) {
          const d = (len * i) / markCount;
          const cx = s.x + ux * d;
          const cy = s.y + uy * d;
          repCtx.beginPath();
          repCtx.moveTo(cx - nx * markHalf, cy - ny * markHalf);
          repCtx.lineTo(cx + nx * markHalf, cy + ny * markHalf);
          repCtx.stroke();
        }
        repCtx.restore();
      }

      if (row.severity === 'blocked') {
        const ux = dx / len;
        const uy = dy / len;
        const nx = -uy;
        const ny = ux;
        const zigCount = Math.max(4, Math.round(len / 26));
        const amp = Math.max(3, Math.min(10, lineWidth * 0.45));

        repCtx.save();
        repCtx.strokeStyle = '#f85149';
        repCtx.lineWidth = Math.max(2.5, Math.min(8, lineWidth * 0.6));
        repCtx.lineJoin = 'round';
        repCtx.lineCap = 'round';
        repCtx.beginPath();
        repCtx.moveTo(s.x, s.y);
        for (let i = 1; i < zigCount; i++) {
          const d = (len * i) / zigCount;
          const side = i % 2 === 0 ? -1 : 1;
          repCtx.lineTo(s.x + ux * d + nx * side * amp, s.y + uy * d + ny * side * amp);
        }
        repCtx.lineTo(t.x, t.y);
        repCtx.stroke();
        repCtx.restore();
      }

      const arrowSize = Math.max(7, Math.min(15, lineWidth * 0.8));
      const arrowInset = Math.max(6, arrowSize * 0.8);
      const angle = Math.atan2(dy, dx);

      const drawArrow = (tipX, tipY, ang) => {
        repCtx.save();
        repCtx.strokeStyle = lineColor;
        repCtx.lineWidth = Math.max(1.6, lineWidth * 0.28);
        repCtx.beginPath();
        repCtx.moveTo(tipX, tipY);
        repCtx.lineTo(tipX - arrowSize * Math.cos(ang - 0.42), tipY - arrowSize * Math.sin(ang - 0.42));
        repCtx.moveTo(tipX, tipY);
        repCtx.lineTo(tipX - arrowSize * Math.cos(ang + 0.42), tipY - arrowSize * Math.sin(ang + 0.42));
        repCtx.stroke();
        repCtx.restore();
      };

      if (row.direction === 'forward' || row.direction === 'both') {
        drawArrow(t.x - Math.cos(angle) * arrowInset, t.y - Math.sin(angle) * arrowInset, angle);
      }
      if (row.direction === 'backward' || row.direction === 'both') {
        drawArrow(s.x + Math.cos(angle) * arrowInset, s.y + Math.sin(angle) * arrowInset, angle + Math.PI);
      }

      const fullLabel = `L=${formatNumeric(row.length, 2)}m, t=${formatNumeric(row.time, 3)}min`;
      const shortLabel = `L=${formatNumeric(row.length, 2)}, t=${formatNumeric(row.time, 3)}`;
      const compactLabel = `L=${formatNumeric(row.length, 2)},t=${formatNumeric(row.time, 3)}`;
      const labelFontPx = 8;
      repCtx.save();
      repCtx.font = `${labelFontPx}px Inter, sans-serif`;
      const fullW = repCtx.measureText(fullLabel).width;
      const shortW = repCtx.measureText(shortLabel).width;
      repCtx.restore();
      const available = Math.max(18, len - lineWidth * 1.6);
      let label = fullLabel;
      if (fullW > available) label = shortLabel;
      if (shortW > available) label = compactLabel;

      const ux = dx / len;
      const uy = dy / len;
      const nx = -uy;
      const ny = ux;
      const labelOffset = Math.max(6, Math.min(12, lineWidth * 0.55));
      const lx = (s.x + t.x) * 0.5 + nx * labelOffset;
      const ly = (s.y + t.y) * 0.5 + ny * labelOffset;
      let labelAngle = angle;
      if (labelAngle > Math.PI / 2 || labelAngle < -Math.PI / 2) labelAngle += Math.PI;
      if (labelAngle > Math.PI) labelAngle -= Math.PI * 2;
      if (labelAngle < -Math.PI) labelAngle += Math.PI * 2;
      labelAngle = clamp(labelAngle, -Math.PI / 4, Math.PI / 4);

      repCtx.save();
      repCtx.translate(lx, ly);
      repCtx.rotate(labelAngle);
      repCtx.font = `${labelFontPx}px Inter, sans-serif`;
      repCtx.textAlign = 'center';
      repCtx.textBaseline = 'middle';
      const tw = repCtx.measureText(label).width;
      repCtx.fillStyle = isLight ? 'rgba(248,250,252,0.9)' : 'rgba(13,17,23,0.86)';
      repCtx.beginPath();
      repCtx.roundRect(-tw / 2 - 3, -6, tw + 6, 12, 3);
      repCtx.fill();
      repCtx.fillStyle = isLight ? '#1f2937' : '#e5e7eb';
      repCtx.fillText(label, 0, 0);
      repCtx.restore();
    });

    const nodeTypeMap = new Map(state.nodeTypes.map(t => [t.id, t]));
    const nodeRadius = Math.max(4, Math.min(10, NODE_RADIUS * Math.sqrt(scale) * 0.62));

    state.nodes.forEach((node) => {
      const p = toPoint(node);
      const nt = nodeTypeMap.get(node.typeId) || { name: node.typeId, color: '#8b949e' };
      const isDoor = node.typeId === 'door';

      repCtx.save();
      if (isDoor) {
        const widthFactor = getDoorWidthFactor(node);
        const halfLong = nodeRadius * 1.12 * widthFactor;
        const halfShort = Math.max(2.2, nodeRadius * 0.34);
        const angle = getDoorAxisAngle(node);

        repCtx.translate(p.x, p.y);
        repCtx.rotate(angle);
        repCtx.beginPath();
        repCtx.roundRect(-halfLong, -halfShort, halfLong * 2, halfShort * 2, 2.5);
        repCtx.fillStyle = nt.color || '#d29922';
        repCtx.fill();
        repCtx.strokeStyle = isLight ? 'rgba(30,41,59,0.7)' : 'rgba(13,17,23,0.8)';
        repCtx.lineWidth = 1;
        repCtx.stroke();
      } else {
        repCtx.beginPath();
        repCtx.arc(p.x, p.y, nodeRadius, 0, Math.PI * 2);
        repCtx.fillStyle = nt.color || '#8b949e';
        repCtx.fill();
        repCtx.strokeStyle = isLight ? 'rgba(30,41,59,0.7)' : 'rgba(13,17,23,0.8)';
        repCtx.lineWidth = 1;
        repCtx.stroke();
      }
      repCtx.restore();

      const peopleCount = Number.isFinite(Number(node.people)) ? Number(node.people) : 0;
      const peopleLabel = Math.abs(peopleCount - Math.round(peopleCount)) < 0.01
        ? String(Math.round(peopleCount))
        : formatNumeric(peopleCount, 2, '0');
      repCtx.save();
      repCtx.font = `${Math.max(7, Math.min(9.5, nodeRadius * 0.92))}px Inter, sans-serif`;
      repCtx.fillStyle = isLight ? '#0f172a' : '#f8fafc';
      repCtx.textAlign = 'center';
      repCtx.textBaseline = 'middle';
      repCtx.fillText(peopleLabel, p.x, p.y);
      repCtx.restore();

      repCtx.save();
      repCtx.font = `${Math.max(8, Math.min(10.5, nodeRadius * 0.9))}px Inter, sans-serif`;
      repCtx.fillStyle = isLight ? '#1f2937' : '#d1d5db';
      repCtx.textAlign = 'center';
      repCtx.textBaseline = 'top';
      repCtx.fillText(node.name || `Node ${node.id}`, p.x, p.y + nodeRadius + 3);
      repCtx.restore();
    });

    const scaleCandidates = [1, 2, 5, 10, 20];
    let scaleMeters = 1;
    for (const candidate of scaleCandidates) {
      const px = candidate * PIXELS_PER_METER * scale;
      if (px >= 60 && px <= 180) {
        scaleMeters = candidate;
      }
    }
    const scalePx = scaleMeters * PIXELS_PER_METER * scale;
    const barX = cssW - 190;
    const barY = cssH - 26;
    repCtx.save();
    repCtx.strokeStyle = isLight ? '#334155' : '#e5e7eb';
    repCtx.lineWidth = 2;
    repCtx.beginPath();
    repCtx.moveTo(barX, barY);
    repCtx.lineTo(barX + scalePx, barY);
    repCtx.moveTo(barX, barY - 4);
    repCtx.lineTo(barX, barY + 4);
    repCtx.moveTo(barX + scalePx, barY - 4);
    repCtx.lineTo(barX + scalePx, barY + 4);
    repCtx.stroke();
    repCtx.font = '10px Inter, sans-serif';
    repCtx.fillStyle = isLight ? '#334155' : '#e5e7eb';
    repCtx.textAlign = 'center';
    repCtx.textBaseline = 'bottom';
    repCtx.fillText(`${scaleMeters} m`, barX + scalePx / 2, barY - 6);
    repCtx.restore();
  }

  function getReportTableColumns(report = lastReportContext) {
    const method = report?.method || (state.calculationMethod === 'B' ? 'B' : 'A');
    const showDensity = method === 'A';
    const showFlow = method === 'B';
    const showLengthWarnings = !!(report && report.lengthMismatchCount > 0);

    const cols = [
      { key: 'step', label: 'Step', align: 'center' },
      { key: 'conn', label: 'Conn', align: 'center' },
      { key: 'from', label: 'From', align: 'left' },
      { key: 'to', label: 'To', align: 'left' },
      { key: 'type', label: 'Type', align: 'left' },
      { key: 'dir', label: 'Dir', align: 'center' },
      { key: 'length', label: 'Length (m)', align: 'right' },
      { key: 'width', label: 'Width (m)', align: 'right' },
      { key: 'people', label: 'People In', align: 'right' },
    ];

    if (showDensity) {
      cols.push({ key: 'density', label: 'Density', align: 'right' });
    }
    if (showFlow) {
      cols.push({ key: 'q', label: 'q', align: 'right' });
      cols.push({ key: 'Q', label: 'Q', align: 'right' });
    }

    cols.push({ key: 'speed', label: 'Speed', align: 'right' });
    cols.push({ key: 'time', label: 'Time (min)', align: 'right' });
    if (showLengthWarnings) {
      cols.push({ key: 'lengthWarning', label: 'Length Warning', align: 'left' });
    }
    cols.push({ key: 'congestion', label: 'Congestion', align: 'center' });
    return cols;
  }

  function getReportTableCellText(row, key) {
    const peopleText = Number.isFinite(row.peopleIn)
      ? (Math.abs(row.peopleIn - Math.round(row.peopleIn)) < 0.01
        ? String(Math.round(row.peopleIn))
        : formatNumeric(row.peopleIn, 2))
      : '--';
    const timeText = row.time >= 9999 ? 'Inf' : formatNumeric(row.time, 3);

    if (key === 'step') return String(row.step);
    if (key === 'conn') return `#${row.connId}`;
    if (key === 'from') return row.fromName;
    if (key === 'to') return row.toName;
    if (key === 'type') return row.typeName;
    if (key === 'dir') return row.directionLabel;
    if (key === 'length') return formatNumeric(row.length, 2);
    if (key === 'width') return formatNumeric(row.width, 2);
    if (key === 'people') return peopleText;
    if (key === 'density') return formatNumeric(row.density, 2);
    if (key === 'q') return formatNumeric(row.q, 2);
    if (key === 'Q') return formatNumeric(row.Q, 2);
    if (key === 'speed') return formatNumeric(row.speed, 2);
    if (key === 'time') return timeText;
    if (key === 'lengthWarning') {
      if (!row.lengthMismatch) return '-';
      return `Specified ${formatNumeric(row.specifiedLength, 2)} m, using ${formatNumeric(row.length, 2)} m`;
    }
    if (key === 'congestion') return row.severityLabel;
    return '';
  }

  function getReportTableCellHtml(row, key) {
    if (key === 'congestion') {
      return `<span class="report-badge badge-${row.severity}">${escHtml(row.severityLabel)}</span>`;
    }
    if (key === 'lengthWarning' && row.lengthMismatch) {
      return `<span class="report-inline-warning">${escHtml(getReportTableCellText(row, key))}</span>`;
    }
    return escHtml(getReportTableCellText(row, key));
  }

  function generateReportTable(report = lastReportContext) {
    if (!reportTableBody) return;
    const columns = getReportTableColumns(report);

    if (reportTableHead) {
      reportTableHead.innerHTML = `<tr>${columns.map((col) => (
        `<th class="align-${col.align}">${escHtml(col.label)}</th>`
      )).join('')}</tr>`;
    }

    if (!report || report.rows.length === 0) {
      reportTableBody.innerHTML = `<tr><td colspan="${columns.length}">No connection data available.</td></tr>`;
      return;
    }

    reportTableBody.innerHTML = report.rows.map((row) => (
      `<tr class="${row.rowClass}">
        ${columns.map((col) => `<td class="align-${col.align}">${getReportTableCellHtml(row, col.key)}</td>`).join('')}
      </tr>`
    )).join('');
  }

  function generateMathProof(report = lastReportContext) {
    if (!mathProofContent) return;
    if (!report) {
      mathProofContent.textContent = 'No report data available.';
      return;
    }

    const lines = [];
    lines.push('SALAMANDER EVACUATION REPORT - DETAILED MATHEMATICAL LOG');
    lines.push(`Generated At: ${report.generatedAtDisplay}`);
    lines.push(`Calculation Method: ${report.methodLabel}`);
    lines.push(`Graph Size: ${report.graphSizeLabel}`);
    lines.push(`Total People: ${Math.round(report.totalPeople)}`);
    lines.push(`Total Evacuation Time: ${formatNumeric(report.totalTime, 3, '0.000')} min`);
    lines.push(`Connections Reviewed: ${report.rows.length}`);
    lines.push(`Bottlenecks: ${report.bottleneckCount} (blocked: ${report.blockedCount}, queued: ${report.queueCount})`);
    if (report.lengthMismatchCount > 0) {
      lines.push(`Length Warnings: ${report.lengthMismatchCount} connections deviate from user-specified length.`);
    }
    lines.push('');
    lines.push('REGULATORY BASELINE');
    lines.push('- Regulation Source: Ordinance Iz-1971, Annex 8a');
    lines.push('- Flow and speed lookup: Table 11');
    lines.push('- Segment geometry precision: length 0.05 m, width 0.05 m');
    lines.push('- Total evacuation time precision: 0.001 min');
    lines.push('');
    lines.push('SEGMENT-BY-SEGMENT CALCULATION');
    lines.push('----------------------------------------');

    if (report.rows.length === 0) {
      lines.push('No segment rows were available. Add connected nodes and rerun the report.');
    }

    report.rows.forEach((row) => {
      lines.push(`Segment ${row.step} | Connection #${row.connId} | ${row.fromName} -> ${row.toName}`);
      lines.push(`  Type: ${row.typeName} | Direction: ${row.directionLabel}`);
      lines.push(`  Geometry: L=${formatNumeric(row.length, 2)} m, W=${formatNumeric(row.width, 2)} m`);
      if (row.lengthMismatch) {
        lines.push(`  WARNING: specified length ${formatNumeric(row.specifiedLength, 2)} m differs from used length ${formatNumeric(row.length, 2)} m.`);
      }
      lines.push(`  Input People Basis: ${formatNumeric(row.peopleIn, 2)} persons`);

      if (state.calculationMethod === 'B') {
        lines.push(`  Flow Inputs: q=${formatNumeric(row.q, 2)} p/m/min, Q=${formatNumeric(row.Q, 2)} p/min`);
        lines.push(`  Limit Check: q_max=${formatNumeric(row.qMax, 2)} p/m/min, q_gran=${formatNumeric(row.qGran, 2)} p/m/min`);
        if (row.hasQueue || row.severity === 'blocked') {
          const ds = row.dynamicStats || {};
          lines.push('  Queue Branch: capacity-limited movement detected.');
          lines.push(`  Queue Dynamics: N_total=${formatNumeric(ds.N_total, 2, '0.00')}, N_eff=${formatNumeric(ds.N_eff, 2, '0.00')}, t_fill=${formatNumeric(ds.t_filling, 4, '0.0000')} min`);
          lines.push('  Time Equation Used: t = L / v_gran + N_eff * (1 / Q_out - 1 / Q_in)');
          lines.push(`  Boundary Speed: v_gran=${formatNumeric(row.vGran, 2)} m/min`);
        } else {
          lines.push('  Free-Flow Branch: no queue formation on this segment.');
          lines.push('  Time Equation Used: t = L / v');
        }
      } else {
        lines.push(`  Density-Based Branch: D=${formatNumeric(row.density, 2)} p/m2, v=${formatNumeric(row.speed, 2)} m/min`);
        lines.push('  Time Equation Used: t = L / v');
      }

      lines.push(`  Segment Result: t=${formatNumeric(row.time, 4)} min, congestion=${row.severityLabel}`);
      lines.push('');
    });

    lines.push('CRITICAL EXIT REVIEW');
    lines.push('----------------------------------------');
    const exits = state.nodes.filter(n => n.typeId === 'exit');
    if (exits.length === 0) {
      lines.push('No exit nodes defined. Total time is based on maximum reachable node time.');
    } else {
      exits.forEach((exitNode) => {
        lines.push(`Exit ${exitNode.name || `Node ${exitNode.id}`}: maxTime=${formatNumeric(exitNode.maxTime, 4)} min`);
      });
    }
    lines.push(`FINAL EVACUATION RESULT = ${formatNumeric(report.totalTime, 3, '0.000')} min`);
    lines.push('');
    lines.push('INTERPRETATION');
    if (report.bottleneckCount === 0) {
      lines.push('- Network currently operates in non-congested regime for computed conditions.');
    } else {
      lines.push(`- ${report.bottleneckCount} segments are near or above safe operating capacity.`);
      lines.push('- Review widths, route alternatives, and layout ordering to reduce queue propagation.');
    }
    if (report.maxTimeRow) {
      lines.push(`- Longest time contribution: Connection #${report.maxTimeRow.connId} (${report.maxTimeRow.fromName} -> ${report.maxTimeRow.toName}) at ${formatNumeric(report.maxTimeRow.time, 3)} min.`);
    }
    if (report.maxDensityRow) {
      lines.push(`- Peak density observed on Connection #${report.maxDensityRow.connId} at ${formatNumeric(report.maxDensityRow.density, 2)} p/m2.`);
    }

    mathProofContent.textContent = lines.join('\n');
  }

  function exportReportPdf() {
    state.metadata = normalizeMetadata({
      ...state.metadata,
      exportedAt: toLocalDateTimeValue(),
    });
    if (metaExportedAtInput) metaExportedAtInput.value = state.metadata.exportedAt || '';

    const report = buildReportContext(true);
    lastReportContext = report;
    generateReportSummary(report);
    generateReportTable(report);
    generateMathProof(report);
    generateReportDiagram(report, { theme: 'light' });

    if (!reportCanvas) {
      alert('Report diagram is not available for export.');
      return;
    }

    const diagramDataUrl = reportCanvas.toDataURL('image/png');
    generateReportDiagram(report, { theme: 'dark' });
    render();
    const proofHtml = escHtml(mathProofContent ? mathProofContent.textContent : '').replace(/\n/g, '<br>');

    const tableColumns = getReportTableColumns(report);
    const tableHeaderHtml = tableColumns.map((col) => `<th>${escHtml(col.label)}</th>`).join('');
    const tableRows = report.rows.map((row) => (
      `<tr>${tableColumns.map((col) => `<td>${escHtml(getReportTableCellText(row, col.key))}</td>`).join('')}</tr>`
    )).join('');

    const meta = report.metadata || {};
    const summaryItems = [
      ['Total Evacuation Time', `${formatNumeric(report.totalTime, 3)} min`],
      ['Total People', String(Math.round(report.totalPeople))],
      ['Critical Exits', String(report.criticalExits.length)],
      ['Connections', String(report.connectionCount)],
      ['Bottlenecks', String(report.bottleneckCount)],
      ['Blocked', String(report.blockedCount)],
      ['Queued', String(report.queueCount)],
      ['Length Warnings', String(report.lengthMismatchCount)],
      ['Graph Size', report.graphSizeLabel],
      ['Method', report.methodLabel],
      ['Generated', report.generatedAtDisplay],
    ];

    const metaItems = [
      ['Project', meta.project || 'Untitled'],
      ['Author', meta.author || '-'],
      ['Company', meta.company || '-'],
      ['Scenario Date/Time', formatDateTimeForDisplay(meta.dateTime)],
      ['Created', formatDateTimeForDisplay(meta.createdAt)],
      ['Exported', formatDateTimeForDisplay(meta.exportedAt)],
      ['Salamander Version', meta.salamanderVersion || SALAMANDER_VERSION],
      ['Notes', meta.notes || '-'],
    ];

    const printWindow = window.open('', '_blank');
    if (!printWindow) {
      alert('Popup blocked. Please allow popups to export report PDF.');
      return;
    }

    printWindow.document.write(`<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <title>Salamander Report PDF</title>
  <style>
    :root { color-scheme: light; }
    * { box-sizing: border-box; }
    body { font-family: "Segoe UI", Arial, sans-serif; margin: 0; color: #111827; background: #ffffff; }
    .page { padding: 22px 26px; }
    h1 { margin: 0 0 4px; font-size: 22px; }
    h2 { margin: 18px 0 10px; font-size: 16px; border-bottom: 1px solid #d1d5db; padding-bottom: 5px; }
    p { margin: 6px 0; line-height: 1.45; }
    .muted { color: #4b5563; font-size: 12px; }
    .cards { display: grid; grid-template-columns: repeat(5, minmax(120px, 1fr)); gap: 8px; margin: 12px 0 14px; }
    .card { border: 1px solid #d1d5db; border-radius: 6px; padding: 8px; }
    .card .label { font-size: 11px; color: #6b7280; text-transform: uppercase; letter-spacing: .3px; }
    .card .value { font-size: 14px; font-weight: 600; margin-top: 4px; word-break: break-word; }
    .meta-grid { display: grid; grid-template-columns: repeat(2, minmax(180px, 1fr)); gap: 8px; margin-top: 8px; }
    .meta-item { border: 1px solid #e5e7eb; border-radius: 6px; padding: 8px; }
    .meta-item .label { font-size: 11px; color: #6b7280; text-transform: uppercase; }
    .meta-item .value { font-size: 13px; margin-top: 3px; white-space: pre-wrap; word-break: break-word; }
    .diagram { margin-top: 10px; border: 1px solid #d1d5db; border-radius: 6px; overflow: hidden; padding: 6px; background: #f9fafb; }
    .diagram img { width: 100%; height: auto; display: block; }
    table { width: 100%; border-collapse: collapse; font-size: 10px; margin-top: 8px; }
    thead { display: table-header-group; }
    tr { break-inside: avoid; }
    th, td { border: 1px solid #d1d5db; padding: 4px 5px; text-align: left; vertical-align: top; }
    th { background: #f3f4f6; font-weight: 600; }
    .proof { border: 1px solid #d1d5db; border-radius: 6px; padding: 10px; font-size: 10.5px; line-height: 1.4; white-space: pre-wrap; word-break: break-word; }
    @media print {
      .page { padding: 12mm; }
      .page-break { page-break-before: always; }
      @page { size: A4 landscape; margin: 10mm; }
    }
  </style>
</head>
<body>
  <div class="page">
    <h1>Salamander Evacuation Report</h1>
    <div class="muted">Generated: ${escHtml(report.generatedAtDisplay)}</div>
    <div class="muted">Method: ${escHtml(report.methodLabel)}</div>

    <h2>Executive Summary</h2>
    <div class="cards">
      ${summaryItems.map(([label, value]) => `<div class="card"><div class="label">${escHtml(label)}</div><div class="value">${escHtml(value)}</div></div>`).join('')}
    </div>
    <p><strong>Interpretation:</strong> This report captures the current network geometry, applied movement method, queue/capacity behavior, and segment-by-segment timing contribution to the final evacuation duration.</p>
    <p><strong>Risk Notes:</strong> ${report.bottleneckCount > 0 ? `${report.bottleneckCount} bottleneck segments were detected and should be reviewed for added width, reduced load, or alternate routing.` : 'No bottleneck segments were detected in the current state.'}</p>

    <h2>Project Metadata</h2>
    <div class="meta-grid">
      ${metaItems.map(([label, value]) => `<div class="meta-item"><div class="label">${escHtml(label)}</div><div class="value">${escHtml(value)}</div></div>`).join('')}
    </div>

    <h2>Graph Diagram</h2>
    <div class="diagram">
      <img src="${diagramDataUrl}" alt="Report Diagram" />
    </div>
  </div>

  <div class="page page-break">
    <h2>Detailed Connection Table</h2>
    <table>
      <thead>
        <tr>${tableHeaderHtml}</tr>
      </thead>
      <tbody>
        ${tableRows || `<tr><td colspan="${tableColumns.length}">No connection data available.</td></tr>`}
      </tbody>
    </table>
  </div>

  <div class="page page-break">
    <h2>Verbose Mathematical Report</h2>
    <div class="proof">${proofHtml}</div>
  </div>
</body>
</html>`);

    printWindow.document.close();
    printWindow.focus();
    setTimeout(() => {
      printWindow.print();
    }, 350);
  }

  function selectItem(item, multi = false) {
    if (!item) return;
    const key = `${item.type}:${item.id}`;

    if (!multi) {
      selectedItems.clear();
      selectedItems.add(key);
    } else {
      if (selectedItems.has(key)) {
        selectedItems.delete(key);
      } else {
        selectedItems.add(key);
      }
    }
    updatePropertiesPanel();
    render();
  }

  function clearSelection() {
    selectedItems.clear();
    updatePropertiesPanel();
    render();
  }

  function sanitizeSelection() {
    const next = new Set();
    selectedItems.forEach(key => {
      const [type, idStr] = key.split(':');
      const id = parseInt(idStr, 10);
      if (type === 'node' && state.nodes.some(n => n.id === id)) next.add(key);
      if (type === 'connection' && state.connections.some(c => c.id === id)) next.add(key);
    });
    selectedItems = next;
  }

  function deleteSelection() {
    if (selectedItems.size === 0) return;

    let changed = false;
    // Convert to array to avoid modification during iteration issues
    const keys = Array.from(selectedItems);
    keys.forEach(key => {
      const [type, idStr] = key.split(':');
      const id = parseInt(idStr);
      if (type === 'node') {
        deleteNode(id, { skipHistory: true });
        changed = true;
      } else if (type === 'connection') {
        deleteConnection(id, { skipHistory: true });
        changed = true;
      }
    });

    clearSelection();
    if (changed) commitHistory();
  }

  // ─── Properties Panel Logic ──────────────────────────────
  function updatePropertiesPanel() {
    sanitizeSelection();
    // Clear content
    propsContent.innerHTML = '';

    if (selectedItems.size === 0) {
      propsContent.appendChild(sidebarEmpty);
      sidebarEmpty.style.display = 'flex';
      return;
    }
    sidebarEmpty.style.display = 'none';

    // Group selection by type
    const selNodes = [];
    const selConns = [];

    selectedItems.forEach(key => {
      const [type, idStr] = key.split(':');
      const id = parseInt(idStr);
      if (type === 'node') {
        const n = state.nodes.find(x => x.id === id);
        if (n) selNodes.push(n);
      } else {
        const c = state.connections.find(x => x.id === id);
        if (c) selConns.push(c);
      }
    });

    const totalSelected = selNodes.length + selConns.length;
    if (totalSelected === 0) return;

    // Header updates
    propsHeader.innerHTML = `
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
        <line x1="3" y1="9" x2="21" y2="9" />
        <line x1="9" y1="21" x2="9" y2="9" />
      </svg>
      Editing ${totalSelected} Item${totalSelected > 1 ? 's' : ''}
    `;

    // 1. Common Properties (Node)
    if (selNodes.length > 0) {
      const section = document.createElement('div');
      section.className = 'prop-section';
      section.innerHTML = `<h4>Node Properties (${selNodes.length})</h4>`;

      // Name (Single only)
      if (selNodes.length === 1) {
        section.appendChild(createPropInput('Name', 'text', selNodes[0].name, (val) => {
          selNodes[0].name = val;
          commitHistory();
          render();
        }));

        // Coordinates (Read-only)
        section.appendChild(createPropInput('X', 'number', selNodes[0].x, () => { }, true));
        section.appendChild(createPropInput('Y', 'number', selNodes[0].y, () => { }, true));
      }

      // Type
      const commonTypeId = getCommonValue(selNodes, n => n.typeId);
      section.appendChild(createPropSelect('Type', state.nodeTypes, commonTypeId, (val) => {
        selNodes.forEach(n => {
          n.typeId = val;
          if (val === 'door' && (!n.width || n.width <= 0)) n.width = 1.2;
        });
        recalcPeopleCounts();
        commitHistory();
        render();
      }));

      const commonPinned = getCommonValue(selNodes, n => !!n.pinned);
      const pinnedValue = commonPinned === '<various>' ? '<various>' : String(commonPinned);
      section.appendChild(createPropSelect('Pinned (Order Graph)', [
        { id: 'false', name: 'No' },
        { id: 'true', name: 'Yes' },
      ], pinnedValue, (val) => {
        const isPinned = val === 'true';
        selNodes.forEach(n => n.pinned = isPinned);
        commitHistory();
        render();
      }));

      // People (Source nodes only)
      const sourceNodes = selNodes.filter(n => ['start', 'start2'].includes(n.typeId));
      if (sourceNodes.length > 0) {
        const commonPeople = getCommonValue(sourceNodes, n => n.people || 0);
        section.appendChild(createPropInput('People (Start)', 'number', commonPeople, (val) => {
          sourceNodes.forEach(n => n.people = parseInt(val) || 0);
          recalcPeopleCounts();
          commitHistory();
          render();
        }, sourceNodes.length !== selNodes.length)); // Disable if mixed source/non-source? No, just apply to sources.
      }

      // Door width (Door nodes only)
      const doorNodes = selNodes.filter(n => n.typeId === 'door');
      if (doorNodes.length > 0) {
        const commonDoorWidth = getCommonValue(doorNodes, n => roundWidthMeters(n.width || 1.2));
        section.appendChild(createPropInput('Door Width (m)', 'number', commonDoorWidth, (val) => {
          const w = Math.max(0.05, roundWidthMeters(parseFloat(val) || 1.2));
          doorNodes.forEach(n => n.width = w);
          commitHistory();
          render();
        }, doorNodes.length !== selNodes.length, '0.05'));
      }

      propsContent.appendChild(section);
    }

    // 2. Common Properties (Connection)
    if (selConns.length > 0) {
      const section = document.createElement('div');
      section.className = 'prop-section';
      section.innerHTML = `<h4>Connection Properties (${selConns.length})</h4>`;

      // Type
      const commonTypeId = getCommonValue(selConns, c => c.typeId);
      section.appendChild(createPropSelect('Type', state.connTypes, commonTypeId, (val) => {
        selConns.forEach(c => c.typeId = val);
        commitHistory();
        render();
      }));

      // Width
      const commonWidth = getCommonValue(selConns, c => c.width || 1.2);
      section.appendChild(createPropInput('Width (m)', 'number', commonWidth, (val) => {
        const widthVal = roundWidthMeters(parseFloat(val) || 1.2);
        const clamped = Math.max(0.05, widthVal);
        selConns.forEach(c => c.width = clamped);
        recalcFireSafety();
        commitHistory();
        render();
      }, false, '0.05'));

      // Distance
      const commonDist = getCommonValue(selConns, c => c.distance);
      section.appendChild(createPropInput('Distance (m)', 'number', commonDist, (val) => {
        const v = parseFloat(val);
        if (!isNaN(v) && v > 0) {
          const desired = Math.max(GRID_SIZE_METERS, roundDistanceMeters(v));
          let changed = false;
          selConns.forEach(c => {
            changed = forceConnectionDistanceGeometry(c, desired) || changed;
          });
          if (!changed) return;
          updateConnectionDistances();
          commitHistory();
          updatePropertiesPanel();
          render();
        }
      }, false, '0.05'));

      const mismatchItems = selConns
        .map((c) => ({ conn: c, info: getConnectionLengthDeltaInfo(c) }))
        .filter((x) => x.info.mismatch);
      if (mismatchItems.length > 0) {
        const warn = document.createElement('div');
        warn.className = 'prop-inline-warning';
        const preview = mismatchItems.slice(0, 3).map((x) => (
          `#${x.conn.id}: ${formatNumeric(x.info.specified, 2)} -> ${formatNumeric(x.info.actual, 2)} m`
        )).join('; ');
        const suffix = mismatchItems.length > 3 ? ` (+${mismatchItems.length - 3} more)` : '';
        warn.textContent = `Warning: ${mismatchItems.length} selected connection lengths differ from specified values. ${preview}${suffix}`;
        section.appendChild(warn);
      }

      propsContent.appendChild(section);
    }
  }

  // Helper to create inputs
  function createPropInput(label, type, value, onChange, disabled = false, stepOverride = null) {
    const div = document.createElement('div');
    div.className = 'prop-group' + (value === '<various>' ? ' various' : '');
    const id = `prop-${label.replace(/\s+/g, '-')}-${Math.random().toString(36).substr(2, 5)}`;

    div.innerHTML = `<label for="${id}">${label}</label>`;
    const input = document.createElement('input');
    input.type = type === 'number' ? 'number' : 'text';
    input.id = id;
    if (type === 'number') input.step = stepOverride || '0.1';

    if (value === '<various>') {
      input.value = ''; // empty input to show placeholder
      input.placeholder = '<various>';
    } else {
      input.value = value;
    }

    if (disabled) input.disabled = true;

    input.addEventListener('change', (e) => {
      const val = e.target.value;
      if (val !== '') { // Only trigger change if value is not empty (unless clearing?)
        onChange(val);
      }
    });
    div.appendChild(input);
    return div;
  }

  function createPropSelect(label, options, value, onChange) {
    const div = document.createElement('div');
    div.className = 'prop-group' + (value === '<various>' ? ' various' : '');
    const id = `prop-${label.replace(/\s+/g, '-')}-${Math.random().toString(36).substr(2, 5)}`;

    div.innerHTML = `<label for="${id}">${label}</label>`;
    const select = document.createElement('select');
    select.id = id;

    // Add options
    options.forEach(opt => {
      const el = document.createElement('option');
      el.value = opt.id;
      el.textContent = opt.name;
      select.appendChild(el);
    });

    if (value === '<various>') {
      const varOpt = document.createElement('option');
      varOpt.value = '';
      varOpt.textContent = '<various>';
      varOpt.selected = true;
      select.prepend(varOpt);
    } else {
      select.value = value;
    }

    select.addEventListener('change', (e) => onChange(e.target.value));
    div.appendChild(select);
    return div;
  }

  function getCommonValue(items, getter) {
    if (items.length === 0) return null;
    const first = getter(items[0]);
    for (let i = 1; i < items.length; i++) {
      if (getter(items[i]) !== first) return '<various>';
    }
    return first;
  }

  // ─── Legend ──────────────────────────────────────────────
  function renderLegend() {
    if (!legendContent) return;
    legendContent.innerHTML = '';

    // Nodes
    state.nodeTypes.forEach(t => {
      const item = document.createElement('div');
      item.className = 'legend-item';
      item.innerHTML = `
        <div class="legend-dot" style="background:${t.color}"></div>
        <span>${t.name}</span>
      `;
      legendContent.appendChild(item);
    });

    // Connections
    state.connTypes.forEach(t => {
      const item = document.createElement('div');
      item.className = 'legend-item';
      // Dashed line viz
      const dash = t.dash.length > 0 ? 'dashed' : 'solid';
      item.innerHTML = `
        <div class="legend-line" style="background:${t.color}; border-bottom:${dash === 'dashed' ? '1px dashed' : 'none'}"></div>
        <span>${t.name}</span>
      `;
      legendContent.appendChild(item);
    });
  }

  // Utils
  function colorToHex(color) {
    const ctx = document.createElement('canvas').getContext('2d');
    ctx.fillStyle = color;
    return ctx.fillStyle;
  }
  // Expose for table clicks
  window.selectNode = (id) => selectItem({ type: 'node', id });
  window.selectConnection = (id) => selectItem({ type: 'connection', id });
})();

