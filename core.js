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
    getSegmentParams(conn) {
        if (!this.state.regulations) return null;

        let type = 'horiz';
        if (conn.typeId === 'stairs_up') type = 'stair_up';
        else if (conn.typeId === 'stairs_down') type = 'stair_down';

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

    lookupTable11(segType, density) {
        if (!this.state.regulations) return { v: 0, q: 0 };
        const table = this.state.regulations.table_11_flow_params.data;
        const colName = segType === 'horiz' ? 'horiz' :
            segType === 'stair_down' ? 'stair_down' :
                segType === 'stair_up' ? 'stair_up' : 'horiz';

        let row = table.find(r => r.D >= density);
        if (!row) row = table[table.length - 1];

        const val = row[colName];
        return { v: val.v, q: val.q };
    }

    getLimitParams(typeId) {
        if (!this.state.regulations || !this.state.regulations.limits) return { q_max: 164, q_gran: 135, v_gran: 14 };

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
                const area = p.length * p.width;
                const density = area > 0 ? N_stream_max / area : 0;
                const table = this.lookupTable11(p.type, density);
                v_curr = table.v;
                q_curr = table.q;
                Q_curr = q_curr * p.width;
                conn.travelTime = v_curr > 0.1 ? p.length / v_curr : 0;
            } else {
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
                hasQueue = true;
                conn.congestion = 'blocked';

                const N_total = N_stream_max;
                const Q_out = p.width * limits.q_gran;
                const Q_in = Q_curr;

                // Norm 2 Clause I.11 Dynamic Reduction
                // Remove the portion that can discharge before full occupation.

                const area = p.length * p.width;
                const density = area > 0 ? (p.people || 0) / area : 0;
                const table = this.lookupTable11(p.type, density);
                const v_density = table.v > 0.1 ? table.v : 100;
                const t_filling = v_density > 0.1 ? (p.length / v_density) : 0;
                const N_out_raw = Q_out * t_filling;
                const N_out = Math.max(0, Math.min(N_total, N_out_raw));
                const N_eff = Math.max(0, N_total - N_out);

                let travelTerm = 0;
                if (p.type.includes('door') && p.length <= 0.7) {
                    travelTerm = 0;
                } else {
                    travelTerm = (limits.v_gran > 0.1) ? p.length / limits.v_gran : 0;
                }

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
                conn.congestion = 'none';
                final_Q_out = Q_curr;
                conn.dynamicStats = null;
                if (!isInitial) {
                    const tableData = this.state.regulations.table_11_flow_params.data;
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
    generateMathProof() {
        let text = "DETAILED MATHEMATICAL PROOF (Method B - Norm 2)\n";
        text += "===============================================\n\n";

        const sortedConns = [...this.state.connections].sort((a, b) => {
            const srcA = this.state.nodes.find(n => n.id === a.sourceId);
            const srcB = this.state.nodes.find(n => n.id === b.sourceId);
            return (srcA?.maxTime || 0) - (srcB?.maxTime || 0);
        });

        sortedConns.forEach(c => {
            const src = this.state.nodes.find(n => n.id === c.sourceId);
            const tgt = this.state.nodes.find(n => n.id === c.targetId);
            if (!src || !tgt) return;

            const stats = c.calcStats;
            if (!stats) return; // Should not happen if calc run

            text += `SEGMENT [${src.name || src.id}] -> [${tgt.name || tgt.id}]:\n`;
            text += `  1. Geometry:\n`;
            text += `     - Length (ℓ) = ${c.distance.toFixed(2)} m\n`;
            text += `     - Width (δ)  = ${(c.width || 1.2).toFixed(2)} m\n`;

            const width = c.width || 1.2;
            const fs = c.flowState || { Q_in: 0, q_spec: 0, hasQueue: false };

            if (this.state.calculationMethod === 'B') {
                text += `  2. Flow Analysis (Specific Throughput Capacity):\n`;
                const isStart = src.typeId === 'start' || src.typeId === 'start2';

                if (isStart) {
                    text += `     - Initial Segment: Flow derived from Population Density (D = N/A)\n`;
                    text += `     - Generated Flow (Q) = ${(fs.Q_in || 0).toFixed(2)} p/min\n`;
                } else {
                    text += `     - Incoming Flow from Upstream (Q_in = Σ Q_prev) = ${(fs.Q_in || 0).toFixed(2)} p/min\n`;
                }

                text += `     - Specific Throughput Capacity (q = Q / δ) = ${(fs.q_spec || 0).toFixed(2)} p/m/min\n`;

                text += `  3. Bottleneck Verification (Queue Formulation):\n`;
                text += `     - Max Permissible Specific Throughput (q_max) = ${stats.q_max} p/m/min\n`;

                if (fs.hasQueue) {
                    text += `     - VERIFICATION: q > q_max (${(fs.q_spec || 0).toFixed(2)} > ${stats.q_max})\n`;
                    text += `     - STATUS: CONGESTION DETECTED. Queue formation inevitable.\n`;
                } else {
                    text += `     - VERIFICATION: q <= q_max\n`;
                    text += `     - STATUS: NORMAL FLOW.\n`;
                }

                text += `  4. Evacuation Time Calculation (τ):\n`;
                if (fs.hasQueue) {
                    const ds = c.dynamicStats || { N_total: 0, t_free: 0, N_out: 0, N_eff: 0 };
                    const Q_out = width * stats.q_gran;
                    const Q_in = fs.Q_in || 0;
                    const area = Math.max(0, (c.distance || 0) * width);
                    const nTotal = Number.isFinite(Number(ds.N_total)) ? Number(ds.N_total) : 0;
                    const vDensity = Number.isFinite(Number(ds.v_density)) ? Number(ds.v_density) : 0;
                    const tFill = Number.isFinite(Number(ds.t_filling)) ? Number(ds.t_filling) : 0;
                    const nOut = Number.isFinite(Number(ds.N_out)) ? Number(ds.N_out) : 0;
                    const nEff = Number.isFinite(Number(ds.N_eff)) ? Number(ds.N_eff) : 0;
                    const density = Number.isFinite(Number(ds.density)) ? Number(ds.density) : (area > 0 ? (nTotal / area) : 0);
                    const delayKernel = Number.isFinite(Number(ds.delayKernel)) ? Number(ds.delayKernel) : Math.max(0, (1 / Q_out) - (1 / Q_in));

                    text += `     - Methodology: "Time for Queued Flow" (Norm 2, Formula 2)\n`;
                    text += `     - Annex 8a III.5(b): q > q_max => boundary-flow regime (v_gran, q_gran)\n`;
                    text += `     - Clause I.11 Application (N_eff derivation):\n`;
                    text += `       * Maximum people in section (N_i,max) = ${nTotal}\n`;
                    text += `       * Segment Area (A = ℓ*δ) = ${area.toFixed(4)} m2\n`;
                    text += `       * Density (D_ai = N_i,max/A) = ${density.toFixed(4)} p/m2\n`;
                    text += `       * Density Based Speed (v_d from Table 11) = ${vDensity.toFixed(2)} m/min\n`;
                    text += `       * Time to Cross / Fill (t_fill) = ℓ / v_d = ${tFill.toFixed(4)} min\n`;
                    text += `       * Discharged Before Full Occupation (N_out) = min(N_i,max, Q_out * t_fill) = ${nOut.toFixed(2)}\n`;
                    text += `       * Effective People for delay (N_i,eff) = max(0, N_i,max - N_out) = ${nEff.toFixed(2)}\n`;

                    text += `     - Normative formula (Annex 8a III.5(b)): τ = ℓ / v_gran + N_i,eff * [1/(q_gran*δ_i) - 1/(Σ(δ_i-1*q_i-1))]\n`;
                    text += `     - Equivalent implemented form: τ = ℓ / v_gran + N_i,eff * (1/Q_out - 1/Q_in)\n`;

                    const val = (1 / Q_out) - (1 / Q_in);
                    const delay = nEff * Math.max(0, val);

                    text += `     - Term 1: Travel Time (l/v_gran) = ${c.typeId.includes('door') && c.distance <= 0.7 ? '0' : (c.distance / (stats.v_gran || 10)).toFixed(4)} min\n`;
                    text += `     - Queue Kernel (k = 1/Q_out - 1/Q_in) = ${delayKernel.toFixed(6)} min/person\n`;
                    text += `     - Term 2: Queue Delay = ${delay.toFixed(4)} min\n`;
                    text += `     - Total Time (τ) = ${(stats.time).toFixed(4)} min\n`;
                } else {
                    text += `     - Methodology: "Time for Free Flow" (Norm 2, Formula 1)\n`;
                    text += `     - Formula: τ = ℓ / v\n`;
                    text += `     - Time (τ) = ${stats.time.toFixed(4)} min\n`;
                }
            }
            text += `  ---------------------------------------------------\n\n`;
        });

        // Critical Path
        const exits = this.state.nodes.filter(n => n.typeId === 'exit');
        if (exits.length > 0) {
            const max = Math.max(...exits.map(e => e.maxTime));
            text += `FINAL RESULT: Total Evacuation Time = ${max.toFixed(2)} min\n`;
        }

        return text;
    }
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = SalamanderCore;
}
if (typeof window !== 'undefined') {
    window.SalamanderCore = SalamanderCore;
}

// CLI Execution
if (typeof module !== 'undefined' && module.exports && typeof require === 'function' && require.main === module) {
    const args = process.argv.slice(2);
    if (args.length < 1) {
        console.log("Usage: node core.js <input.json> [output_proof.txt]");
        process.exit(1);
    }

    const inputFile = args[0];
    const outputFile = args[1] || 'mathproof.txt';

    try {
        if (!fs) throw new Error("Node fs module is unavailable.");
        const jsonStr = fs.readFileSync(inputFile, 'utf8');
        const graphData = JSON.parse(jsonStr);
        const regsStr = fs.readFileSync('regulations.json', 'utf8');
        const regulations = JSON.parse(regsStr);

        const core = new SalamanderCore(regulations);
        core.loadGraph(graphData);

        // Run Calc
        console.log("Running Method B Calculation...");
        core.calcMethodB();

        // Generate Proof
        const proof = core.generateMathProof();
        fs.writeFileSync(outputFile, proof);
        console.log(`Math Proof written to ${outputFile}`);
        console.log(`Total Evacuation Time: ${core.state.totalEvacuationTime.toFixed(2)} min`);

    } catch (err) {
        console.error("Error:", err.message);
        process.exit(1);
    }
}
