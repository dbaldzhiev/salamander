/**
 * ═══════════════════════════════════════════════════════════════
 *  Salamander Core — Evacuation Time Calculator
 *  Source: Ordinance Iz-1971, Annex 8a (DV бр. 91/2024)
 *  Bulgarian Fire Safety Evacuation Norms
 * ═══════════════════════════════════════════════════════════════
 */

let fs = null;
if (typeof require === 'function') {
    try {
        fs = require('fs');
    } catch (err) {
        fs = null;
    }
}

class SalamanderCore {
    constructor(regulations) {
        this.state = {
            nodes: [],
            connections: [],
            regulations: regulations,
            calculationMethod: 'B',
            totalEvacuationTime: 0
        };
    }

    loadGraph(graphData) {
        this.state.nodes = graphData.nodes || [];
        this.state.connections = graphData.connections || [];
        this.state.nodeTypes = graphData.nodeTypes || [];
        this.state.connTypes = graphData.connTypes || [];
    }

    // ─── Helpers ──────────────────────────────────────────────

    /**
     * Maps a connection's typeId to the internal segment type key
     * used for Table 11 column lookup and limits lookup.
     *
     *   'stairs_up'   → 'stair_up'
     *   'stairs_down' → 'stair_down'
     *   'door_*'      → 'door_wide'
     *   everything else → 'horiz'
     *
     * [Annex 8a, I.2: path is divided into segments by type]
     */
    _resolveSegType(typeId) {
        if (typeId === 'stairs_up') return 'stair_up';
        if (typeId === 'stairs_down') return 'stair_down';
        if (typeId && typeId.includes('door')) return 'door_wide';
        return 'horiz';
    }

    /**
     * Extracts the geometric & population parameters for a connection.
     * Width is snapped to 0.05m increments, min 0.05m.
     * [Annex 8a, I.4: Aᵢ = ℓᵢ · δᵢ]
     * [Annex 8a, I.6: ℓᵢ = geometric centreline length]
     * [Annex 8a, I.9: δᵢ = clear geometric width]
     */
    getSegmentParams(conn) {
        if (!this.state.regulations) return null;

        const type = this._resolveSegType(conn.typeId);

        // Prioritize conn.width, fallback to 1.2
        let width = (conn.width !== undefined && conn.width !== null) ? Number(conn.width) : 1.2;
        if (isNaN(width) || width <= 0) width = 1.2;
        width = Math.max(0.05, Math.round(width * 20) / 20);
        conn.width = width;

        const length = conn.distance || 0;
        const src = this.state.nodes.find(n => n.id === conn.sourceId);
        const people = src ? (src.people || 0) : 0;

        return { type, width, length, people };
    }

    /**
     * Look up velocity (v) and specific throughput (q) from Table 11
     * for the given segment type at the given density D.
     *
     * Per [Annex 8a, III.2]: "for intermediate density values,
     * take the nearest higher value of Dₐᵢ from Table 11."
     *
     * @param {string} segType - 'horiz', 'stair_down', 'stair_up', 'door_wide'
     * @param {number} density - D [pers/m²]
     * @returns {{ v: number, q: number, D_used: number }}
     */
    lookupTable11(segType, density) {
        if (!this.state.regulations) return { v: 0, q: 0, D_used: 0 };
        const table = this.state.regulations.table_11_flow_params.data;

        // Map segType to column key in the JSON data
        const colName = (segType === 'horiz' || segType === 'stair_down' ||
            segType === 'stair_up' || segType === 'door_wide')
            ? segType : 'horiz';

        // Find the first row where D >= density (nearest higher)
        let row = table.find(r => r.D >= density);
        if (!row) row = table[table.length - 1];

        const val = row[colName];
        return { v: val.v, q: val.q, D_used: row.D };
    }

    /**
     * Reverse lookup in Table 11: given a specific throughput q,
     * find the row where the column's q >= q_curr (nearest higher q),
     * then return the corresponding velocity v.
     *
     * Per [Annex 8a, III.5(a)]: "the speed is read from Table 11
     * corresponding to the obtained value of qᵢ; for intermediate
     * values, take the nearest value corresponding to higher density."
     *
     * @param {string} segType - column key
     * @param {number} q_curr  - current specific throughput
     * @returns {{ v: number, q: number, D_used: number }}
     */
    reverseLookupTable11(segType, q_curr) {
        if (!this.state.regulations) return { v: 100, q: q_curr, D_used: 0 };
        const table = this.state.regulations.table_11_flow_params.data;

        const colName = (segType === 'horiz' || segType === 'stair_down' ||
            segType === 'stair_up' || segType === 'door_wide')
            ? segType : 'horiz';

        // Find the row where the column's q >= q_curr
        let row = table.find(r => {
            const cell = r[colName];
            return cell && cell.q >= q_curr;
        });
        if (!row) row = table[table.length - 1];

        const cell = row[colName];
        return { v: cell.v, q: cell.q, D_used: row.D };
    }

    /**
     * Look up narrow door parameters from Table 12.
     * For doors with width ≤ 1.6m at boundary density (D = 9.2).
     * Uses linear interpolation between tabulated widths.
     *
     * [Annex 8a, III.6(a), Table 12]
     *
     * @param {number} doorWidth - door width in metres
     * @returns {{ q: number, v: number } | null}
     */
    lookupTable12(doorWidth) {
        if (!this.state.regulations || !this.state.regulations.table_12_narrow_doors) return null;
        const table = this.state.regulations.table_12_narrow_doors.data;
        if (!table || table.length === 0) return null;
        if (doorWidth > 1.6) return null; // Table 12 only for doors ≤ 1.6m

        // Clamp to table range
        if (doorWidth <= table[0].width) return { q: table[0].q, v: table[0].v };
        if (doorWidth >= table[table.length - 1].width)
            return { q: table[table.length - 1].q, v: table[table.length - 1].v };

        // Linear interpolation
        for (let i = 0; i < table.length - 1; i++) {
            if (doorWidth >= table[i].width && doorWidth <= table[i + 1].width) {
                const t = (doorWidth - table[i].width) / (table[i + 1].width - table[i].width);
                return {
                    q: table[i].q + t * (table[i + 1].q - table[i].q),
                    v: table[i].v + t * (table[i + 1].v - table[i].v)
                };
            }
        }
        return { q: table[table.length - 1].q, v: table[table.length - 1].v };
    }

    /**
     * Returns the boundary/limit parameters for a segment type:
     *   q_max  — maximum physically possible specific throughput
     *   q_gran — boundary-condition specific throughput
     *   v_gran — boundary-condition velocity
     *
     * [Annex 8a, III.5(b): boundary-flow regime parameters]
     */
    getLimitParams(typeId) {
        if (!this.state.regulations || !this.state.regulations.limits)
            return { q_max: 164, q_gran: 135, v_gran: 14 };

        const limits = this.state.regulations.limits;
        let grp = limits.horizontal;
        if (typeId === 'stairs_up' || typeId === 'stair_up') grp = limits.stairs_up;
        else if (typeId === 'stairs_down' || typeId === 'stair_down') grp = limits.stairs_down;
        else if (typeId && typeId.includes('door')) grp = limits.doors;

        return {
            q_max: grp.q_max,
            q_gran: grp.q_gran,
            v_gran: grp.v_gran
        };
    }

    /**
     * Topological sort of connections (Kahn's algorithm).
     * Ensures segments are processed in dependency order:
     * upstream before downstream.
     */
    sortConnectionsTopologically() {
        // 1. Build adjacency
        const adj = new Map();
        this.state.nodes.forEach(n => adj.set(n.id, []));
        this.state.connections.forEach(c => {
            if (!adj.has(c.sourceId)) adj.set(c.sourceId, []);
            adj.get(c.sourceId).push(c);
        });

        // Node In-Degree
        const nodeInDegree = new Map();
        this.state.nodes.forEach(n => nodeInDegree.set(n.id, 0));
        this.state.connections.forEach(c => {
            const d = nodeInDegree.get(c.targetId) || 0;
            nodeInDegree.set(c.targetId, d + 1);
        });

        const nodeQueue = this.state.nodes.filter(n => (nodeInDegree.get(n.id) || 0) === 0);
        const sortedNodes = [];

        while (nodeQueue.length > 0) {
            const n = nodeQueue.shift();
            sortedNodes.push(n);

            const outConns = this.state.connections.filter(c => c.sourceId === n.id);
            outConns.forEach(c => {
                const tgtId = c.targetId;
                nodeInDegree.set(tgtId, (nodeInDegree.get(tgtId) || 0) - 1);
                if (nodeInDegree.get(tgtId) === 0) {
                    const tgtNode = this.state.nodes.find(x => x.id === tgtId);
                    if (tgtNode) nodeQueue.push(tgtNode);
                }
            });
        }

        // Fallback for cycles
        this.state.nodes.forEach(n => {
            if (!sortedNodes.includes(n)) sortedNodes.push(n);
        });

        // Flatten to connections
        const sortedConns = [];
        sortedNodes.forEach(n => {
            const out = this.state.connections.filter(c => c.sourceId === n.id);
            sortedConns.push(...out);
        });

        return sortedConns;
    }

    /**
     * Propagate the maximum accumulated time through the network
     * using iterative relaxation (Bellman-Ford style).
     * The total evacuation time is the maximum arrival time
     * at any exit node.
     *
     * [Annex 8a, III.7: τ_евак = Σ τᵢ over worst path]
     */
    propagateMaxTime() {
        this.state.nodes.forEach(n => n.maxTime = 0);
        for (let pass = 0; pass < this.state.nodes.length + 1; pass++) {
            let changed = false;
            for (const conn of this.state.connections) {
                const src = this.state.nodes.find(n => n.id === conn.sourceId);
                const tgt = this.state.nodes.find(n => n.id === conn.targetId);
                if (!src || !tgt) continue;

                const newTime = (src.maxTime || 0) + (conn.travelTime || 0);
                if (newTime > (tgt.maxTime || 0)) {
                    tgt.maxTime = newTime;
                    changed = true;
                }
            }
            if (!changed) break;
        }
        const exitNodes = this.state.nodes.filter(n => n.typeId === 'exit');
        let maxT = 0;
        if (exitNodes.length > 0) {
            maxT = Math.max(...exitNodes.map(n => n.maxTime));
        } else {
            maxT = Math.max(...this.state.nodes.map(n => n.maxTime), 0);
        }
        this.state.totalEvacuationTime = maxT;
    }

    // ─── Method A ─────────────────────────────────────────────
    /**
     * Method A — "Evacuation Path Length" method.
     * [Annex 8a, Section II]
     *
     * For each segment: compute density D = N / A,
     * look up v from Table 11, then τ = ℓ / v.
     */
    calcMethodA() {
        this.state.calculationMethod = 'A';
        this.state.connections.forEach(conn => {
            const p = this.getSegmentParams(conn);
            if (!p) { conn.travelTime = 0; return; }

            const area = p.length * p.width;
            const density = area > 0 ? p.people / area : 0;
            const { v } = this.lookupTable11(p.type, density);
            conn.travelTime = v > 0.1 ? p.length / v : 9999;
            conn.calcStats = { density, v, q: 0, time: conn.travelTime, method: 'A' };
        });
        this.propagateMaxTime();
    }

    // ─── Method B ─────────────────────────────────────────────
    /**
     * Method B — "Specific Throughput Capacity" method.
     * [Annex 8a, Section III]
     *
     * Process segments in topological order.
     * For initial segments: compute D, look up v & q from Table 11.
     * For subsequent segments: compute qᵢ = Σ(δᵢ₋₁·qᵢ₋₁) / δᵢ,
     *   then check if qᵢ > q_max (congestion).
     */
    calcMethodB() {
        this.state.calculationMethod = 'B';
        this.state.connections.forEach(c => {
            c.congestion = 'none';
            c.travelTime = 0;
            c.flowState = { Q_in: 0, q_spec: 0, Q_out: 0, hasQueue: false };
            c.dynamicStats = null;
        });

        const sortedConns = this.sortConnectionsTopologically();

        sortedConns.forEach(conn => {
            const src = this.state.nodes.find(n => n.id === conn.sourceId);
            const p = this.getSegmentParams(conn);
            if (!p || !src) return;

            let q_curr = 0, Q_curr = 0, v_curr = 0;
            const incomingConns = this.state.connections.filter(c => c.targetId === conn.sourceId);
            const isInitial = incomingConns.length === 0 || ['start', 'start2'].includes(src.typeId);
            const outConns = this.state.connections.filter(c => c.sourceId === conn.sourceId);
            const totalOutWidth = outConns.reduce((sum, c) => {
                const rawWidth = (c.width !== undefined && c.width !== null)
                    ? c.width
                    : (c.props && c.props.width);
                const parsed = parseFloat(rawWidth);
                return sum + (Number.isFinite(parsed) ? parsed : 1.2);
            }, 0);
            const splitRatio = totalOutWidth > 0 ? (p.width / totalOutWidth) : 1;
            const N_stream_max = Math.max(0, (Number(src.people) || 0) * splitRatio);

            if (isInitial) {
                /**
                 * Initial segment: density-based lookup.
                 * [Annex 8a, III.2-3]: D = Nᵢ / Aᵢ, look up v & q from Table 11.
                 * [Annex 8a, III.4]: τᵢ = ℓᵢ / vᵢ
                 */
                const area = p.length * p.width;
                const density = area > 0 ? N_stream_max / area : 0;
                const table = this.lookupTable11(p.type, density);
                v_curr = table.v;
                q_curr = table.q;
                Q_curr = q_curr * p.width;
                conn.travelTime = v_curr > 0.1 ? p.length / v_curr : 0;
            } else {
                /**
                 * Subsequent segment: flow-based computation.
                 * [Annex 8a, III.5]: qᵢ = Σ(δᵢ₋₁ · qᵢ₋₁) / δᵢ
                 * Q_in is the total volumetric flow from all upstream segments.
                 */
                let Q_total_in = 0;
                incomingConns.forEach(inc => {
                    Q_total_in += (inc.flowState ? inc.flowState.Q_out : 0);
                });
                Q_curr = Q_total_in * splitRatio;
                q_curr = p.width > 0 ? Q_curr / p.width : 0;
            }

            const limits = this.getLimitParams(p.type);
            const q_max = limits.q_max;
            let hasQueue = false;
            let final_Q_out = Q_curr;

            if (q_curr > q_max) {
                /**
                 * CONGESTION (Queue formation).
                 * [Annex 8a, III.5(b)]: qᵢ > q_max ⇒ movement at boundary density
                 * with parameters v_gran and q_gran.
                 *
                 * Formula: τᵢ = ℓᵢ/v_gran + Nᵢ,eff · [1/(q_gran·δᵢ) − 1/Σ(δᵢ₋₁·qᵢ₋₁)]
                 *
                 * [Annex 8a, I.11]: When computing Dₐᵢ, do not count people
                 * who have already left the segment before it fills up.
                 */
                hasQueue = true;
                conn.congestion = 'blocked';

                const N_total = N_stream_max;
                const Q_out = p.width * limits.q_gran;
                const Q_in = Q_curr;

                // Clause I.11: Dynamic reduction of N
                // The filling density uses N_total (the stream's people count
                // after split ratio), not p.people (raw source-node count).
                const area = p.length * p.width;
                const density = area > 0 ? N_total / area : 0;
                const table = this.lookupTable11(p.type, density);

                const v_density = table.v > 0.1 ? table.v : 100;
                const t_filling = v_density > 0.1 ? (p.length / v_density) : 0;
                const N_out_raw = Q_out * t_filling;
                const N_out = Math.max(0, Math.min(N_total, N_out_raw));
                const N_eff = Math.max(0, N_total - N_out);

                // Travel term: ℓ/v_gran (0 for thin-wall doors)
                let travelTerm = 0;
                if (p.type.includes('door') && p.length <= 0.7) {
                    travelTerm = 0; // [Annex 8a, I.5: doors in walls ≤ 0.7m → ℓ = 0]
                } else {
                    travelTerm = (limits.v_gran > 0.1) ? p.length / limits.v_gran : 0;
                }

                // Delay term: Nᵢ,eff · (1/Q_out − 1/Q_in)
                let delayTerm = 0;
                let delayKernel = 0;
                if (Q_out > 0.1 && Q_in > 0.1) {
                    const val = (1 / Q_out) - (1 / Q_in);
                    delayKernel = Math.max(0, val);
                    delayTerm = N_eff * delayKernel;
                } else if (Q_out > 0.1) {
                    delayKernel = 1 / Q_out;
                    delayTerm = N_eff / Q_out;
                }

                conn.dynamicStats = {
                    N_total,
                    N_stream_max,
                    splitRatio,
                    t_filling,
                    N_out,
                    N_eff,
                    v_density,
                    density,
                    segmentArea: area,
                    Q_in,
                    Q_out,
                    q_max: q_max,
                    q_gran: limits.q_gran,
                    v_gran: limits.v_gran,
                    delayKernel,
                    travelTerm,
                    delayTerm
                };

                conn.travelTime = travelTerm + delayTerm;
                final_Q_out = Q_out;

            } else {
                /**
                 * FREE FLOW — no congestion.
                 * [Annex 8a, III.5(a)]: qᵢ ≤ q_max ⇒ read v from Table 11
                 * corresponding to the obtained qᵢ.
                 * τᵢ = ℓᵢ / vᵢ
                 */
                conn.congestion = 'none';
                final_Q_out = Q_curr;
                conn.dynamicStats = null;
                if (!isInitial) {
                    // Reverse lookup: given q, find v from Table 11
                    const lookup = this.reverseLookupTable11(p.type, q_curr);
                    v_curr = lookup.v || 100;
                    conn.travelTime = v_curr > 0.1 ? p.length / v_curr : 0;
                }
            }

            // [Annex 8a, I.5]: Doors in walls ≤ 0.7m with NO queue → τ = 0
            if (p.type.includes('door') && p.length <= 0.7 && !hasQueue) {
                conn.travelTime = 0;
            }

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

        this.propagateMaxTime();
    }

    // ─── Math Proof ───────────────────────────────────────────

    /**
     * Generates a verbose, beautifully formatted mathematical proof
     * of the evacuation time calculation. Uses Unicode box-drawing
     * characters, Greek letters, and inline normative citations.
     *
     * @returns {string} The formatted proof text
     */
    generateMathProof() {
        const method = this.state.calculationMethod;
        const normRef = 'Ordinance Iz-1971, Annex 8a (DV бр. 91/2024)';
        const methodName = method === 'A'
            ? 'Method A — Evacuation Path Length (Annex 8a, Section II)'
            : 'Method B — Specific Throughput Capacity (Annex 8a, Section III)';

        let out = '';

        // ── Header ──────────────────────────────────────────
        out += `╔${'═'.repeat(64)}╗\n`;
        out += `║  EVACUATION TIME CALCULATION PROOF${' '.repeat(29)}║\n`;
        out += `║  ${methodName.substring(0, 62).padEnd(62)}║\n`;
        out += `║  Source: ${normRef.padEnd(54)}║\n`;
        out += `╚${'═'.repeat(64)}╝\n\n`;

        // ── Legend ──────────────────────────────────────────
        out += `  NOTATION\n`;
        out += `  ────────\n`;
        out += `  τᵢ   — evacuation time for segment i [min]\n`;
        out += `  ℓᵢ   — segment length [m]                    [Annex 8a, I.6]\n`;
        out += `  δᵢ   — segment width [m]                     [Annex 8a, I.9]\n`;
        out += `  Aᵢ   — segment area = ℓᵢ · δᵢ [m²]          [Annex 8a, I.4]\n`;
        out += `  Nᵢ   — number of people in segment i\n`;
        out += `  Dₐᵢ  — population density [pers/m²]          [Annex 8a, I.11]\n`;
        out += `  vᵢ   — movement speed [m/min]                [Table 11]\n`;
        out += `  qᵢ   — specific throughput [pers/m·min]      [Table 11]\n`;
        out += `  Qᵢ   — volumetric flow = qᵢ · δᵢ [pers/min]\n`;
        out += `  q_max — max throughput for segment type       [Annex 8a, III.5]\n`;
        out += `  v_гран — boundary speed [m/min]               [Table 11, D=9.2]\n`;
        out += `  q_гран — boundary throughput [pers/m·min]     [Table 11, D=9.2]\n`;
        out += `\n`;

        // ── Sort connections for display ─────────────────────
        const sortedConns = [...this.state.connections].sort((a, b) => {
            const srcA = this.state.nodes.find(n => n.id === a.sourceId);
            const srcB = this.state.nodes.find(n => n.id === b.sourceId);
            return (srcA?.maxTime || 0) - (srcB?.maxTime || 0);
        });

        let segIdx = 0;

        sortedConns.forEach(c => {
            const src = this.state.nodes.find(n => n.id === c.sourceId);
            const tgt = this.state.nodes.find(n => n.id === c.targetId);
            if (!src || !tgt) return;
            const stats = c.calcStats;
            if (!stats) return;

            segIdx++;
            const srcName = src.name || src.typeId + '#' + src.id;
            const tgtName = tgt.name || tgt.typeId + '#' + tgt.id;
            const segTypeName = this._segTypeLabel(c.typeId);
            const width = c.width || 1.2;
            const length = c.distance || 0;
            const fst = c.flowState || { Q_in: 0, q_spec: 0, hasQueue: false };

            // ── Segment Header ──────────────────────────────
            out += `${'━'.repeat(66)}\n`;
            out += ` SEGMENT ${segIdx} │ [${srcName}] → [${tgtName}] │ ${segTypeName}\n`;
            out += `${'━'.repeat(66)}\n\n`;

            // ── § Geometry ──────────────────────────────────
            const area = length * width;
            out += ` ┌─ § Geometry [Annex 8a, I.4, I.6, I.9]\n`;
            out += ` │  ℓᵢ  = ${length.toFixed(2)} m    (segment length)\n`;
            out += ` │  δᵢ  = ${width.toFixed(2)} m    (segment width)\n`;
            out += ` │  Aᵢ  = ℓᵢ · δᵢ = ${length.toFixed(2)} × ${width.toFixed(2)} = ${area.toFixed(4)} m²\n`;
            out += ` └─\n\n`;

            if (method === 'B') {
                this._proofMethodB(out, c, src, tgt, stats, fst, width, length, area, segIdx);
                // Since strings are immutable, we need to collect the output
                out = this._proofMethodBFull(out, c, src, tgt, stats, fst, width, length, area, segIdx);
            } else {
                out = this._proofMethodAFull(out, c, src, stats, width, length, area);
            }

            out += `\n`;
        });

        // ── Critical Path & Final Result ────────────────────
        out += `${'═'.repeat(66)}\n`;
        out += ` FINAL RESULT\n`;
        out += `${'═'.repeat(66)}\n\n`;

        const exits = this.state.nodes.filter(n => n.typeId === 'exit');
        if (exits.length > 0) {
            const maxExit = exits.reduce((max, e) =>
                (e.maxTime || 0) > (max.maxTime || 0) ? e : max, exits[0]);
            const maxT = maxExit.maxTime || 0;

            out += ` Total Evacuation Time τ_евак [Annex 8a, III.7]:\n\n`;
            out += `   τ_евак = max( Σ τᵢ over all paths to exit )\n`;
            out += `   τ_евак = ${maxT.toFixed(4)} min\n`;
            out += `         = ${(maxT * 60).toFixed(1)} sec\n\n`;

            if (exits.length > 1) {
                out += ` Exit node times:\n`;
                exits.forEach(e => {
                    const eName = e.name || e.typeId + '#' + e.id;
                    out += `   • [${eName}]: τ = ${(e.maxTime || 0).toFixed(4)} min (${((e.maxTime || 0) * 60).toFixed(1)} sec)\n`;
                });
                out += `\n`;
            }
        } else {
            const maxT = Math.max(...this.state.nodes.map(n => n.maxTime || 0), 0);
            out += ` No exit nodes found. Maximum accumulated time:\n`;
            out += `   τ_max = ${maxT.toFixed(4)} min (${(maxT * 60).toFixed(1)} sec)\n\n`;
        }

        out += `${'═'.repeat(66)}\n`;
        return out;
    }

    /** Pretty label for segment type */
    _segTypeLabel(typeId) {
        if (typeId === 'stairs_up') return 'Stairs ↑ (upward)';
        if (typeId === 'stairs_down') return 'Stairs ↓ (downward)';
        if (typeId && typeId.includes('door')) return 'Door / Opening';
        return 'Horizontal';
    }

    /** Method A proof section for a single segment */
    _proofMethodAFull(out, c, src, stats, width, length, area) {
        const people = src.people || 0;
        const density = area > 0 ? people / area : 0;
        const lookup = this.lookupTable11(this._resolveSegType(c.typeId), density);

        out += ` ┌─ § Density & Speed [Annex 8a, II.2-4, Table 11]\n`;
        out += ` │  Nᵢ  = ${people} persons\n`;
        out += ` │  Dₐᵢ = Nᵢ / Aᵢ = ${people} / ${area.toFixed(4)} = ${density.toFixed(4)} pers/m²\n`;
        out += ` │  Table 11 lookup (D ≥ ${density.toFixed(2)} → D = ${lookup.D_used}):\n`;
        out += ` │    vᵢ = ${lookup.v.toFixed(2)} m/min\n`;
        out += ` └─\n\n`;

        out += ` ┌─ § Time [Annex 8a, II.5]\n`;
        out += ` │  Formula: τᵢ = ℓᵢ / vᵢ\n`;
        out += ` │  τᵢ = ${length.toFixed(2)} / ${lookup.v.toFixed(2)} = ${stats.time.toFixed(4)} min`;
        out += ` (${(stats.time * 60).toFixed(1)} sec)\n`;
        out += ` └─\n`;

        return out;
    }

    /** Method B proof section for a single segment */
    _proofMethodBFull(out, c, src, tgt, stats, fst, width, length, area, segIdx) {
        const isStart = src.typeId === 'start' || src.typeId === 'start2';
        const incomingConns = this.state.connections.filter(ic => ic.targetId === c.sourceId);
        const isInitial = incomingConns.length === 0 || isStart;

        // ── § Flow Analysis ─────────────────────────────
        out += ` ┌─ § Flow Analysis [Annex 8a, III.2-5]\n`;

        if (isInitial) {
            const N = src.people || 0;
            const outConns = this.state.connections.filter(oc => oc.sourceId === c.sourceId);
            const totalOutWidth = outConns.reduce((sum, oc) => {
                const w = parseFloat(oc.width);
                return sum + (Number.isFinite(w) ? w : 1.2);
            }, 0);
            const splitRatio = totalOutWidth > 0 ? (width / totalOutWidth) : 1;
            const N_stream = N * splitRatio;
            const density = area > 0 ? N_stream / area : 0;
            const lookup = this.lookupTable11(this._resolveSegType(c.typeId), density);

            out += ` │  Initial segment — flow derived from population density\n`;
            out += ` │  [Annex 8a, III.2]: Dₐᵢ = Nᵢ / Aᵢ\n`;
            if (outConns.length > 1) {
                out += ` │  Split ratio: δᵢ / Σδ_out = ${width.toFixed(2)} / ${totalOutWidth.toFixed(2)} = ${splitRatio.toFixed(4)}\n`;
                out += ` │  N_stream = N × ratio = ${N} × ${splitRatio.toFixed(4)} = ${N_stream.toFixed(2)} persons\n`;
            } else {
                out += ` │  Nᵢ = ${N_stream.toFixed(0)} persons\n`;
            }
            out += ` │  Dₐᵢ = ${N_stream.toFixed(2)} / ${area.toFixed(4)} = ${density.toFixed(4)} pers/m²\n`;
            out += ` │\n`;
            out += ` │  [Table 11] lookup (D ≥ ${density.toFixed(2)} → D = ${lookup.D_used}):\n`;
            out += ` │    vᵢ = ${lookup.v.toFixed(2)} m/min\n`;
            out += ` │    qᵢ = ${lookup.q.toFixed(2)} pers/m·min\n`;
            out += ` │  Qᵢ = qᵢ · δᵢ = ${lookup.q.toFixed(2)} × ${width.toFixed(2)} = ${(fst.Q_in || 0).toFixed(2)} pers/min\n`;
        } else {
            // Non-initial: show upstream flow merge
            out += ` │  Subsequent segment — flow from upstream [Annex 8a, III.5]\n`;
            out += ` │  Formula: qᵢ = Σ(δᵢ₋₁ · qᵢ₋₁) / δᵢ = Q_in / δᵢ\n`;
            out += ` │\n`;

            if (incomingConns.length > 0) {
                let Q_total = 0;
                out += ` │  Upstream flows:\n`;
                incomingConns.forEach((inc, idx) => {
                    const incSrc = this.state.nodes.find(n => n.id === inc.sourceId);
                    const incName = incSrc ? (incSrc.name || incSrc.typeId + '#' + incSrc.id) : '?';
                    const Q_out = inc.flowState ? inc.flowState.Q_out : 0;
                    Q_total += Q_out;
                    out += ` │    ${idx + 1}. [${incName}→] Q_out = ${Q_out.toFixed(2)} pers/min\n`;
                });
                out += ` │  Σ Q_in = ${Q_total.toFixed(2)} pers/min\n`;

                const outConns = this.state.connections.filter(oc => oc.sourceId === c.sourceId);
                if (outConns.length > 1) {
                    const totalOutWidth = outConns.reduce((sum, oc) => {
                        const w = parseFloat(oc.width);
                        return sum + (Number.isFinite(w) ? w : 1.2);
                    }, 0);
                    const splitRatio = totalOutWidth > 0 ? (width / totalOutWidth) : 1;
                    out += ` │  Split ratio: ${width.toFixed(2)} / ${totalOutWidth.toFixed(2)} = ${splitRatio.toFixed(4)}\n`;
                    out += ` │  Q_this = ${Q_total.toFixed(2)} × ${splitRatio.toFixed(4)} = ${(fst.Q_in || 0).toFixed(2)} pers/min\n`;
                }
            }

            out += ` │  qᵢ = Q / δᵢ = ${(fst.Q_in || 0).toFixed(2)} / ${width.toFixed(2)} = ${(fst.q_spec || 0).toFixed(2)} pers/m·min\n`;
        }
        out += ` └─\n\n`;

        // ── § Bottleneck Verification ────────────────────
        out += ` ┌─ § Bottleneck Verification [Annex 8a, III.5]\n`;
        out += ` │  Segment type: ${this._segTypeLabel(c.typeId)}\n`;
        out += ` │  q_max = ${stats.q_max} pers/m·min\n`;
        out += ` │\n`;

        if (fst.hasQueue) {
            out += ` │  CHECK: qᵢ = ${(fst.q_spec || 0).toFixed(2)} > q_max = ${stats.q_max}\n`;
            out += ` │  ⚠ CONGESTION — Queue formation [III.5(b)]\n`;
            out += ` │  Movement proceeds at boundary density (D = 9.2 pers/m²)\n`;
            out += ` │  with v_гран = ${stats.v_gran} m/min, q_гран = ${stats.q_gran} pers/m·min\n`;
        } else {
            out += ` │  CHECK: qᵢ = ${(fst.q_spec || 0).toFixed(2)} ≤ q_max = ${stats.q_max}\n`;
            out += ` │  ✓ FREE FLOW — No congestion [III.5(a)]\n`;
        }
        out += ` └─\n\n`;

        // ── § Time Calculation ───────────────────────────
        out += ` ┌─ § Evacuation Time τᵢ\n`;

        if (fst.hasQueue) {
            const ds = c.dynamicStats || {};
            const Q_out = width * stats.q_gran;
            const Q_in = fst.Q_in || 0;

            out += ` │  [Annex 8a, III.5(b)] — Queued flow formula:\n`;
            out += ` │\n`;
            out += ` │    τᵢ = ℓᵢ/v_гран + Nᵢ,eff · [1/(q_гран·δᵢ) − 1/Σ(δᵢ₋₁·qᵢ₋₁)]\n`;
            out += ` │       = ℓᵢ/v_гран + Nᵢ,eff · (1/Q_out − 1/Q_in)\n`;
            out += ` │\n`;

            // Show Clause I.11 derivation
            const nTotal = Number.isFinite(Number(ds.N_total)) ? Number(ds.N_total) : 0;
            const vDensity = Number.isFinite(Number(ds.v_density)) ? Number(ds.v_density) : 0;
            const tFill = Number.isFinite(Number(ds.t_filling)) ? Number(ds.t_filling) : 0;
            const nOut = Number.isFinite(Number(ds.N_out)) ? Number(ds.N_out) : 0;
            const nEff = Number.isFinite(Number(ds.N_eff)) ? Number(ds.N_eff) : 0;
            const density = Number.isFinite(Number(ds.density)) ? Number(ds.density) : 0;
            const delayKernel = Number.isFinite(Number(ds.delayKernel)) ? Number(ds.delayKernel) : 0;

            out += ` │  [Annex 8a, I.11] — Effective people (Nᵢ,eff):\n`;
            out += ` │    Nᵢ,max    = ${nTotal} persons (max people in segment)\n`;
            out += ` │    Aᵢ        = ${(length * width).toFixed(4)} m²\n`;
            out += ` │    Dₐᵢ       = Nᵢ,max / Aᵢ = ${nTotal} / ${(length * width).toFixed(4)} = ${density.toFixed(4)} pers/m²\n`;
            out += ` │    v(Dₐᵢ)    = ${vDensity.toFixed(2)} m/min  [Table 11]\n`;
            out += ` │    t_fill    = ℓᵢ / v(Dₐᵢ) = ${length.toFixed(2)} / ${vDensity.toFixed(2)} = ${tFill.toFixed(4)} min\n`;
            out += ` │    N_out     = min(Nᵢ,max, Q_out · t_fill)\n`;
            out += ` │             = min(${nTotal}, ${Q_out.toFixed(2)} × ${tFill.toFixed(4)})\n`;
            out += ` │             = min(${nTotal}, ${(Q_out * tFill).toFixed(2)}) = ${nOut.toFixed(2)}\n`;
            out += ` │    Nᵢ,eff   = max(0, Nᵢ,max − N_out)\n`;
            out += ` │             = max(0, ${nTotal} − ${nOut.toFixed(2)}) = ${nEff.toFixed(2)}\n`;
            out += ` │\n`;

            // Show the actual computation
            const isDoor = c.typeId && c.typeId.includes('door');
            const isThinDoor = isDoor && length <= 0.7;
            const travelTerm = isThinDoor ? 0 : (stats.v_gran > 0.1 ? length / stats.v_gran : 0);
            const delayTerm = nEff * delayKernel;

            out += ` │  Term 1 — Travel:  ℓᵢ / v_гран\n`;
            if (isThinDoor) {
                out += ` │    = 0 (door in wall ≤ 0.7m, ℓ = 0)  [Annex 8a, I.5]\n`;
            } else {
                out += ` │    = ${length.toFixed(2)} / ${stats.v_gran.toFixed(2)} = ${travelTerm.toFixed(4)} min\n`;
            }
            out += ` │\n`;
            out += ` │  Term 2 — Queue delay:  Nᵢ,eff · (1/Q_out − 1/Q_in)\n`;
            out += ` │    Q_out = q_гран · δᵢ = ${stats.q_gran} × ${width.toFixed(2)} = ${Q_out.toFixed(2)} pers/min\n`;
            out += ` │    Q_in  = ${Q_in.toFixed(2)} pers/min\n`;
            out += ` │    kernel = 1/${Q_out.toFixed(2)} − 1/${Q_in.toFixed(2)} = ${delayKernel.toFixed(6)} min/pers\n`;
            out += ` │    delay  = ${nEff.toFixed(2)} × ${delayKernel.toFixed(6)} = ${delayTerm.toFixed(4)} min\n`;
            out += ` │\n`;
            out += ` │  τᵢ = ${travelTerm.toFixed(4)} + ${delayTerm.toFixed(4)} = ${stats.time.toFixed(4)} min`;
            out += ` (${(stats.time * 60).toFixed(1)} sec)\n`;
        } else {
            // Free flow
            if (c.typeId && c.typeId.includes('door') && length <= 0.7) {
                out += ` │  [Annex 8a, I.5]: Door in wall ≤ 0.7m — no queue.\n`;
                out += ` │  Segment length taken as 0 ⟹ τᵢ = 0 min\n`;
            } else {
                out += ` │  [Annex 8a, III.5(a)] — Free flow formula:\n`;
                out += ` │    τᵢ = ℓᵢ / vᵢ\n`;
                if (stats.v > 0.1) {
                    out += ` │    τᵢ = ${length.toFixed(2)} / ${stats.v.toFixed(2)} = ${stats.time.toFixed(4)} min`;
                    out += ` (${(stats.time * 60).toFixed(1)} sec)\n`;
                } else {
                    out += ` │    vᵢ ≈ 0 ⟹ τᵢ = 0 min\n`;
                }
            }
        }

        // Accumulated time at target node
        out += ` │\n`;
        out += ` │  Accumulated time at [${tgt.name || tgt.typeId + '#' + tgt.id}]:\n`;
        out += ` │    T = ${(tgt.maxTime || 0).toFixed(4)} min (${((tgt.maxTime || 0) * 60).toFixed(1)} sec)\n`;
        out += ` └─\n`;

        return out;
    }

    /** Stub called for consistency; actual work done in _proofMethodBFull */
    _proofMethodB() { }
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = SalamanderCore;
}
if (typeof window !== 'undefined') {
    window.SalamanderCore = SalamanderCore;
}

// ═══════════════════════════════════════════════════════════════
// CLI Execution
// ═══════════════════════════════════════════════════════════════
if (typeof module !== 'undefined' && module.exports && typeof require === 'function' && require.main === module) {

    const args = process.argv.slice(2);

    // ── Parse CLI arguments ──────────────────────────────
    const opts = {
        input: null,
        output: null,
        print: false,
        method: 'B',
        regsFile: null,
        help: false
    };

    for (let i = 0; i < args.length; i++) {
        const a = args[i];
        if (a === '-h' || a === '--help') {
            opts.help = true;
        } else if (a === '-p' || a === '--print') {
            opts.print = true;
        } else if ((a === '-o' || a === '--output') && args[i + 1]) {
            opts.output = args[++i];
        } else if ((a === '-m' || a === '--method') && args[i + 1]) {
            opts.method = args[++i].toUpperCase();
        } else if ((a === '-r' || a === '--regs') && args[i + 1]) {
            opts.regsFile = args[++i];
        } else if (!a.startsWith('-') && !opts.input) {
            opts.input = a;
        }
    }

    // ── Help ─────────────────────────────────────────────
    if (opts.help || !opts.input) {
        console.log(`
Salamander — Evacuation Time Calculator
Source: Ordinance Iz-1971, Annex 8a (DV бр. 91/2024)

Usage:
  node core.js <input.json> [options]

Arguments:
  <input.json>            Path to the graph JSON file

Options:
  -p, --print             Print the proof directly to the terminal (stdout)
  -o, --output <file>     Write proof to a file (default: mathproof.txt)
  -m, --method <A|B>      Calculation method: A or B (default: B)
  -r, --regs <file>       Path to regulations.json (default: ./regulations.json)
  -h, --help              Show this help message

Examples:
  node core.js GraphExample.json --print
  node core.js GraphExample.json -o report.txt -m B
  node core.js GraphExample.json -p -r ./custom_regulations.json
`);
        process.exit(opts.help ? 0 : 1);
    }

    // ── Execute ──────────────────────────────────────────
    try {
        if (!fs) throw new Error('Node fs module is unavailable.');

        const path = require('path');

        // Load regulations
        const regsPath = opts.regsFile || path.join(path.dirname(opts.input), 'regulations.json');
        if (!fs.existsSync(regsPath)) {
            // Fallback: look in CWD
            const cwdRegs = path.join(process.cwd(), 'regulations.json');
            if (fs.existsSync(cwdRegs)) {
                opts.regsFile = cwdRegs;
            } else {
                throw new Error(`Cannot find regulations.json at "${regsPath}" or in CWD.`);
            }
        } else {
            opts.regsFile = regsPath;
        }

        const regsStr = fs.readFileSync(opts.regsFile, 'utf8');
        const regulations = JSON.parse(regsStr);

        // Load graph
        const jsonStr = fs.readFileSync(opts.input, 'utf8');
        const graphData = JSON.parse(jsonStr);

        // Run calculation
        const core = new SalamanderCore(regulations);
        core.loadGraph(graphData);

        if (opts.method === 'A') {
            core.calcMethodA();
        } else {
            core.calcMethodB();
        }

        // Generate proof
        const proof = core.generateMathProof();

        // Output
        if (opts.print) {
            console.log(proof);
        }

        if (!opts.print || opts.output) {
            const outFile = opts.output || 'mathproof.txt';
            fs.writeFileSync(outFile, proof, 'utf8');
            if (!opts.print) {
                console.log(`Proof written to: ${outFile}`);
            } else {
                console.log(`\n(Also written to: ${outFile})`);
            }
        }

        console.log(`\nTotal Evacuation Time: ${core.state.totalEvacuationTime.toFixed(4)} min (${(core.state.totalEvacuationTime * 60).toFixed(1)} sec)`);

    } catch (err) {
        console.error('Error:', err.message);
        process.exit(1);
    }
}
