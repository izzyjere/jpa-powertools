// @ts-check
(function () {
  // @ts-ignore
  const { vscode, h, replace, debounce } = window.ui;
  const app = /** @type {HTMLElement} */ (document.getElementById('app'));

  /** @type {any} */
  let init = null;
  /** @type {Set<string>} */
  let selected = new Set();
  /** @type {string | null} */
  let focus = null;
  let filter = '';
  /** @type {any} */
  let options = null;
  let packagesTouched = false;
  /** @type {any} */
  let preview = null;
  let seq = 0;
  let generating = false;
  let activeTab = 0;
  /** @type {Record<string, string>} */
  let errors = {};
  /** @type {Record<string, any>} */
  const els = {};

  window.addEventListener('message', event => {
    const m = event.data;
    switch (m.type) {
      case 'init':
        init = m;
        options = { ...m.options };
        selected = new Set(m.preselected);
        focus = m.preselected[0] || m.tables[0]?.name || null;
        render();
        requestPreview();
        break;
      case 'loadError':
        renderLoadError(m.message);
        break;
      case 'select':
        m.tables.forEach((/** @type {string} */ t) => selected.add(t));
        focus = m.tables[0] || focus;
        renderTables();
        requestPreview();
        break;
      case 'preview':
        if (m.seq !== seq) {
          return;
        }
        preview = m;
        errors = m.errors || {};
        renderPreview();
        renderErrors();
        renderFooter();
        break;
      case 'rootAdded': {
        if (!init.roots.some((/** @type {any} */ r) => r.fsPath === m.root.fsPath)) {
          init.roots.push(m.root);
        }
        setRoot(m.root.fsPath);
        renderRoots();
        break;
      }
      case 'validation':
        generating = false;
        errors = m.errors;
        renderErrors();
        renderFooter();
        break;
      case 'error':
        generating = false;
        renderFooter(m.message);
        break;
      case 'generated':
        generating = false;
        if (!m.cancelled) {
          renderSuccess(m);
        }
        requestPreview();
        break;
    }
  });

  // ------------------------------------------------------------------ helpers

  /** @param {string} label @param {string} key @param {string} [hint] @param {any} [extraProps] */
  function checkbox(label, key, hint, extraProps) {
    const box = h('input', {
      type: 'checkbox', id: `opt-${key}`, checked: !!options[key],
      onChange: () => { options[key] = box.checked; onOptionsChanged(key); },
      ...extraProps,
    });
    els[`opt_${key}`] = box;
    const wrap = h('label', { class: 'check', id: `row-${key}` }, box, h('span', null, label, hint ? h('span', { class: 'hint' }, hint) : null));
    els[`row_${key}`] = wrap;
    return wrap;
  }

  /** @param {string} key @param {string} label @param {string} [hint] */
  function textField(key, label, hint) {
    const input = h('input', {
      type: 'text', id: `opt-${key}`, value: options[key] || '', spellcheck: 'false',
      onInput: () => {
        options[key] = input.value.trim();
        if (key === 'entityPackage' || key === 'repositoryPackage') {
          packagesTouched = true;
        }
        onOptionsChanged(key);
      },
    });
    els[`opt_${key}`] = input;
    return h('div', { class: 'field', id: `field-${key}` },
      h('label', { for: `opt-${key}` }, label),
      input,
      hint ? h('p', { class: 'hint' }, hint) : null,
      h('p', { class: 'error-text hidden', id: `err-${key}`, role: 'alert' }),
    );
  }

  /** @param {string} key */
  function onOptionsChanged(key) {
    if (key === 'relationships') {
      updateDependentOptions();
    }
    if (key === 'generateRepositories') {
      updateDependentOptions();
    }
    requestPreview();
  }

  function updateDependentOptions() {
    els.opt_inverseRelationships.disabled = !options.relationships;
    els.row_inverseRelationships.classList.toggle('disabled', !options.relationships);
    els.opt_repositoryPackage.disabled = !options.generateRepositories;
  }

  const requestPreview = debounce(() => {
    seq++;
    vscode.postMessage({ type: 'preview', tables: [...selected], focus, options, seq });
  }, 120);

  // ------------------------------------------------------------------ render

  function renderLoadError(/** @type {string} */ message) {
    replace(app, h('main', { class: 'page' },
      h('header', { class: 'page-header' }, h('h1', null, 'Generate JPA entities')),
      h('div', { class: 'banner error', role: 'alert' },
        h('div', { class: 'grow' }, h('strong', null, 'Could not read the database schema'), h('div', null, message)),
        h('button', { type: 'button', class: 'secondary', onClick: () => { replace(app, h('div', { class: 'loading' }, h('span', { class: 'spinner' }), ' Loading…')); vscode.postMessage({ type: 'retry' }); } }, 'Retry'),
      ),
    ));
    app.removeAttribute('aria-busy');
  }

  function render() {
    // Table list
    els.search = h('input', {
      type: 'search', placeholder: `Filter ${init.tables.length} tables…`, 'aria-label': 'Filter tables',
      onInput: () => { filter = els.search.value.trim().toLowerCase(); renderTables(); },
    });
    els.count = h('span', { class: 'hint', 'aria-live': 'polite' });
    els.list = h('ul', { class: 'table-list', role: 'listbox', 'aria-multiselectable': 'true', 'aria-label': 'Tables', onKeydown: onListKey });
    els.refs = h('div');
    const tablesPanel = h('aside', { class: 'panel' },
      h('div', { class: 'panel-head' },
        els.search,
        h('div', { class: 'row' },
          els.count,
          h('span', null,
            h('button', { type: 'button', class: 'link', onClick: () => selectVisible(true) }, 'Select all'),
            ' · ',
            h('button', { type: 'button', class: 'link', onClick: () => selectVisible(false) }, 'None'),
          ),
        ),
      ),
      els.list,
      els.refs,
    );

    // Options
    els.root = h('select', { id: 'opt-sourceRoot', onChange: onRootChange });
    const detected = init.detected || {};
    const output = h('div', null,
      h('h2', null, 'Output'),
      h('div', { class: 'field', id: 'field-sourceRoot' },
        h('label', { for: 'opt-sourceRoot' }, 'Source folder'),
        els.root,
        h('p', { class: 'error-text hidden', id: 'err-sourceRoot', role: 'alert' }),
      ),
      textField('entityPackage', 'Entity package'),
      checkbox('Generate Spring Data repositories', 'generateRepositories', detected.springDataJpa ? 'spring-data-jpa found in your build' : undefined),
      textField('repositoryPackage', 'Repository package'),
    );

    const apiRadio = (/** @type {string} */ value, /** @type {string} */ label, /** @type {string} */ hint) => h('label', { class: 'check' },
      h('input', { type: 'radio', name: 'api', value, checked: options.persistenceApi === value, onChange: () => { options.persistenceApi = value; requestPreview(); } }),
      h('span', null, label, detected.persistenceApi === value ? h('span', { class: 'badge outline' }, ' detected ') : null, h('span', { class: 'hint' }, hint)));

    const mapping = h('div', null,
      h('h2', null, 'Mapping'),
      h('div', { class: 'field', role: 'radiogroup', 'aria-label': 'Persistence API' },
        h('span', { class: 'label' }, 'Persistence API'),
        apiRadio('jakarta', 'jakarta.persistence', 'Spring Boot 3+, Hibernate 6+'),
        apiRadio('javax', 'javax.persistence', 'Spring Boot 2, Hibernate 5'),
      ),
      checkbox('Use Lombok', 'lombok', detected.lombok ? 'Lombok found in your build: @Getter/@Setter instead of accessors' : '@Getter/@Setter instead of accessors'),
      checkbox('Map foreign keys to associations', 'relationships', '@ManyToOne / @OneToOne, lazily fetched'),
      checkbox('Also add the inverse @OneToMany side', 'inverseRelationships', 'Bidirectional collections on the referenced entity'),
      checkbox('Map "version" columns to @Version', 'versionColumn', 'Optimistic locking'),
      checkbox('Always write the schema into @Table', 'alwaysSchema',
        init.defaultSchema ? `Otherwise only tables outside "${init.defaultSchema}" get a schema` : undefined),
      textField('stripTablePrefixes', 'Table prefixes to strip', 'Comma separated, e.g. tbl_, t_ (tbl_order → Order)'),
    );
    els.row_inverseRelationships.classList.add('indent');

    els.success = h('div');
    els.tabs = h('div', { class: 'tabs', role: 'tablist' });
    els.code = h('pre', { class: 'code', tabindex: '0', 'aria-label': 'Generated code preview' });
    els.warnings = h('div');
    const previewSection = h('div', null,
      h('h2', null, 'Preview'),
      h('div', { class: 'panel' }, els.tabs, els.code),
      els.warnings,
    );

    const main = h('main', { class: 'page wide' },
      h('header', { class: 'page-header' },
        h('h1', null, 'Generate JPA entities'),
        h('p', { class: 'subtitle' }, `${init.connection}${init.schema ? ` · ${init.schema}` : ''}`),
      ),
      h('div', { class: 'layout' },
        tablesPanel,
        h('section', null, els.success, h('div', { class: 'options-grid' }, output, mapping), previewSection),
      ),
    );

    els.status = h('div', { class: 'status', role: 'status', 'aria-live': 'polite' });
    els.generate = h('button', { type: 'button', onClick: generate }, 'Generate');
    const footer = h('footer', { class: 'actions wide' }, h('div', { class: 'inner' }, els.status, els.generate));

    replace(app, main, footer);
    app.removeAttribute('aria-busy');
    renderRoots();
    renderTables();
    updateDependentOptions();
    renderPreview();
    renderFooter();
    els.search.focus();
  }

  function renderRoots() {
    const opts = init.roots.map((/** @type {any} */ r) => h('option', { value: r.fsPath, selected: r.fsPath === options.sourceRoot }, r.label));
    if (!init.roots.length) {
      opts.unshift(h('option', { value: '', selected: true }, 'No Java project found. Choose a folder…'));
    }
    opts.push(h('option', { value: '__browse__' }, 'Browse…'));
    replace(els.root, opts);
  }

  function onRootChange() {
    const value = els.root.value;
    if (value === '__browse__') {
      els.root.value = options.sourceRoot;
      vscode.postMessage({ type: 'browseRoot' });
      return;
    }
    setRoot(value);
  }

  /** @param {string} fsPath */
  function setRoot(fsPath) {
    options.sourceRoot = fsPath;
    const root = init.roots.find((/** @type {any} */ r) => r.fsPath === fsPath);
    if (root && !packagesTouched) {
      options.entityPackage = root.entityPackage;
      options.repositoryPackage = root.repositoryPackage;
      els.opt_entityPackage.value = root.entityPackage;
      els.opt_repositoryPackage.value = root.repositoryPackage;
    }
    requestPreview();
  }

  function visibleTables() {
    return init.tables.filter((/** @type {any} */ t) => !filter || t.name.toLowerCase().includes(filter));
  }

  /** @param {boolean} on */
  function selectVisible(on) {
    for (const t of visibleTables()) {
      if (on) {
        selected.add(t.name);
      } else {
        selected.delete(t.name);
      }
    }
    renderTables();
    requestPreview();
  }

  function renderTables() {
    const visible = visibleTables();
    const items = visible.map((/** @type {any} */ t) => {
      const box = h('input', {
        type: 'checkbox', checked: selected.has(t.name), tabindex: '-1', 'aria-label': `Include ${t.name}`,
        onClick: (/** @type {Event} */ e) => e.stopPropagation(),
        onChange: () => toggle(t.name, box.checked),
      });
      return h('li', {
        role: 'option', tabindex: t.name === focus ? '0' : '-1', 'aria-selected': String(selected.has(t.name)),
        class: t.name === focus ? 'focused' : '', dataset: { name: t.name },
        title: t.comment || t.name,
        onClick: () => setFocus(t.name),
        onDblclick: () => toggle(t.name, !selected.has(t.name)),
      },
      box,
      h('span', { class: 'name' }, t.name),
      t.kind === 'view' ? h('span', { class: 'badge outline' }, 'view') : null,
      !t.hasPk && t.kind === 'table' ? h('span', { class: 'badge warn', title: 'No primary key: all columns will form the identifier' }, 'no PK') : null,
      );
    });
    if (!items.length) {
      items.push(h('li', { class: 'empty' }, init.tables.length ? 'No tables match the filter.' : 'This schema has no tables.'));
    }
    replace(els.list, items);
    replace(els.count, `${selected.size} of ${init.tables.length} selected`);
    renderReferences();
  }

  function renderReferences() {
    /** @type {Set<string>} */
    const missing = new Set();
    for (const t of selected) {
      for (const r of init.references[t] || []) {
        if (!selected.has(r)) {
          missing.add(r);
        }
      }
    }
    if (!missing.size || !options?.relationships) {
      replace(els.refs);
      return;
    }
    const names = [...missing];
    const shown = names.slice(0, 4).join(', ') + (names.length > 4 ? ` and ${names.length - 4} more` : '');
    replace(els.refs, h('div', { class: 'banner warning', style: undefined },
      h('div', { class: 'grow' },
        h('div', null, `Selected tables reference ${names.length} unselected table${names.length > 1 ? 's' : ''}: ${shown}.`),
        h('div', { class: 'hint' }, 'Those foreign keys become plain columns unless the tables are generated too.'),
        h('button', { type: 'button', class: 'link', onClick: () => { names.forEach(n => selected.add(n)); renderTables(); requestPreview(); } }, 'Add referenced tables'),
      ),
    ));
  }

  /** @param {string} name @param {boolean} on */
  function toggle(name, on) {
    if (on) {
      selected.add(name);
    } else {
      selected.delete(name);
    }
    focus = name;
    renderTables();
    requestPreview();
  }

  /** @param {string} name */
  function setFocus(name) {
    if (focus === name) {
      return;
    }
    focus = name;
    activeTab = 0;
    renderTables();
    const li = els.list.querySelector(`li[data-name="${CSS.escape(name)}"]`);
    li?.focus();
    requestPreview();
  }

  /** @param {KeyboardEvent} e */
  function onListKey(e) {
    const names = visibleTables().map((/** @type {any} */ t) => t.name);
    const idx = focus ? names.indexOf(focus) : -1;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const next = names[Math.max(0, Math.min(names.length - 1, idx + (e.key === 'ArrowDown' ? 1 : -1)))];
      if (next) {
        setFocus(next);
      }
    } else if ((e.key === ' ' || e.key === 'Enter') && focus) {
      e.preventDefault();
      toggle(focus, !selected.has(focus));
      els.list.querySelector(`li[data-name="${CSS.escape(focus)}"]`)?.focus();
    } else if ((e.key === 'a' || e.key === 'A') && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      selectVisible(true);
    }
  }

  function renderPreview() {
    const files = preview?.focusFiles || [];
    if (!focus || !files.length) {
      replace(els.tabs);
      replace(els.code, h('div', { class: 'placeholder' }, preview ? 'Click a table to preview its generated code.' : 'Generating preview…'));
      replace(els.warnings);
      return;
    }
    if (activeTab >= files.length) {
      activeTab = 0;
    }
    const existing = new Set((preview.files || []).filter((/** @type {any} */ f) => f.exists).map((/** @type {any} */ f) => f.path));
    replace(els.tabs, files.map((/** @type {any} */ f, /** @type {number} */ i) => h('button', {
      type: 'button', role: 'tab', class: `tab${i === activeTab ? ' active' : ''}`, 'aria-selected': String(i === activeTab),
      title: f.path, onClick: () => { activeTab = i; renderPreview(); },
    }, `${f.className}.java`, existing.has(f.path) ? h('span', { class: 'badge outline', title: 'A file with this name already exists' }, ' exists ') : null)));
    replace(els.code, highlight(files[activeTab].content));

    const warnings = preview.warnings || [];
    replace(els.warnings, warnings.length
      ? h('div', { class: 'banner warning' }, h('div', { class: 'grow' }, h('strong', null, 'Heads up'), h('ul', { class: 'warnings' }, warnings.map((/** @type {string} */ w) => h('li', null, w)))))
      : null);
  }

  const JAVA_TOKENS = /(\/\*[\s\S]*?\*\/|\/\/[^\n]*)|("(?:\\.|[^"\\])*")|(@[A-Za-z]\w*)|\b(package|import|public|private|protected|class|interface|extends|implements|return|new|this|void|static|final|if|boolean|int|long|true|false|null|instanceof|enum)\b/g;

  /** @param {string} src */
  function highlight(src) {
    const out = [];
    let last = 0;
    for (const m of src.matchAll(JAVA_TOKENS)) {
      const i = /** @type {number} */ (m.index);
      if (i > last) {
        out.push(src.substring(last, i));
      }
      const cls = m[1] ? 'cm' : m[2] ? 'st' : m[3] ? 'an' : 'kw';
      out.push(h('span', { class: cls }, m[0]));
      last = i + m[0].length;
    }
    out.push(src.substring(last));
    return out;
  }

  function renderErrors() {
    for (const key of ['sourceRoot', 'entityPackage', 'repositoryPackage']) {
      const err = document.getElementById(`err-${key}`);
      const input = key === 'sourceRoot' ? els.root : els[`opt_${key}`];
      const msg = errors[key];
      if (!err) {
        continue;
      }
      replace(err, msg || '');
      err.classList.toggle('hidden', !msg);
      input?.classList.toggle('invalid', !!msg);
      if (msg) {
        input?.setAttribute('aria-invalid', 'true');
      } else {
        input?.removeAttribute('aria-invalid');
      }
    }
  }

  /** @param {string} [failure] */
  function renderFooter(failure) {
    const files = preview?.files || [];
    const existing = files.filter((/** @type {any} */ f) => f.exists).length;
    const hasErrors = Object.keys(errors).length > 0;
    els.generate.disabled = generating || selected.size === 0 || hasErrors || !files.length;
    replace(els.generate, generating ? 'Generating…' : files.length ? `Generate ${files.length} File${files.length === 1 ? '' : 's'}` : 'Generate');

    let cls = 'status';
    /** @type {any[]} */
    let content;
    if (failure) {
      cls += ' fail';
      content = [h('span', { class: 'icon' }, '✕'), h('span', { class: 'text' }, failure)];
    } else if (generating) {
      content = [h('span', { class: 'spinner' }), h('span', { class: 'text' }, 'Writing files…')];
    } else if (selected.size === 0) {
      content = [h('span', { class: 'text' }, 'Select the tables to generate entities for.')];
    } else if (hasErrors) {
      cls += ' fail';
      content = [h('span', { class: 'text' }, 'Fix the highlighted options to continue.')];
    } else {
      const entities = files.filter((/** @type {any} */ f) => f.kind === 'entity').length;
      const repos = files.filter((/** @type {any} */ f) => f.kind === 'repository').length;
      const parts = [`${entities} entit${entities === 1 ? 'y' : 'ies'}`];
      if (repos) {
        parts.push(`${repos} repositor${repos === 1 ? 'y' : 'ies'}`);
      }
      const ids = files.length - entities - repos;
      if (ids) {
        parts.push(`${ids} ID class${ids === 1 ? '' : 'es'}`);
      }
      content = [h('span', { class: 'text' }, parts.join(', ') + (existing ? ` · ${existing} already exist${existing === 1 ? 's' : ''}` : ''))];
    }
    els.status.className = cls;
    replace(els.status, content);
  }

  function generate() {
    if (els.generate.disabled) {
      return;
    }
    generating = true;
    replace(els.success);
    renderFooter();
    vscode.postMessage({ type: 'generate', tables: [...selected], options });
  }

  /** @param {any} m */
  function renderSuccess(m) {
    const n = m.written.length;
    const shown = m.written.slice(0, 8);
    /** @param {string} p */
    const rel = p => p.startsWith(m.root) ? p.substring(m.root.length + 1).replace(/\\/g, '/') : p;
    const parts = [`${n - m.overwritten} created`];
    if (m.overwritten) {
      parts.push(`${m.overwritten} overwritten`);
    }
    if (m.skipped) {
      parts.push(`${m.skipped} skipped`);
    }
    replace(els.success, h('div', { class: 'banner success', role: 'status' },
      h('div', { class: 'grow' },
        h('strong', null, `Generated ${n} file${n === 1 ? '' : 's'}`), ` (${parts.join(', ')})`,
        h('ul', { class: 'file-list' }, shown.map((/** @type {string} */ p) => h('li', null,
          h('button', { type: 'button', class: 'link', onClick: () => vscode.postMessage({ type: 'openFile', path: p }) }, rel(p))))),
        n > shown.length ? h('div', { class: 'hint' }, `…and ${n - shown.length} more`) : null,
      ),
      h('button', { type: 'button', class: 'link', 'aria-label': 'Dismiss', onClick: () => replace(els.success) }, 'Dismiss'),
    ));
    renderFooter();
  }

  vscode.postMessage({ type: 'ready' });
})();
