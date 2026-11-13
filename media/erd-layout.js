// @ts-check
/**
 * Layered auto layout for ER diagrams: referenced tables to the left, referencing tables to the right,
 * so relationship lines read left-to-right. Works in the webview and in Node (unit tests).
 */
(function (root, factory) {
  const api = factory();
  // @ts-ignore
  if (typeof module === 'object' && module.exports) {
    // @ts-ignore
    module.exports = api;
  } else {
    // @ts-ignore
    root.erdLayout = api;
  }
})(typeof self !== 'undefined' ? self : this, function () {
  const COLUMN_GAP = 120;
  const ROW_GAP = 48;
  const MAX_COLUMN_HEIGHT = 1400;
  const GRID = 8;
  const snap = (/** @type {number} */ v) => Math.round(v / GRID) * GRID;

  /**
   * @param {Array<{id: string}>} entities
   * @param {Array<{from: string, to: string}>} relationships
   * @param {(id: string) => {width: number, height: number}} sizeOf
   * @returns {Record<string, {x: number, y: number}>}
   */
  function layout(entities, relationships, sizeOf) {
    const ids = entities.map(e => e.id);
    const known = new Set(ids);
    /** @type {Map<string, Set<string>>} */
    const parents = new Map(ids.map(id => [id, new Set()]));
    /** @type {Map<string, Set<string>>} */
    const neighbours = new Map(ids.map(id => [id, new Set()]));
    for (const r of relationships) {
      if (!known.has(r.from) || !known.has(r.to) || r.from === r.to) {
        continue;
      }
      parents.get(r.from).add(r.to);
      neighbours.get(r.from).add(r.to);
      neighbours.get(r.to).add(r.from);
    }

    // Rank = longest path to a root (a table that references nothing); cycles are cut.
    /** @type {Map<string, number>} */
    const rank = new Map();
    const visiting = new Set();
    const rankOf = (/** @type {string} */ id) => {
      if (rank.has(id)) {
        return rank.get(id);
      }
      if (visiting.has(id)) {
        return 0;
      }
      visiting.add(id);
      let r = 0;
      for (const p of parents.get(id)) {
        r = Math.max(r, rankOf(p) + 1);
      }
      visiting.delete(id);
      rank.set(id, r);
      return r;
    };
    const connected = ids.filter(id => neighbours.get(id).size > 0);
    const isolated = ids.filter(id => neighbours.get(id).size === 0);
    connected.forEach(rankOf);

    /** @type {string[][]} */
    const columns = [];
    for (const id of connected) {
      const r = rank.get(id);
      (columns[r] = columns[r] || []).push(id);
    }
    const order = new Map();
    columns.forEach(col => col.forEach((id, i) => order.set(id, i)));

    // Barycenter sweeps to reduce crossings.
    for (let pass = 0; pass < 4; pass++) {
      const sweep = pass % 2 === 0 ? columns.slice(1) : columns.slice(0, -1).reverse();
      for (const col of sweep) {
        const bary = (/** @type {string} */ id) => {
          const ns = [...neighbours.get(id)].filter(n => order.has(n));
          return ns.length ? ns.reduce((s, n) => s + order.get(n), 0) / ns.length : order.get(id);
        };
        col.sort((a, b) => bary(a) - bary(b));
        col.forEach((id, i) => order.set(id, i));
      }
    }

    /** @type {Record<string, {x: number, y: number}>} */
    const pos = {};
    let x = 0;
    let tallest = 0;
    /** @type {Array<{ids: string[], x: number, height: number}>} */
    const placed = [];
    for (const col of columns.filter(Boolean)) {
      // Wrap very tall columns into sub-columns.
      /** @type {string[][]} */
      const chunks = [[]];
      let h = 0;
      for (const id of col) {
        const s = sizeOf(id);
        if (h + s.height > MAX_COLUMN_HEIGHT && chunks[chunks.length - 1].length) {
          chunks.push([]);
          h = 0;
        }
        chunks[chunks.length - 1].push(id);
        h += s.height + ROW_GAP;
      }
      for (const chunk of chunks) {
        const width = Math.max(...chunk.map(id => sizeOf(id).width));
        const height = chunk.reduce((s, id) => s + sizeOf(id).height, 0) + ROW_GAP * (chunk.length - 1);
        placed.push({ ids: chunk, x, height });
        tallest = Math.max(tallest, height);
        x += width + COLUMN_GAP;
      }
    }
    for (const c of placed) {
      let y = snap((tallest - c.height) / 2);
      for (const id of c.ids) {
        pos[id] = { x: snap(c.x), y };
        y = snap(y + sizeOf(id).height + ROW_GAP);
      }
    }

    // Unconnected tables: a grid below (or beside, when the diagram is empty otherwise).
    if (isolated.length) {
      const perRow = Math.max(2, Math.ceil(Math.sqrt(isolated.length)));
      const top = connected.length ? snap(tallest + ROW_GAP * 2) : 0;
      let gx = 0;
      let gy = top;
      let rowHeight = 0;
      isolated.forEach((id, i) => {
        if (i > 0 && i % perRow === 0) {
          gx = 0;
          gy = snap(gy + rowHeight + ROW_GAP);
          rowHeight = 0;
        }
        const s = sizeOf(id);
        pos[id] = { x: snap(gx), y: gy };
        gx += s.width + COLUMN_GAP / 2;
        rowHeight = Math.max(rowHeight, s.height);
      });
    }
    return pos;
  }

  /**
   * Axis-aligned overlap test, used by tests and by placement of new tables.
   * @param {{x: number, y: number, width: number, height: number}} a
   * @param {{x: number, y: number, width: number, height: number}} b
   */
  function overlaps(a, b) {
    return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
  }

  return { layout, overlaps, GRID, snap };
});
