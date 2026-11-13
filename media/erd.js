// @ts-check
/* ER diagram canvas: SVG rendering, pan/zoom, drag, inspector editing, export. */
(function () {
  // @ts-ignore
  const { vscode, h, replace, debounce } = window.ui;
  // @ts-ignore
  const L = window.erdLayout;
  const NS = 'http://www.w3.org/2000/svg';
  const app = /** @type {HTMLElement} */ (document.getElementById('app'));

  const HEADER = 38;
  const ROW = 24;
  const PADX = 12;
  const ICON = 16;
  const MIN_W = 190;

  /** @type {any} */ let doc = null;
  /** @type {any} */ let meta = { types: [], dialects: [], colors: [], source: null, canSync: false };
  let view = 'logical';
  let zoom = 1;
  let panX = 40;
  let panY = 60;
  /** @type {null | {type: 'entity' | 'rel', id: string}} */ let selected = null;
  /** @type {string | null} */ let hovered = null;
  let search = '';
  /** @type {Record<string, any>} */ const els = {};
  /** @type {Map<string, any>} */ let geometry = new Map();
  /** @type {any} */ let theme = {};

  const svg = (/** @type {string} */ tag, /** @type {Record<string, any>} */ attrs = {}, /** @type {any[]} */ ...children) => {
    const el = document.createElementNS(NS, tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (v === undefined || v === null || v === false) {
        continue;
      }
      if (k.startsWith('on') && typeof v === 'function') {
        el.addEventListener(k.substring(2).toLowerCase(), v);
      } else {
        el.setAttribute(k, String(v));
      }
    }
    for (const c of children.flat()) {
      if (c === null || c === undefined || c === false) {
        continue;
      }
      el.appendChild(c instanceof Node ? c : document.createTextNode(String(c)));
    }
    return el;
  };

  // ------------------------------------------------------------------ messages

  window.addEventListener('message', event => {
    const m = event.data;
    switch (m.type) {
      case 'load':
        meta = m.meta;
        doc = m.doc;
        view = m.meta.view || view;
        buildShell();
        const placed = ensureLayout();
        render();
        fit(false);
        if (placed) {
          postEdit('Arrange tables', true);
        }
        break;
      case 'doc':
        doc = m.doc;
        if (selected && !findSelected()) {
          selected = null;
        }
        if (ensureLayout()) {
          postEdit('Arrange tables', true);
        }
        render();
        renderInspector();
        break;
      case 'error':
        renderError(m.message);
        break;
      case 'status':
        flash(m.message, m.kind);
        break;
    }
  });

  const postNow = (/** @type {string} */ label) => vscode.postMessage({ type: 'edit', doc, label });
  const postSoon = debounce(postNow, 300);
  /** @param {string} label @param {boolean} [now] */
  function postEdit(label, now) {
    if (now) {
      postNow(label);
    } else {
      postSoon(label);
    }
  }

  // ------------------------------------------------------------------ model helpers

  const entityById = (/** @type {string} */ id) => doc.entities.find((/** @type {any} */ e) => e.id === id);
  const findSelected = () => selected && (selected.type === 'entity' ? entityById(selected.id) : doc.relationships.find((/** @type {any} */ r) => r.id === selected.id));
  const words = (/** @type {string} */ s) => s.replace(/([a-z0-9])([A-Z])/g, '$1 $2').split(/[^A-Za-z0-9]+/).filter(Boolean).map(w => w.toLowerCase());
  const pascal = (/** @type {string} */ s) => words(s).map(w => w[0].toUpperCase() + w.slice(1)).join('');
  const camel = (/** @type {string} */ s) => { const p = pascal(s); return p ? p[0].toLowerCase() + p.slice(1) : p; };
  const snake = (/** @type {string} */ s) => words(s).join('_');
  const singular = (/** @type {string} */ w) => /ies$/i.test(w) ? w.slice(0, -3) + 'y' : /(ss|x|ch|sh)es$/i.test(w) ? w.slice(0, -2) : /[^s]s$/i.test(w) ? w.slice(0, -1) : w;
  const className = (/** @type {any} */ e) => e.className || pascal(singular(e.table));
  const fieldName = (/** @type {any} */ c) => c.field || camel(c.name);
  const uid = () => Math.random().toString(36).slice(2, 10);
  /** Association field name, as the entity generator derives it: customer_id → customer, shipped_to_id → shippedTo. */
  const relField = (/** @type {any} */ r) => {
    if (r.field) {
      return r.field;
    }
    const col = r.columns.length === 1 ? camel(r.columns[0]) : '';
    const stripped = col.replace(/(Id|Fk|Key|No|Code)$/, '');
    const target = entityById(r.to);
    return stripped && stripped !== col ? stripped : camel(className(target || { table: r.to }));
  };

  const JAVA = { BIGINT: 'Long', INTEGER: 'Integer', SMALLINT: 'Short', DECIMAL: 'BigDecimal', DOUBLE: 'Double', REAL: 'Float', BOOLEAN: 'Boolean', VARCHAR: 'String', CHAR: 'String', TEXT: 'String', DATE: 'LocalDate', TIME: 'LocalTime', TIMESTAMP: 'LocalDateTime', TIMESTAMPTZ: 'OffsetDateTime', UUID: 'UUID', BINARY: 'byte[]', BLOB: 'byte[]', JSON: 'String' };
  const sqlType = (/** @type {any} */ c) => {
    if (c.nativeType && doc.nativeDialect === doc.dialect) {
      return c.nativeType.toLowerCase();
    }
    const t = c.type.toLowerCase();
    if (c.type === 'DECIMAL' && c.precision) {
      return `${t}(${c.precision},${c.scale ?? 0})`;
    }
    if ((c.type === 'VARCHAR' || c.type === 'CHAR' || c.type === 'BINARY') && c.length) {
      return `${t}(${c.length})`;
    }
    return t;
  };

  /** A pure link table (two foreign keys covering every column) is drawn as a many-to-many line in the entity view. */
  function isJoinTable(/** @type {any} */ e) {
    const out = doc.relationships.filter((/** @type {any} */ r) => r.from === e.id);
    if (out.length !== 2 || e.columns.length < 2) {
      return false;
    }
    const fkCols = new Set(out.flatMap((/** @type {any} */ r) => r.columns));
    return e.columns.every((/** @type {any} */ c) => fkCols.has(c.name));
  }

  /**
   * An element collection table (@ElementCollection): one foreign key back to its owner, no primary key,
   * nothing referencing it. The entity view shows it as a collection field on the owner.
   */
  function isCollectionTable(/** @type {any} */ e) {
    const out = doc.relationships.filter((/** @type {any} */ r) => r.from === e.id);
    return out.length === 1 && !e.columns.some((/** @type {any} */ c) => c.primaryKey)
      && !doc.relationships.some((/** @type {any} */ r) => r.to === e.id)
      && e.columns.some((/** @type {any} */ c) => !out[0].columns.includes(c.name));
  }

  const visibleEntities = () => doc.entities.filter((/** @type {any} */ e) => view === 'physical' || (!isJoinTable(e) && !isCollectionTable(e)));

  /** Rows shown on a card for the current view; `anchor` marks rows that relationship lines attach to. */
  function rowsOf(/** @type {any} */ e) {
    /** @type {any[]} */
    const rows = [];
    const out = doc.relationships.filter((/** @type {any} */ r) => r.from === e.id);
    if (view === 'physical') {
      for (const c of e.columns) {
        const fk = out.some((/** @type {any} */ r) => r.columns.includes(c.name));
        rows.push({ name: c.name, type: sqlType(c), pk: c.primaryKey, fk, nullable: c.nullable && !c.primaryKey, column: c.name });
      }
      return rows;
    }
    const covered = new Set();
    for (const c of e.columns) {
      if (covered.has(c.name)) {
        continue;
      }
      const rel = out.find((/** @type {any} */ r) => r.columns.includes(c.name) && !(c.primaryKey && r.columns.every((/** @type {any} */ x) => e.columns.find((/** @type {any} */ y) => y.name === x)?.primaryKey)));
      if (rel) {
        rel.columns.forEach((/** @type {any} */ x) => covered.add(x));
        const target = entityById(rel.to);
        rows.push({ name: relField(rel), type: target ? className(target) : rel.to, fk: true, pk: false, nullable: c.nullable, column: c.name, rel: rel.id });
      } else {
        rows.push({ name: fieldName(c), type: JAVA[/** @type {keyof typeof JAVA} */ (c.type)] || 'String', pk: c.primaryKey, fk: false, nullable: c.nullable && !c.primaryKey, column: c.name });
      }
    }
    // Inverse sides and many-to-many collections
    for (const r of doc.relationships.filter((/** @type {any} */ r) => r.to === e.id && r.inverseField)) {
      const from = entityById(r.from);
      if (!from) {
        continue;
      }
      if (isCollectionTable(from)) {
        const values = from.columns.filter((/** @type {any} */ c) => !r.columns.includes(c.name));
        const element = values.length === 1 ? (JAVA[/** @type {keyof typeof JAVA} */ (values[0].type)] || 'String') : className(from);
        rows.push({ name: r.inverseField || camel(from.table), type: `Set<${element}>`, inverse: true, collection: true });
      } else if (isJoinTable(from)) {
        const other = doc.relationships.find((/** @type {any} */ x) => x.from === from.id && x.id !== r.id);
        const otherEntity = other && entityById(other.to);
        rows.push({ name: r.inverseField, type: `Set<${otherEntity ? className(otherEntity) : '?'}>`, inverse: true });
      } else {
        rows.push({ name: r.inverseField, type: r.oneToOne ? className(from) : `List<${className(from)}>`, inverse: true });
      }
    }
    return rows;
  }

  // ------------------------------------------------------------------ measuring and layout

  const canvas = document.createElement('canvas');
  const ctx = /** @type {CanvasRenderingContext2D} */ (canvas.getContext('2d'));
  const css = (/** @type {string} */ v, /** @type {string} */ fallback) => getComputedStyle(document.body).getPropertyValue(v).trim() || fallback;
  function readTheme() {
    theme = {
      fg: css('--vscode-editor-foreground', '#cccccc'),
      muted: css('--vscode-descriptionForeground', '#9d9d9d'),
      bg: css('--vscode-editor-background', '#1f1f1f'),
      card: css('--vscode-editorWidget-background', '#252526'),
      border: css('--vscode-widget-border', css('--vscode-panel-border', '#3c3c3c')),
      accent: css('--vscode-focusBorder', '#0078d4'),
      pk: css('--vscode-charts-yellow', '#cca700'),
      fk: css('--vscode-charts-blue', '#3794ff'),
      edge: css('--vscode-descriptionForeground', '#8b8b8b'),
      font: css('--vscode-font-family', 'system-ui, sans-serif'),
      mono: css('--vscode-editor-font-family', 'Consolas, monospace'),
    };
  }
  const textWidth = (/** @type {string} */ text, /** @type {string} */ font) => {
    ctx.font = font;
    return ctx.measureText(text).width;
  };

  function measure(/** @type {any} */ e) {
    const rows = rowsOf(e);
    const titleW = textWidth(view === 'physical' ? e.table : className(e), `600 13px ${theme.font}`) + 40;
    const subW = textWidth(view === 'physical' ? className(e) : e.table, `11px ${theme.font}`) + 20;
    let nameW = 0;
    let typeW = 0;
    for (const r of rows) {
      nameW = Math.max(nameW, textWidth(r.name, `12px ${theme.font}`));
      typeW = Math.max(typeW, textWidth(r.type, `11px ${theme.mono}`));
    }
    const width = Math.ceil(Math.max(MIN_W, titleW + subW * 0.6, PADX + ICON + 6 + nameW + 28 + typeW + PADX) / L.GRID) * L.GRID;
    return { width, height: HEADER + Math.max(rows.length, 1) * ROW + 6, rows };
  }

  /** Places entities that have no position yet. Returns true when anything moved. */
  function ensureLayout(/** @type {boolean} */ all = false) {
    readTheme();
    const missing = doc.entities.filter((/** @type {any} */ e) => all || typeof e.x !== 'number' || typeof e.y !== 'number');
    if (!missing.length) {
      return false;
    }
    if (all || missing.length === doc.entities.length) {
      const sizes = new Map(doc.entities.map((/** @type {any} */ e) => [e.id, measure(e)]));
      const pos = L.layout(doc.entities, doc.relationships, (/** @type {string} */ id) => sizes.get(id));
      for (const e of doc.entities) {
        Object.assign(e, pos[e.id]);
      }
      return true;
    }
    // A few new tables: put them to the right of everything else.
    const right = Math.max(0, ...doc.entities.filter((/** @type {any} */ e) => typeof e.x === 'number').map((/** @type {any} */ e) => e.x + measure(e).width));
    let y = 0;
    for (const e of missing) {
      e.x = L.snap(right + 120);
      e.y = L.snap(y);
      y += measure(e).height + 48;
    }
    return true;
  }

  // ------------------------------------------------------------------ shell

  function buildShell() {
    readTheme();
    els.title = h('span', { class: 'erd-title', title: doc.name }, doc.name);
    els.counts = h('span', { class: 'erd-counts' });
    els.viewToggle = h('div', { class: 'segmented', role: 'radiogroup', 'aria-label': 'Diagram view' },
      h('button', { type: 'button', dataset: { view: 'logical' }, onClick: () => setView('logical'), title: 'Classes, fields and associations' }, 'Entities'),
      h('button', { type: 'button', dataset: { view: 'physical' }, onClick: () => setView('physical'), title: 'Tables, columns and SQL types' }, 'Tables'),
    );
    els.search = h('input', {
      type: 'search', class: 'erd-search', placeholder: 'Find table…', 'aria-label': 'Find a table',
      onInput: () => { search = els.search.value.trim().toLowerCase(); render(); },
      onKeydown: (/** @type {KeyboardEvent} */ e) => {
        if (e.key === 'Enter') {
          const match = visibleEntities().find((/** @type {any} */ x) => matches(x));
          if (match) {
            select({ type: 'entity', id: match.id });
            centerOn(match);
          }
        } else if (e.key === 'Escape') {
          els.search.value = '';
          search = '';
          render();
        }
      },
    });
    els.zoomLabel = h('span', { class: 'erd-zoom', 'aria-live': 'polite' });
    els.dialect = h('select', { 'aria-label': 'Target database', title: 'Target database (types, identifier case and DDL)', onChange: () => { doc.dialect = els.dialect.value; render(); postEdit('Change database', true); } },
      meta.dialects.map((/** @type {any} */ d) => h('option', { value: d.kind, selected: d.kind === doc.dialect }, d.label)));

    const menu = (/** @type {string} */ label, /** @type {Array<[string, string, () => void]>} */ items) => {
      const pop = h('div', { class: 'erd-menu hidden', role: 'menu' }, items.map(([text, hint, fn]) =>
        h('button', { type: 'button', role: 'menuitem', onClick: () => { pop.classList.add('hidden'); fn(); } }, h('span', null, text), hint ? h('span', { class: 'hint' }, hint) : null)));
      const btn = h('button', { type: 'button', class: 'secondary', 'aria-haspopup': 'menu', onClick: (/** @type {Event} */ e) => {
        e.stopPropagation();
        document.querySelectorAll('.erd-menu').forEach(m => m !== pop && m.classList.add('hidden'));
        pop.classList.toggle('hidden');
      } }, `${label} ▾`);
      return h('div', { class: 'erd-menu-wrap' }, btn, pop);
    };

    const toolbar = h('div', { class: 'erd-toolbar' },
      h('div', { class: 'erd-tb-left' }, els.title, els.counts),
      h('div', { class: 'erd-tb-center' }, els.viewToggle),
      h('div', { class: 'erd-tb-right' },
        els.search,
        h('button', { type: 'button', class: 'secondary', title: 'Add a table (or double-click the canvas)', onClick: () => addEntity() }, '+ Table'),
        h('button', { type: 'button', class: 'secondary', title: 'Arrange all tables automatically', onClick: () => { ensureLayout(true); render(); fit(true); postEdit('Auto layout', true); } }, 'Auto layout'),
        h('button', { type: 'button', class: 'secondary icon', title: 'Zoom out (Ctrl+wheel)', 'aria-label': 'Zoom out', onClick: () => zoomBy(1 / 1.2) }, '−'),
        els.zoomLabel,
        h('button', { type: 'button', class: 'secondary icon', title: 'Zoom in (Ctrl+wheel)', 'aria-label': 'Zoom in', onClick: () => zoomBy(1.2) }, '+'),
        h('button', { type: 'button', class: 'secondary', title: 'Fit the diagram to the window (F)', onClick: () => fit(true) }, 'Fit'),
        els.dialect,
        meta.canSync ? h('button', { type: 'button', class: 'secondary', title: meta.syncHint, onClick: () => vscode.postMessage({ type: 'sync' }) }, '⟳ Sync') : null,
        menu('Generate', [
          ['JPA entities…', 'with a live preview', () => vscode.postMessage({ type: 'generateEntities' })],
          ['SQL DDL', 'for the selected database', () => vscode.postMessage({ type: 'generateSql', dialect: doc.dialect })],
        ]),
        menu('Export', [
          ['SVG image', 'vector, for docs', () => exportSvg()],
          ['PNG image', '2× resolution', () => exportPng()],
        ]),
      ),
    );

    els.svg = svg('svg', { class: 'erd-canvas', role: 'img', 'aria-label': `Entity relationship diagram: ${doc.name}` },
      svg('defs', {}, svg('pattern', { id: 'dots', width: 24, height: 24, patternUnits: 'userSpaceOnUse' }, svg('circle', { cx: 1, cy: 1, r: 1, class: 'erd-dot' }))),
      svg('rect', { class: 'erd-bg', width: '100%', height: '100%', fill: 'url(#dots)' }),
    );
    els.viewport = svg('g', { class: 'erd-viewport' });
    els.edges = svg('g', { class: 'erd-edges' });
    els.cards = svg('g', { class: 'erd-cards' });
    els.viewport.append(els.edges, els.cards);
    els.svg.appendChild(els.viewport);

    els.inspector = h('aside', { class: 'erd-inspector hidden', 'aria-label': 'Inspector' });
    els.toast = h('div', { class: 'erd-toast hidden', role: 'status', 'aria-live': 'polite' });
    els.legend = h('div', { class: 'erd-legend', 'aria-hidden': 'true' });
    els.empty = h('div', { class: 'erd-empty hidden' },
      h('strong', null, 'This diagram is empty'),
      h('p', null, 'Add a table, or start from your entities or a database connection.'),
      h('button', { type: 'button', onClick: () => addEntity() }, '+ Add Table'),
    );
    els.stage = h('div', { class: 'erd-stage' }, els.svg, els.empty, els.legend, els.toast);
    replace(app, h('div', { class: 'erd-root' }, toolbar, h('div', { class: 'erd-body' }, els.stage, els.inspector)));
    app.removeAttribute('aria-busy');
    wireCanvas();
    renderLegend();
    document.addEventListener('click', () => document.querySelectorAll('.erd-menu').forEach(m => m.classList.add('hidden')));
  }

  function renderLegend() {
    const w = 168;
    const line = (/** @type {number} */ y, /** @type {string} */ a, /** @type {string} */ b, /** @type {string} */ label) => [
      svg('line', { x1: 8, y1: y, x2: 64, y2: y, stroke: theme.edge, 'stroke-width': 1.4 }),
      ...decoration(8, y, 1, a, theme.edge),
      ...decoration(64, y, -1, b, theme.edge),
      svg('text', { x: 74, y: y + 4, fill: theme.muted, 'font-size': 11, 'font-family': theme.font }, label),
    ];
    replace(els.legend, svg('svg', { width: w, height: 70, viewBox: `0 0 ${w} 70` },
      ...line(14, 'many-optional', 'one-mandatory', 'many to one'),
      ...line(36, 'one-optional', 'one-mandatory', 'one to one'),
      ...line(58, 'many-optional', 'one-optional', 'optional parent'),
    ));
  }

  function setView(/** @type {string} */ v) {
    view = v;
    vscode.setState({ ...(vscode.getState() || {}), view });
    vscode.postMessage({ type: 'viewChanged', view });
    render();
    renderInspector();
  }

  // ------------------------------------------------------------------ rendering

  const matches = (/** @type {any} */ e) => !!search && (e.table.toLowerCase().includes(search) || className(e).toLowerCase().includes(search));

  function render() {
    if (!doc) {
      return;
    }
    readTheme();
    els.viewToggle.querySelectorAll('button').forEach((/** @type {HTMLElement} */ b) => b.setAttribute('aria-pressed', String(b.dataset.view === view)));
    const entities = visibleEntities();
    geometry = new Map(entities.map((/** @type {any} */ e) => [e.id, { e, ...measure(e) }]));
    replace(els.cards, entities.map(renderCard));
    renderEdges();
    applyTransform();
    const rels = view === 'logical' ? logicalEdges().length : doc.relationships.length;
    replace(els.counts, `${entities.length} ${view === 'physical' ? 'tables' : 'entities'} · ${rels} relationships`);
    els.empty.classList.toggle('hidden', doc.entities.length > 0);
    els.legend.classList.toggle('hidden', doc.entities.length === 0);
  }

  function renderCard(/** @type {any} */ e) {
    const g = geometry.get(e.id);
    const isSel = selected?.type === 'entity' && selected.id === e.id;
    const color = e.color || theme.accent;
    const dim = search && !matches(e);
    const title = view === 'physical' ? e.table : className(e);
    const subtitle = view === 'physical' ? className(e) : `${e.schema ? `${e.schema}.` : ''}${e.table}`;
    const card = svg('g', {
      class: `erd-card${isSel ? ' selected' : ''}${dim ? ' dimmed' : ''}${matches(e) ? ' match' : ''}`,
      transform: `translate(${e.x},${e.y})`, 'data-id': e.id, tabindex: 0, role: 'group',
      'aria-label': `${title}: ${g.rows.length} ${view === 'physical' ? 'columns' : 'fields'}`,
    },
    svg('rect', { class: 'erd-shadow', x: 2, y: 3, width: g.width, height: g.height, rx: 8 }),
    svg('rect', { class: 'erd-card-bg', width: g.width, height: g.height, rx: 8, fill: theme.card, stroke: isSel ? theme.accent : theme.border, 'stroke-width': isSel ? 2 : 1 }),
    svg('path', { d: `M0 8 Q0 0 8 0 H${g.width - 8} Q${g.width} 0 ${g.width} 8 V${HEADER} H0 Z`, fill: color, 'fill-opacity': 0.16 }),
    svg('rect', { x: 0, y: 0, width: 4, height: HEADER, fill: color, rx: 2 }),
    svg('line', { x1: 0, y1: HEADER, x2: g.width, y2: HEADER, stroke: theme.border }),
    svg('text', { x: PADX + 2, y: 17, class: 'erd-card-title', fill: theme.fg, 'font-family': theme.font, 'font-size': 13, 'font-weight': 600 }, title),
    svg('text', { x: PADX + 2, y: 31, fill: theme.muted, 'font-family': theme.font, 'font-size': 11 }, subtitle),
    e.kind === 'view' ? svg('text', { x: g.width - PADX, y: 17, 'text-anchor': 'end', fill: theme.muted, 'font-family': theme.font, 'font-size': 10 }, 'VIEW') : null,
    ...g.rows.map((/** @type {any} */ r, /** @type {number} */ i) => renderRow(r, i, g.width)),
    g.rows.length === 0 ? svg('text', { x: PADX, y: HEADER + 16, fill: theme.muted, 'font-family': theme.font, 'font-size': 11, 'font-style': 'italic' }, 'no columns') : null,
    );
    return card;
  }

  function renderRow(/** @type {any} */ r, /** @type {number} */ i, /** @type {number} */ width) {
    const y = HEADER + i * ROW + 3;
    const cy = y + ROW / 2;
    const icon = r.pk && r.fk ? keyIcon(PADX, cy, theme.pk, theme.fk) : r.pk ? keyIcon(PADX, cy, theme.pk) : r.fk ? linkIcon(PADX, cy, theme.fk) : null;
    return svg('g', { class: `erd-row${r.inverse ? ' inverse' : ''}` },
      i % 2 === 1 ? svg('rect', { x: 1, y, width: width - 2, height: ROW, class: 'erd-row-alt' }) : null,
      icon,
      svg('text', {
        x: PADX + ICON + 6, y: cy + 4, fill: r.inverse ? theme.muted : theme.fg, 'font-family': theme.font, 'font-size': 12,
        'font-weight': r.pk ? 600 : 400, 'font-style': r.inverse ? 'italic' : 'normal',
      }, r.name),
      svg('text', { x: width - PADX, y: cy + 4, 'text-anchor': 'end', fill: theme.muted, 'font-family': theme.mono, 'font-size': 11 }, r.type + (r.nullable && view === 'physical' ? '' : '')),
      r.nullable === false && !r.pk && view === 'physical' ? svg('title', {}, 'NOT NULL') : null,
    );
  }

  function keyIcon(/** @type {number} */ x, /** @type {number} */ cy, /** @type {string} */ color, /** @type {string} */ fkColor = '') {
    return svg('g', { 'aria-hidden': 'true' },
      svg('circle', { cx: x + 4, cy, r: 3.2, fill: 'none', stroke: color, 'stroke-width': 1.6 }),
      svg('path', { d: `M${x + 7} ${cy} H${x + 13} M${x + 11} ${cy} V${cy + 3} M${x + 13} ${cy} V${cy + 2.5}`, stroke: fkColor || color, 'stroke-width': 1.6, fill: 'none', 'stroke-linecap': 'round' }),
    );
  }

  function linkIcon(/** @type {number} */ x, /** @type {number} */ cy, /** @type {string} */ color) {
    return svg('path', {
      'aria-hidden': 'true', fill: 'none', stroke: color, 'stroke-width': 1.6, 'stroke-linecap': 'round',
      d: `M${x + 6} ${cy + 3} L${x + 3.5} ${cy + 5.5} a2.5 2.5 0 0 1 -3.5 -3.5 L${x + 2.5} ${cy - 0.5} M${x + 7} ${cy - 3} L${x + 9.5} ${cy - 5.5} a2.5 2.5 0 0 1 3.5 3.5 L${x + 10.5} ${cy + 0.5} M${x + 5} ${cy + 1} L${x + 8} ${cy - 2}`,
    });
  }

  /** Relationship lines for the current view: join tables collapse into many-to-many lines in the entity view. */
  function logicalEdges() {
    /** @type {any[]} */
    const edges = [];
    for (const r of doc.relationships) {
      const from = entityById(r.from);
      if (!from || !entityById(r.to)) {
        continue;
      }
      if (view === 'logical' && isCollectionTable(from)) {
        continue; // drawn as a field on its owner
      }
      if (view === 'logical' && isJoinTable(from)) {
        const pair = doc.relationships.filter((/** @type {any} */ x) => x.from === from.id);
        if (pair[0].id !== r.id) {
          continue; // one line per join table
        }
        edges.push({ id: r.id, from: pair[0].to, to: pair[1].to, manyToMany: true, label: from.table, rel: r, fromRow: rowIndex(pair[0].to, pair[0].inverseField), toRow: rowIndex(pair[1].to, pair[1].inverseField) });
        continue;
      }
      const fromCol = from.columns.find((/** @type {any} */ c) => c.name === r.columns[0]);
      const g = geometry.get(r.from);
      const fromRow = g ? g.rows.findIndex((/** @type {any} */ x) => (r.columns.includes(x.column) && (view === 'physical' || x.rel === r.id || x.column === r.columns[0]))) : -1;
      const tg = geometry.get(r.to);
      const toRow = tg ? tg.rows.findIndex((/** @type {any} */ x) => x.column === r.refColumns[0]) : -1;
      edges.push({
        id: r.id, from: r.from, to: r.to, rel: r, oneToOne: !!r.oneToOne, optional: !fromCol || fromCol.nullable,
        label: view === 'physical' ? r.columns.join(', ') : relField(r), fromRow, toRow,
      });
    }
    return edges;
  }

  const rowIndex = (/** @type {string} */ entityId, /** @type {string} */ name) => {
    const g = geometry.get(entityId);
    return g && name ? g.rows.findIndex((/** @type {any} */ r) => r.name === name) : -1;
  };

  function anchorY(/** @type {any} */ g, /** @type {number} */ row) {
    return g.e.y + (row >= 0 ? HEADER + row * ROW + 3 + ROW / 2 : HEADER / 2);
  }

  function renderEdges() {
    const edges = logicalEdges();
    const nodes = [];
    for (const edge of edges) {
      const a = geometry.get(edge.from);
      const b = geometry.get(edge.to);
      if (!a || !b) {
        continue;
      }
      const sy = anchorY(a, edge.fromRow);
      const ty = anchorY(b, edge.toRow);
      const aL = a.e.x;
      const aR = a.e.x + a.width;
      const bL = b.e.x;
      const bR = b.e.x + b.width;
      let sx;
      let tx;
      let ds;
      let dt;
      if (edge.from === edge.to) {
        sx = aR; tx = aR; ds = 1; dt = 1;
      } else if (aR + 24 < bL) {
        sx = aR; tx = bL; ds = 1; dt = -1;
      } else if (bR + 24 < aL) {
        sx = aL; tx = bR; ds = -1; dt = 1;
      } else {
        sx = aR; tx = bR; ds = 1; dt = 1;
      }
      const span = Math.abs(tx - sx);
      const k = ds === dt ? 48 + Math.abs(ty - sy) * 0.15 + (edge.from === edge.to ? 12 : Math.abs(tx - sx) * 0.5) : Math.max(48, span * 0.45);
      const p0 = [sx + ds * 18, sy];
      const p3 = [tx + dt * 18, ty];
      const c1 = [p0[0] + ds * k, sy];
      const c2 = [p3[0] + dt * k, ty];
      const d = `M${sx} ${sy} H${p0[0]} C${c1[0]} ${c1[1]} ${c2[0]} ${c2[1]} ${p3[0]} ${p3[1]} H${tx}`;
      const active = hovered && (edge.from === hovered || edge.to === hovered);
      const isSel = selected?.type === 'rel' && selected.id === edge.id;
      const muted = hovered && !active;
      const color = isSel || active ? theme.accent : theme.edge;
      const fromEnd = edge.manyToMany ? 'many-optional' : edge.oneToOne ? 'one-optional' : 'many-optional';
      const toEnd = edge.manyToMany ? 'many-optional' : edge.optional ? 'one-optional' : 'one-mandatory';
      const mid = bezier(0.5, p0, c1, c2, p3);
      const label = edge.label ? edgeLabel(mid[0], mid[1], edge.manyToMany ? `${edge.label} · M:N` : edge.label, color) : null;
      nodes.push(svg('g', {
        class: `erd-edge${muted ? ' muted' : ''}${isSel ? ' selected' : ''}`, 'data-rel': edge.rel.id,
        onClick: (/** @type {Event} */ ev) => { ev.stopPropagation(); select({ type: 'rel', id: edge.rel.id }); },
      },
      svg('path', { d, class: 'erd-edge-hit', fill: 'none' }),
      svg('path', { d, fill: 'none', stroke: color, 'stroke-width': isSel || active ? 2 : 1.4, 'stroke-dasharray': edge.manyToMany ? '6 4' : null }),
      ...decoration(sx, sy, ds, fromEnd, color),
      ...decoration(tx, ty, dt, toEnd, color),
      label,
      svg('title', {}, describeEdge(edge)),
      ));
    }
    replace(els.edges, nodes);
  }

  function describeEdge(/** @type {any} */ edge) {
    const a = entityById(edge.from);
    const b = entityById(edge.to);
    if (edge.manyToMany) {
      return `${className(a)} ↔ ${className(b)}: many-to-many through ${edge.label}`;
    }
    return `${view === 'physical' ? a.table : className(a)} → ${view === 'physical' ? b.table : className(b)}: ${edge.oneToOne ? 'one-to-one' : 'many-to-one'}${edge.optional ? ', optional' : ''} (${edge.rel.columns.join(', ')})`;
  }

  function bezier(/** @type {number} */ t, /** @type {number[]} */ p0, /** @type {number[]} */ p1, /** @type {number[]} */ p2, /** @type {number[]} */ p3) {
    const u = 1 - t;
    return [0, 1].map(i => u * u * u * p0[i] + 3 * u * u * t * p1[i] + 3 * u * t * t * p2[i] + t * t * t * p3[i]);
  }

  function edgeLabel(/** @type {number} */ x, /** @type {number} */ y, /** @type {string} */ text, /** @type {string} */ color) {
    const w = textWidth(text, `11px ${theme.font}`) + 12;
    return svg('g', { class: 'erd-edge-label' },
      svg('rect', { x: x - w / 2, y: y - 9, width: w, height: 18, rx: 9, fill: theme.bg, stroke: color, 'stroke-opacity': 0.5 }),
      svg('text', { x, y: y + 4, 'text-anchor': 'middle', fill: theme.muted, 'font-family': theme.font, 'font-size': 11 }, text),
    );
  }

  /**
   * Crow's-foot end marks drawn at (x, y) pointing into a card on side `dir` (+1: card is to the left).
   * Kinds: many-optional (o<), one-optional (o|), one-mandatory (||).
   */
  function decoration(/** @type {number} */ x, /** @type {number} */ y, /** @type {number} */ dir, /** @type {string} */ kind, /** @type {string} */ color) {
    const parts = [];
    const stroke = { stroke: color, 'stroke-width': 1.4, fill: 'none', 'stroke-linecap': 'round' };
    if (kind.startsWith('many')) {
      parts.push(svg('path', { ...stroke, d: `M${x + dir * 11} ${y} L${x} ${y - 6} M${x + dir * 11} ${y} L${x} ${y + 6} M${x + dir * 11} ${y} L${x} ${y}` }));
    } else {
      parts.push(svg('line', { ...stroke, x1: x + dir * 8, y1: y - 6, x2: x + dir * 8, y2: y + 6 }));
    }
    if (kind === 'one-mandatory') {
      parts.push(svg('line', { ...stroke, x1: x + dir * 13, y1: y - 6, x2: x + dir * 13, y2: y + 6 }));
    } else {
      parts.push(svg('circle', { cx: x + dir * 17, cy: y, r: 3.5, fill: theme.bg, stroke: color, 'stroke-width': 1.4 }));
    }
    return parts;
  }

  // ------------------------------------------------------------------ viewport

  function applyTransform() {
    els.viewport.setAttribute('transform', `translate(${panX},${panY}) scale(${zoom})`);
    const pattern = els.svg.querySelector('#dots');
    pattern.setAttribute('patternTransform', `translate(${panX},${panY}) scale(${zoom})`);
    replace(els.zoomLabel, `${Math.round(zoom * 100)}%`);
  }

  function bounds() {
    const gs = [...geometry.values()];
    if (!gs.length) {
      return { x: 0, y: 0, width: 400, height: 300 };
    }
    const x = Math.min(...gs.map(g => g.e.x));
    const y = Math.min(...gs.map(g => g.e.y));
    return { x, y, width: Math.max(...gs.map(g => g.e.x + g.width)) - x, height: Math.max(...gs.map(g => g.e.y + g.height)) - y };
  }

  function fit(/** @type {boolean} */ animate) {
    const b = bounds();
    const rect = els.svg.getBoundingClientRect();
    const margin = 48;
    const z = Math.min(1.1, Math.max(0.15, Math.min((rect.width - margin * 2) / b.width, (rect.height - margin * 2) / b.height)));
    const target = { zoom: z, panX: (rect.width - b.width * z) / 2 - b.x * z, panY: (rect.height - b.height * z) / 2 - b.y * z };
    animateTo(target, animate);
  }

  function centerOn(/** @type {any} */ e) {
    const g = geometry.get(e.id);
    const rect = els.svg.getBoundingClientRect();
    const z = Math.max(zoom, 0.8);
    animateTo({ zoom: z, panX: rect.width / 2 - (e.x + g.width / 2) * z, panY: rect.height / 2 - (e.y + g.height / 2) * z }, true);
  }

  function animateTo(/** @type {{zoom: number, panX: number, panY: number}} */ t, /** @type {boolean} */ animate) {
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (!animate || reduce) {
      zoom = t.zoom;
      panX = t.panX;
      panY = t.panY;
      applyTransform();
      return;
    }
    const from = { zoom, panX, panY };
    const start = performance.now();
    const step = (/** @type {number} */ now) => {
      const k = Math.min(1, (now - start) / 220);
      const ease = 1 - Math.pow(1 - k, 3);
      zoom = from.zoom + (t.zoom - from.zoom) * ease;
      panX = from.panX + (t.panX - from.panX) * ease;
      panY = from.panY + (t.panY - from.panY) * ease;
      applyTransform();
      if (k < 1) {
        requestAnimationFrame(step);
      }
    };
    requestAnimationFrame(step);
  }

  function zoomBy(/** @type {number} */ factor, /** @type {number} */ cx, /** @type {number} */ cy) {
    const rect = els.svg.getBoundingClientRect();
    const px = cx ?? rect.width / 2;
    const py = cy ?? rect.height / 2;
    const nz = Math.min(2.5, Math.max(0.15, zoom * factor));
    panX = px - (px - panX) * (nz / zoom);
    panY = py - (py - panY) * (nz / zoom);
    zoom = nz;
    applyTransform();
  }

  const toWorld = (/** @type {number} */ clientX, /** @type {number} */ clientY) => {
    const rect = els.svg.getBoundingClientRect();
    return { x: (clientX - rect.left - panX) / zoom, y: (clientY - rect.top - panY) / zoom };
  };

  function wireCanvas() {
    /** @type {null | {kind: 'pan' | 'drag', id?: string, startX: number, startY: number, ox: number, oy: number, moved: boolean}} */
    let gesture = null;
    els.svg.addEventListener('pointerdown', (/** @type {PointerEvent} */ ev) => {
      if (ev.button !== 0) {
        return;
      }
      const card = /** @type {Element} */ (ev.target).closest?.('.erd-card');
      if (/** @type {Element} */ (ev.target).closest?.('.erd-edge')) {
        return;
      }
      els.svg.setPointerCapture(ev.pointerId);
      if (card) {
        const e = entityById(card.getAttribute('data-id'));
        gesture = { kind: 'drag', id: e.id, startX: ev.clientX, startY: ev.clientY, ox: e.x, oy: e.y, moved: false };
      } else {
        gesture = { kind: 'pan', startX: ev.clientX, startY: ev.clientY, ox: panX, oy: panY, moved: false };
        els.svg.classList.add('panning');
      }
    });
    els.svg.addEventListener('pointermove', (/** @type {PointerEvent} */ ev) => {
      if (!gesture) {
        const card = /** @type {Element} */ (ev.target).closest?.('.erd-card');
        const id = card ? card.getAttribute('data-id') : null;
        if (id !== hovered) {
          hovered = id;
          renderEdges();
          els.cards.querySelectorAll('.erd-card').forEach((/** @type {Element} */ c) => c.classList.toggle('related', !!hovered && isRelated(hovered, c.getAttribute('data-id'))));
        }
        return;
      }
      const dx = ev.clientX - gesture.startX;
      const dy = ev.clientY - gesture.startY;
      if (Math.abs(dx) + Math.abs(dy) > 3) {
        gesture.moved = true;
      }
      if (gesture.kind === 'pan') {
        panX = gesture.ox + dx;
        panY = gesture.oy + dy;
        applyTransform();
      } else if (gesture.moved) {
        const e = entityById(gesture.id);
        e.x = L.snap(gesture.ox + dx / zoom);
        e.y = L.snap(gesture.oy + dy / zoom);
        const g = geometry.get(e.id);
        if (g) {
          g.e = e;
        }
        const node = els.cards.querySelector(`[data-id="${CSS.escape(e.id)}"]`);
        node?.setAttribute('transform', `translate(${e.x},${e.y})`);
        node?.parentNode.appendChild(node); // bring to front
        renderEdges();
      }
    });
    const end = (/** @type {PointerEvent} */ ev) => {
      if (!gesture) {
        return;
      }
      const g = gesture;
      gesture = null;
      els.svg.classList.remove('panning');
      if (els.svg.hasPointerCapture(ev.pointerId)) {
        els.svg.releasePointerCapture(ev.pointerId);
      }
      if (g.kind === 'drag') {
        if (g.moved) {
          postEdit('Move table', true);
        }
        select({ type: 'entity', id: g.id });
      } else if (!g.moved && selected) {
        select(null);
      }
    };
    els.svg.addEventListener('pointerup', end);
    els.svg.addEventListener('pointercancel', end);
    els.svg.addEventListener('wheel', (/** @type {WheelEvent} */ ev) => {
      ev.preventDefault();
      if (ev.ctrlKey || ev.metaKey) {
        const rect = els.svg.getBoundingClientRect();
        zoomBy(Math.exp(-ev.deltaY * 0.0025), ev.clientX - rect.left, ev.clientY - rect.top);
      } else {
        panX -= ev.deltaX;
        panY -= ev.deltaY;
        applyTransform();
      }
    }, { passive: false });
    els.svg.addEventListener('dblclick', (/** @type {MouseEvent} */ ev) => {
      if (/** @type {Element} */ (ev.target).closest?.('.erd-card')) {
        focusInspector();
        return;
      }
      const p = toWorld(ev.clientX, ev.clientY);
      addEntity(p.x, p.y);
    });
    window.addEventListener('resize', () => applyTransform());
    document.addEventListener('keydown', (/** @type {KeyboardEvent} */ ev) => {
      const t = /** @type {HTMLElement} */ (ev.target);
      if (t && (t.tagName === 'INPUT' || t.tagName === 'SELECT' || t.tagName === 'TEXTAREA')) {
        return;
      }
      if ((ev.key === 'Delete' || ev.key === 'Backspace') && selected) {
        ev.preventDefault();
        deleteSelected();
      } else if (ev.key === 'f' && !ev.ctrlKey && !ev.metaKey) {
        fit(true);
      } else if ((ev.key === 'f' || ev.key === 'F') && (ev.ctrlKey || ev.metaKey)) {
        ev.preventDefault();
        els.search.focus();
      } else if (ev.key === 'Escape') {
        select(null);
      } else if (selected?.type === 'entity' && ev.key.startsWith('Arrow')) {
        ev.preventDefault();
        const e = entityById(selected.id);
        const step = ev.shiftKey ? L.GRID * 4 : L.GRID;
        e.x += ev.key === 'ArrowLeft' ? -step : ev.key === 'ArrowRight' ? step : 0;
        e.y += ev.key === 'ArrowUp' ? -step : ev.key === 'ArrowDown' ? step : 0;
        render();
        postEdit('Move table');
      }
    });
  }

  function isRelated(/** @type {string} */ a, /** @type {string | null} */ b) {
    if (!b || a === b) {
      return false;
    }
    return logicalEdges().some(e => (e.from === a && e.to === b) || (e.to === a && e.from === b));
  }

  // ------------------------------------------------------------------ editing

  function select(/** @type {null | {type: 'entity' | 'rel', id: string}} */ s) {
    selected = s;
    render();
    renderInspector();
  }

  function addEntity(/** @type {number} */ x, /** @type {number} */ y) {
    let name = 'new_table';
    for (let i = 2; doc.entities.some((/** @type {any} */ e) => e.table === name || e.id === name); i++) {
      name = `new_table_${i}`;
    }
    if (x === undefined) {
      const rect = els.svg.getBoundingClientRect();
      const p = toWorld(rect.left + rect.width / 2 - 100, rect.top + rect.height / 2 - 60);
      x = p.x;
      y = p.y;
    }
    const e = {
      id: name, table: name, kind: 'table', x: L.snap(x), y: L.snap(y), color: meta.colors[doc.entities.length % meta.colors.length],
      columns: [{ name: 'id', type: 'BIGINT', nullable: false, primaryKey: true, autoIncrement: true, unique: false }],
    };
    doc.entities.push(e);
    select({ type: 'entity', id: e.id });
    postEdit('Add table', true);
    focusInspector();
  }

  function deleteSelected() {
    if (!selected) {
      return;
    }
    if (selected.type === 'entity') {
      const id = selected.id;
      doc.entities = doc.entities.filter((/** @type {any} */ e) => e.id !== id);
      doc.relationships = doc.relationships.filter((/** @type {any} */ r) => r.from !== id && r.to !== id);
      flash('Table deleted. Undo with Ctrl+Z.');
    } else {
      const id = selected.id;
      doc.relationships = doc.relationships.filter((/** @type {any} */ r) => r.id !== id);
      flash('Relationship deleted. Undo with Ctrl+Z.');
    }
    select(null);
    postEdit('Delete', true);
  }

  function focusInspector() {
    setTimeout(() => els.inspector.querySelector('input')?.focus(), 30);
  }

  function renderInspector() {
    const item = findSelected();
    els.inspector.classList.toggle('hidden', !item);
    if (!item) {
      replace(els.inspector);
      return;
    }
    if (selected?.type === 'rel') {
      replace(els.inspector, ...relationshipInspector(item));
    } else {
      replace(els.inspector, ...entityInspector(item));
    }
  }

  /** Text field bound to an object property; edits re-render the canvas without rebuilding the inspector. */
  function bound(/** @type {any} */ obj, /** @type {string} */ key, /** @type {Record<string, any>} */ props = {}) {
    return h('input', {
      type: 'text', value: obj[key] ?? '', spellcheck: 'false', ...props,
      onInput: (/** @type {Event} */ ev) => {
        const v = /** @type {HTMLInputElement} */ (ev.target).value;
        obj[key] = props.type === 'number' ? (v === '' ? undefined : Number(v)) : (v || (props.optional ? undefined : v));
        render();
        postEdit('Edit');
      },
    });
  }

  function entityInspector(/** @type {any} */ e) {
    const pk = e.columns.filter((/** @type {any} */ c) => c.primaryKey);
    const outgoing = doc.relationships.filter((/** @type {any} */ r) => r.from === e.id);
    const incoming = doc.relationships.filter((/** @type {any} */ r) => r.to === e.id);
    const typeSelect = (/** @type {any} */ c) => h('select', {
      'aria-label': `Type of ${c.name}`, onChange: (/** @type {Event} */ ev) => {
        c.type = /** @type {HTMLSelectElement} */ (ev.target).value;
        delete c.nativeType;
        render();
        renderInspector();
        postEdit('Change type', true);
      },
    }, meta.types.map((/** @type {string} */ t) => h('option', { value: t, selected: t === c.type }, t)));
    const flag = (/** @type {any} */ c, /** @type {string} */ key, /** @type {string} */ label, /** @type {string} */ title) => h('label', { class: 'erd-flag', title },
      h('input', {
        type: 'checkbox', checked: key === 'nullable' ? !c.nullable : !!c[key], onChange: (/** @type {Event} */ ev) => {
          const on = /** @type {HTMLInputElement} */ (ev.target).checked;
          if (key === 'nullable') {
            c.nullable = !on;
          } else {
            c[key] = on;
          }
          if (key === 'primaryKey' && on) {
            c.nullable = false;
          }
          render();
          postEdit('Edit column', true);
        },
      }), label);
    const sizeInput = (/** @type {any} */ c) => c.type === 'DECIMAL'
      ? h('span', { class: 'erd-size' }, bound(c, 'precision', { type: 'number', min: 1, 'aria-label': 'Precision', placeholder: 'p' }), bound(c, 'scale', { type: 'number', min: 0, 'aria-label': 'Scale', placeholder: 's' }))
      : ['VARCHAR', 'CHAR', 'BINARY'].includes(c.type) ? bound(c, 'length', { type: 'number', min: 1, 'aria-label': 'Length', placeholder: 'len' }) : h('span');

    return [
      h('div', { class: 'erd-insp-head' },
        h('div', { class: 'erd-swatches', role: 'radiogroup', 'aria-label': 'Color' }, meta.colors.map((/** @type {string} */ col) => h('button', {
          type: 'button', class: `erd-swatch${e.color === col ? ' on' : ''}`, 'aria-label': `Color ${col}`, 'aria-pressed': String(e.color === col), title: 'Header color',
          onClick: () => { e.color = col; render(); renderInspector(); postEdit('Color', true); },
        }, svg('svg', { width: 16, height: 16, viewBox: '0 0 16 16', 'aria-hidden': 'true' }, svg('circle', { cx: 8, cy: 8, r: 7, fill: col }))))),
        h('button', { type: 'button', class: 'link', 'aria-label': 'Close inspector', onClick: () => select(null) }, 'Close'),
      ),
      h('div', { class: 'field' }, h('label', null, 'Table'), bound(e, 'table', { 'aria-label': 'Table name' })),
      h('div', { class: 'row' },
        h('div', { class: 'field' }, h('label', null, 'Class'), bound(e, 'className', { placeholder: className({ table: e.table }), optional: true, 'aria-label': 'Class name' })),
        h('div', { class: 'field small' }, h('label', null, 'Schema'), bound(e, 'schema', { optional: true, 'aria-label': 'Schema' })),
      ),
      h('div', { class: 'field' }, h('label', null, 'Comment'), bound(e, 'comment', { optional: true, 'aria-label': 'Comment' })),
      h('h2', null, `Columns (${e.columns.length})`),
      h('div', { class: 'erd-cols' },
        h('div', { class: 'erd-col head' }, h('span', null, 'Name'), h('span', null, 'Type'), h('span', null, 'Size'), h('span', { title: 'Primary key' }, 'PK'), h('span', { title: 'Not null' }, 'NN'), h('span', { title: 'Unique' }, 'UQ'), h('span', { title: 'Auto increment' }, 'AI'), h('span')),
        e.columns.map((/** @type {any} */ c) => h('div', { class: 'erd-col' },
          bound(c, 'name', { 'aria-label': 'Column name' }),
          typeSelect(c),
          sizeInput(c),
          flag(c, 'primaryKey', '', 'Primary key'),
          flag(c, 'nullable', '', 'Not null'),
          flag(c, 'unique', '', 'Unique'),
          flag(c, 'autoIncrement', '', 'Auto increment'),
          h('button', {
            type: 'button', class: 'link danger', 'aria-label': `Delete column ${c.name}`, title: 'Delete column',
            onClick: () => {
              e.columns = e.columns.filter((/** @type {any} */ x) => x !== c);
              doc.relationships = doc.relationships.filter((/** @type {any} */ r) => !(r.from === e.id && r.columns.includes(c.name)));
              render();
              renderInspector();
              postEdit('Delete column', true);
            },
          }, '✕'),
        )),
      ),
      h('button', {
        type: 'button', class: 'secondary', onClick: () => {
          let n = 'column';
          for (let i = 2; e.columns.some((/** @type {any} */ c) => c.name === n); i++) {
            n = `column_${i}`;
          }
          e.columns.push({ name: n, type: 'VARCHAR', length: 255, nullable: true, primaryKey: false, autoIncrement: false, unique: false });
          render();
          renderInspector();
          postEdit('Add column', true);
          setTimeout(() => /** @type {HTMLInputElement} */ ([...els.inspector.querySelectorAll('.erd-col input[type=text]')].pop())?.select(), 30);
        },
      }, '+ Add column'),
      h('h2', null, 'Relationships'),
      outgoing.length || incoming.length ? null : h('p', { class: 'hint' }, 'No relationships yet.'),
      ...outgoing.map((/** @type {any} */ r) => relRow(r, `→ ${className(entityById(r.to) || { table: r.to })}`, `${r.columns.join(', ')}${r.field ? ` · ${r.field}` : ''}`)),
      ...incoming.map((/** @type {any} */ r) => relRow(r, `← ${className(entityById(r.from) || { table: r.from })}`, `${r.columns.join(', ')}${r.inverseField ? ` · ${r.inverseField}` : ''}`)),
      addRelationship(e, pk),
      h('div', { class: 'erd-insp-foot' },
        h('button', { type: 'button', class: 'secondary danger', onClick: () => deleteSelected() }, 'Delete table'),
        h('span', { class: 'hint' }, 'Ctrl+Z undoes any change'),
      ),
    ];
  }

  function relRow(/** @type {any} */ r, /** @type {string} */ title, /** @type {string} */ detail) {
    return h('button', { type: 'button', class: 'erd-rel', onClick: () => select({ type: 'rel', id: r.id }) },
      h('span', null, title), h('span', { class: 'hint' }, detail));
  }

  function addRelationship(/** @type {any} */ e, /** @type {any[]} */ pk) {
    void pk;
    const targets = doc.entities.filter((/** @type {any} */ x) => x.columns.some((/** @type {any} */ c) => c.primaryKey));
    const sel = h('select', { 'aria-label': 'Referenced table' },
      h('option', { value: '' }, 'Reference a table…'),
      targets.map((/** @type {any} */ t) => h('option', { value: t.id }, view === 'physical' ? t.table : className(t))));
    const add = h('button', {
      type: 'button', class: 'secondary', onClick: () => {
        const target = entityById(sel.value);
        if (!target) {
          return;
        }
        const tpk = target.columns.filter((/** @type {any} */ c) => c.primaryKey);
        const field = camel(className(target));
        const cols = tpk.map((/** @type {any} */ c) => {
          let n = `${snake(field)}_${c.name}`;
          for (let i = 2; e.columns.some((/** @type {any} */ x) => x.name === n); i++) {
            n = `${snake(field)}_${c.name}_${i}`;
          }
          e.columns.push({ name: n, type: c.type, length: c.length, precision: c.precision, scale: c.scale, nullable: true, primaryKey: false, autoIncrement: false, unique: false });
          return n;
        });
        const r = { id: uid(), from: e.id, columns: cols, to: target.id, refColumns: tpk.map((/** @type {any} */ c) => c.name), field };
        doc.relationships.push(r);
        render();
        renderInspector();
        postEdit('Add relationship', true);
        flash(`Added ${cols.join(', ')} referencing ${target.table}.`);
      },
    }, 'Add');
    return h('div', { class: 'erd-add-rel' }, sel, add);
  }

  function relationshipInspector(/** @type {any} */ r) {
    const from = entityById(r.from);
    const to = entityById(r.to);
    const fromCols = (from?.columns || []).filter((/** @type {any} */ c) => r.columns.includes(c.name));
    const optional = fromCols.some((/** @type {any} */ c) => c.nullable);
    return [
      h('div', { class: 'erd-insp-head' }, h('strong', null, 'Relationship'), h('button', { type: 'button', class: 'link', onClick: () => select(null) }, 'Close')),
      h('p', null, h('strong', null, from ? className(from) : r.from), ` ${r.oneToOne ? 'has one' : 'belongs to'} `, h('strong', null, to ? className(to) : r.to)),
      h('p', { class: 'hint' }, `${from?.table}(${r.columns.join(', ')}) → ${to?.table}(${r.refColumns.join(', ')})`),
      h('div', { class: 'field' }, h('label', null, 'Association field'), bound(r, 'field', { placeholder: to ? camel(className(to)) : '', optional: true })),
      h('div', { class: 'field' }, h('label', null, 'Inverse field'), bound(r, 'inverseField', { placeholder: 'e.g. orders (optional)', optional: true })),
      h('label', { class: 'check' }, h('input', {
        type: 'checkbox', checked: !!r.oneToOne, onChange: (/** @type {Event} */ ev) => { r.oneToOne = /** @type {HTMLInputElement} */ (ev.target).checked || undefined; render(); postEdit('Edit relationship', true); },
      }), h('span', null, 'One-to-one', h('span', { class: 'hint' }, 'The foreign key is unique'))),
      h('label', { class: 'check' }, h('input', {
        type: 'checkbox', checked: !optional, onChange: (/** @type {Event} */ ev) => {
          const required = /** @type {HTMLInputElement} */ (ev.target).checked;
          fromCols.forEach((/** @type {any} */ c) => { c.nullable = !required; });
          render();
          postEdit('Edit relationship', true);
        },
      }), h('span', null, 'Required', h('span', { class: 'hint' }, 'Foreign key columns are NOT NULL'))),
      h('div', { class: 'erd-insp-foot' }, h('button', { type: 'button', class: 'secondary danger', onClick: () => deleteSelected() }, 'Delete relationship')),
    ];
  }

  // ------------------------------------------------------------------ export

  function standaloneSvg() {
    const b = bounds();
    const m = 32;
    const out = svg('svg', {
      xmlns: NS, viewBox: `${b.x - m} ${b.y - m} ${b.width + m * 2} ${b.height + m * 2}`, width: Math.round(b.width + m * 2), height: Math.round(b.height + m * 2),
      role: 'img', 'aria-label': `Entity relationship diagram: ${doc.name}`, 'font-family': theme.font,
    },
    svg('title', {}, `${doc.name}: entity relationship diagram`),
    svg('rect', { x: b.x - m, y: b.y - m, width: b.width + m * 2, height: b.height + m * 2, fill: theme.bg }),
    els.edges.cloneNode(true), els.cards.cloneNode(true));
    out.querySelectorAll('.erd-edge-hit, .erd-shadow').forEach((/** @type {Element} */ n) => n.remove());
    out.querySelectorAll('.erd-row-alt').forEach((/** @type {Element} */ n) => { n.setAttribute('fill', theme.fg); n.setAttribute('fill-opacity', '0.04'); });
    out.querySelectorAll('[class]').forEach((/** @type {Element} */ n) => n.removeAttribute('class'));
    return new XMLSerializer().serializeToString(out);
  }

  function exportSvg() {
    vscode.postMessage({ type: 'export', format: 'svg', data: standaloneSvg() });
  }

  function exportPng() {
    const text = standaloneSvg();
    const b = bounds();
    const scale = 2;
    const img = new Image();
    img.onload = () => {
      const c = document.createElement('canvas');
      c.width = Math.round((b.width + 64) * scale);
      c.height = Math.round((b.height + 64) * scale);
      const g = /** @type {CanvasRenderingContext2D} */ (c.getContext('2d'));
      g.scale(scale, scale);
      g.drawImage(img, 0, 0);
      vscode.postMessage({ type: 'export', format: 'png', data: c.toDataURL('image/png') });
    };
    img.onerror = () => flash('Could not render the PNG image.', 'error');
    img.src = `data:image/svg+xml;base64,${btoa(unescape(encodeURIComponent(text)))}`;
  }

  // ------------------------------------------------------------------ misc

  /** @type {any} */ let toastTimer;
  function flash(/** @type {string} */ text, /** @type {string} */ kind = 'info') {
    if (!els.toast) {
      return;
    }
    replace(els.toast, text);
    els.toast.className = `erd-toast ${kind}`;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => els.toast.classList.add('hidden'), 3500);
  }

  function renderError(/** @type {string} */ message) {
    replace(app, h('main', { class: 'page' },
      h('div', { class: 'banner error', role: 'alert' },
        h('div', { class: 'grow' }, h('strong', null, 'This file is not a valid ER diagram'), h('div', null, message)),
        h('button', { type: 'button', class: 'secondary', onClick: () => vscode.postMessage({ type: 'openAsText' }) }, 'Open as Text'),
      )));
    app.removeAttribute('aria-busy');
  }

  const saved = vscode.getState();
  if (saved?.view) {
    view = saved.view;
  }
  vscode.postMessage({ type: 'ready' });
})();
