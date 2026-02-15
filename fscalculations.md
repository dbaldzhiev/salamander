Below is a practical, “do-the-math” explanation of **how evacuation time calculations are carried out under the Bulgarian fire-safety methodology** (Наредба Iз-1971 + **Annex 8a**), in a way you can directly turn into a tool.

I’m focusing on the two normative calculation methods referenced by Annex 8a:

* **Method A: “Length of evacuation path”** (time = sum of segment travel times)
* **Method B: “Specific flow capacity of segments”** (propagate flow, detect bottlenecks, add queue/delay time)

The method is applied to the **most unfavorable person** (worst case), which can mean **either** the longest path **or** the path with the **highest crowd density / lowest speed** (especially relevant in multi-storey buildings).

---

## 1) Decide what you are checking against: allowable evacuation time

Your computed evacuation time (the *calculated* time) is checked against the *allowable* (admissible) evacuation time from the ordinance tables/articles.

Example from the extracted norms: for a **hall/room with >100 people**, allowable time depends on fire resistance degree (Table 10).

Also, the allowable time may be increased **1.5×** if conditions like automatic fire suppression + voice alarm are present (as stated in the norms).

In the sample report, they explicitly do: allowable 2 min → 3 min with the 1.5× allowance, then compare computed times to ≤ 3 min.

---

## 2) Build the evacuation network and split it into “segments” (участъци)

You model the evacuation route as a sequence/graph of **segments**, each with:

* length ( \ell_i ) [m]
* clear width ( \delta_i ) [m]
* type: horizontal / stairs up / stairs down / door/opening / etc.
* people count ( N_i ) (how many are in that segment’s flow at the time it fills)

**How to split segments (Annex 8a rules):** a new segment begins whenever any of the following occurs:

* change in number of people (N_i)
* change in width (widening / narrowing)
* change of type (horizontal ↔ sloped/stairs)
* you reach a door/opening

**Stairs are treated as one segment** (you don’t split into flight + landing for the evacuation-time math).

**Doors/openings treatment:**

* A door in a wall thickness **≤ 0.7 m** is taken with **calculation length = 0** (often time = 0 if no queue), but it is still a “segment” for capacity checks.

---

## 3) Human flow basics: density, speed, and specific flow capacity

### 3.1 Density in a segment

For a segment (i), area is:
[
A_i = \ell_i \cdot \delta_i
]
Density is:
[
D_{a,i} = \frac{N_i}{A_i} \quad [\text{people}/m^2]
]
This matches the norms’ definition: density is people divided by segment area; and you use the **maximum number of people that can be in the segment** at filling (don’t subtract those who already left before it fills).

### 3.2 Speed and “specific flow capacity” from tables

For each segment type, the ordinance provides (Table 11):

* speed (v) [m/min]
* specific flow capacity (q) [people/(m·min)]
  as a function of density.

Important rule from Annex 8a:

* if your computed density is between table rows, you take the **next higher density row** (conservative).

There is also a **boundary (limit) density** (e.g. 9.2 people/m² is shown as “гранична”), and if computed density exceeds it, you clamp to the boundary row.

Doors narrower than 1.6 m use a special table for capacity at boundary density (Table 12), and there’s also a stated max door capacity value (199.1 people/(m·min)).

---

## 4) Method A: “Length of evacuation path” (simple sum of travel times)

This method is literally:

1. Choose the **most unfavorable person** (worst path) per Annex 8a logic.
2. For each segment on that path:

   * compute density (D_{a,i})
   * pick (v_i) from Table 11 (by density + segment type)
   * compute segment time:
     [
     \tau_i = \frac{\ell_i}{v_i} \quad [\text{min}]
     ]
3. Total evacuation time:
   [
   \tau_{ev} = \sum_i \tau_i
   ]
   This workflow is explicitly enumerated in Annex 8a section II (and mirrored in the example report tables).

**When this tends to be used in practice:** smaller rooms / simpler paths (the example report uses it for rooms with ≤ 50 people, then uses Method B for larger rooms).

---

## 5) Method B: “Specific flow capacity of segments” (propagate flow + detect queues)

This is the method you want when you have merging flows and bottlenecks. The key idea:

* You compute an initial (q) for **starting segments** from density/table.
* Then you propagate that flow downstream through geometry changes.
* If required (q) exceeds what the segment can physically pass ((q_{max})), you get a **queue (delay)** and time is computed differently.

### 5.1 Starting segments (“where movement forms”)

For initial segments you compute:

* density (D_{a,i})
* from Table 11: speed (v_i) and specific flow (q_i)

Time in starting segments is still:
[
\tau_i = \frac{\ell_i}{v_i}
]
(Annex 8a states you compute time for initial segments after reading (v), (q) from the table.)

### 5.2 Propagate flow to next segments (narrowing/widening)

The normative logic is conservation of total flow:

* total flow (Q = \delta \cdot q)

So for a single upstream segment:
[
q_i = \frac{\delta_{i-1}, q_{i-1}}{\delta_i}
]
Annex 8a describes exactly this dependency of (q_i) on (q_{i-1}) and widths (\delta_i), (\delta_{i-1}).

### 5.3 Merging flows (multiple upstream segments into one)

When several flows merge, total flow adds:
[
q_i = \frac{\sum_k (\delta_k, q_k)}{\delta_i}
]
Annex 8a explicitly calls out this “merging flows” case and gives a figure example.

### 5.4 Check feasibility: compare (q_i) to (q_{max})

After computing current (q_i), compare it to the segment’s maximum possible (q_{max}) for that segment type (from Table 11 / door limits):

* If (q_i \le q_{max}): **no queue**

  * choose a conservative table row (“closest corresponding to higher density”), determine speed (v_i), compute:
    [
    \tau_i = \frac{\ell_i}{v_i}
    ]


* If (q_i > q_{max}): **queue forms**, movement happens at **boundary density** with boundary parameters (v_{boundary}, q_{boundary}).

  In that case, time through the segment is computed as a **service time**:
  [
  \tau_i = \frac{N_i}{\delta_i , q_{boundary}}
  ]
  Annex 8a states “time for passing a segment with delay is determined by a formula”, then clarifies (N_i) is people count in the segment.

  **Critical additional rule:** if a segment had a queue, then for downstream propagation you do **not** use the impossible (q_i); you use the **boundary** (q_{boundary}) as the upstream (q_{i-1}).

### 5.5 Doors/openings in Method B

Doors are separate segments; there are two big cases:

* **door width ≤ 1.6 m**: use the door table rules; if no queue and wall ≤ 0.7 m, length = 0 → time can be 0; if wall ≥ 0.7 m, you compute time using an appropriate speed (the norms mention interpolation using the door speed table at boundary density).
* **door width ≥ 1.6 m**: treat with Table 11 door column rules for capacity, still respecting the max. If no queue and wall ≤ 0.7 m, time may be 0 because length is taken as 0.

### 5.6 Total evacuation time

You calculate until the **final evacuation exit**; the calculated evacuation time is the sum of segment times (with and without delays).

---

## 6) Picking the “most unfavorable person” (what your tool should actually compute)

Annex 8a’s key instruction: worst case may be:

* the **longest evacuation path**, OR
* the path traversed at **highest density / lowest speed** (e.g., a highly populated intermediate level)
  and for multi-storey buildings you may need to compute both candidate cases and take the larger result.

**Tool implication (practical):**

* You’ll likely compute evacuation time for a set of candidate start nodes (or “worst seat” points) and take max.
* If your network has alternative routes, compute each route and take the max (or apply your project’s routing assumption—typically “nearest exit”, but the normative text is about worst-case, not best-case).

---

## 7) Implementation-ready pseudocode

### 7.1 Data model (minimal)

```python
Segment:
  id: str
  from_node: str
  to_node: str
  kind: Literal["horizontal","stairs_up","stairs_down","door"]
  length_m: float           # ℓi
  width_m: float            # δi (clear width)
  people_N: int             # Ni (max people contributing in this segment)
  wall_thickness_m: float|None  # only for doors
  incoming_segments: list[str]  # for merges (optional)
```

### 7.2 Method A (length-based)

```python
def evac_time_length_method(path_segments):
    total = 0.0
    for seg in path_segments:
        A = seg.length_m * seg.width_m
        Da = seg.people_N / A  # clamp later
        Da_tab = round_up_to_table_density(Da)  # Annex 8a conservative choice
        v = lookup_speed_table11(seg.kind, Da_tab)
        total += seg.length_m / v
    return total
```

### 7.3 Method B (capacity-based with merges + queues)

```python
def evac_time_capacity_method(ordered_segments):
    """
    ordered_segments must be topologically ordered from starts to exit.
    Works best on a 'merge-only' network (a tree flowing to the exit).
    """
    q_out = {}     # segment_id -> q leaving this segment (specific flow used downstream)
    total_time = 0.0

    for seg in ordered_segments:

        # --- determine incoming specific flow q_in ---
        if not seg.incoming_segments:
            # starting segment: derive q from density table
            A = seg.length_m * seg.width_m
            Da = seg.people_N / A
            Da_tab = round_up_to_table_density(Da)
            v, q_in = lookup_v_q_table11(seg.kind, Da_tab)
        else:
            # merge: sum total flow from incoming segments
            Q_total = 0.0
            for inc_id in seg.incoming_segments:
                inc_seg_width = get_width(inc_id)
                Q_total += inc_seg_width * q_out[inc_id]  # δ * q
            q_in = Q_total / seg.width_m

        # --- compute required q in this segment due to width change (single predecessor case) ---
        if seg.incoming_segments and len(seg.incoming_segments) == 1:
            prev_id = seg.incoming_segments[0]
            q_in = (get_width(prev_id) * q_out[prev_id]) / seg.width_m

        # --- capacity check ---
        qmax = lookup_qmax(seg.kind, seg.width_m)  # Table 11 / door limits

        if q_in <= qmax:
            # no queue: choose conservative row and speed
            v = lookup_speed_from_q_table11(seg.kind, q_in, conservative=True)
            # door special: if wall <=0.7m and no queue -> time 0 because length taken 0
            if seg.kind == "door" and seg.wall_thickness_m is not None and seg.wall_thickness_m <= 0.7:
                tau = 0.0
            else:
                tau = seg.length_m / v
            q_out[seg.id] = q_in
        else:
            # queue: move at boundary conditions
            q_boundary, v_boundary = lookup_boundary(seg.kind, seg.width_m)  # from tables
            tau = seg.people_N / (seg.width_m * q_boundary)
            # downstream must use boundary q (not the impossible q_in)
            q_out[seg.id] = q_boundary

        total_time += tau

    return total_time
```

---

## 8) Practical “gotchas” your tool should handle (because real plans are evil)

1. **People counts (N_i) are not automatically “people from that room only”** once flows merge—(N_i) becomes cumulative on downstream segments (your GUI approach of “start nodes with people” fits perfectly; you then compute cumulative flow counts per segment).

2. **Avoid double-counting queue time** across repeated stair segments. The example report explicitly “lumps” stair queue segments to avoid repeated delay accounting (that’s a modeling choice, but it’s a sane one when your segmentization would otherwise replicate the same bottleneck effect multiple times).

3. **Doors**: even if time is 0 (thin wall) in a no-queue case, doors still matter as potential bottlenecks via (q_{max}).

4. **Worst-case selection**: implement “compute many candidates, take max” rather than trying to guess the worst case from geometry alone. Annex 8a basically tells you to do that for multi-storey cases anyway.

---

## 9) What you should output (so it matches real FS report style)

The example report outputs exactly what an authority expects:

* a per-segment table: (N, \ell, \delta, D_a, v) (and/or (q)), (\tau), notes (“boundary speed”, “door time = 0”, etc.)
* a final comparison: ( \tau_{ev} \le \tau_{allow} ) (e.g., 0.88 min ≤ 3 min)

That’s the same structure your app should generate: **annotated schematic + calculation table**.

---

### Files used (as you uploaded them)



