// @ts-check
(function () {
  // @ts-ignore
  const { vscode, h, replace, debounce } = window.ui;
  const app = /** @type {HTMLElement} */ (document.getElementById('app'));

  /** @type {any[]} */
  let dialects = [];
  let mode = 'create';
  let hasSavedPassword = false;
  let draft = {
    kind: 'postgresql', name: '', host: 'localhost', port: 5432, database: '', user: '', ssl: false,
    savePassword: true, jdbcUrl: '', driverJars: /** @type {string[]} */ ([]), driverClass: '', useOwnDriver: false,
  };
  let password = '';
  let passwordTouched = false;
  /** @type {null | 'test' | 'save'} */
  let busy = null;
  /** @type {any[]} */
  let springSources = [];
  /** @type {Record<string, any>} */
  const els = {};

  const dialect = () => dialects.find(d => d.kind === draft.kind) || dialects[0];

  window.addEventListener('message', event => {
    const m = event.data;
    switch (m.type) {
      case 'init':
        dialects = m.dialects;
        mode = m.mode;
        hasSavedPassword = m.hasSavedPassword;
        draft = { ...draft, ...m.draft };
        draft.useOwnDriver = draft.driverJars.length > 0;
        if (!m.draft.port && !m.draft.kind) {
          draft.port = dialect().defaultPort;
        }
        password = m.password || '';
        passwordTouched = !!m.password;
        render();
        break;
      case 'springSources':
        springSources = m.sources || [];
        renderSpring();
        break;
      case 'urlParsed':
        if (m.url === els.url.value) {
          applyParsedUrl(m.parsed, m.url);
        }
        break;
      case 'urlBuilt':
        if (document.activeElement !== els.url && dialect().target !== 'url') {
          els.url.value = m.url;
        }
        break;
      case 'browsed':
        if (m.purpose === 'databaseFile') {
          draft.database = m.paths[0];
          els.database.value = draft.database;
          changed('database');
        } else {
          draft.driverJars = [...new Set([...draft.driverJars, ...m.paths])];
          draft.useOwnDriver = true;
          renderDriver();
          changed('driverJars');
        }
        break;
      case 'busy':
        setBusy(m.action);
        break;
      case 'testResult':
        setBusy(null);
        setStatus(m.ok ? 'ok' : 'fail', m.message);
        break;
      case 'validation':
        setBusy(null);
        showErrors(m.errors);
        break;
    }
  });

  // ------------------------------------------------------------------ rendering

  /** @param {string} id @param {string} label @param {HTMLElement} control @param {{hint?: string, optional?: boolean, cls?: string}} [opts] */
  function field(id, label, control, opts = {}) {
    const hint = h('p', { class: 'hint', id: `hint-${id}` }, opts.hint || '');
    if (!opts.hint) {
      hint.classList.add('hidden');
    }
    const wrap = h('div', { class: `field ${opts.cls || ''}`, id: `field-${id}` },
      h('label', { for: id, id: `label-${id}` }, label, opts.optional ? h('span', { class: 'optional' }, ' (optional)') : null),
      control,
      hint,
      h('p', { class: 'error-text hidden', id: `err-${id}`, role: 'alert' }),
    );
    els[`field_${id}`] = wrap;
    return wrap;
  }

  /** @param {string} id @param {Record<string, any>} props */
  function input(id, props) {
    const el = /** @type {HTMLInputElement} */ (h('input', { id, type: 'text', spellcheck: 'false', autocomplete: 'off', ...props }));
    els[id] = el;
    return el;
  }

  function render() {
    const kindChips = h('div', { class: 'chips', role: 'radiogroup', 'aria-label': 'Database type' });
    const native = dialects.filter(d => d.driver === 'native');
    const jdbc = dialects.filter(d => d.driver === 'jdbc');
    kindChips.append(
      ...native.map(chip),
      h('p', { class: 'chip-group-label' }, 'Via JDBC (needs Java 11+)'),
      ...jdbc.map(chip),
    );
    els.chips = kindChips;

    const form = h('form', { novalidate: true, onSubmit: (/** @type {Event} */ e) => { e.preventDefault(); submit('save'); } },
      h('div', { id: 'spring', class: 'hidden' }),
      h('div', { class: 'field' },
        h('span', { class: 'label', id: 'kind-label' }, 'Database type'),
        kindChips,
        h('p', { class: 'hint', id: 'kind-hint' }),
      ),

      field('url', 'JDBC URL', input('url', { placeholder: 'jdbc:postgresql://localhost:5432/mydb', onInput: onUrlInput })),

      h('div', { class: 'row', id: 'server-row' },
        field('host', 'Host', input('host', { placeholder: 'localhost', onInput: () => set('host', els.host.value) }), { cls: 'grow' }),
        field('port', 'Port', input('port', { type: 'number', min: 1, max: 65535, onInput: () => set('port', Number(els.port.value)) }), { cls: 'small' }),
      ),
      field('database', 'Database', h('div', { class: 'input-group' },
        input('database', { onInput: () => set('database', els.database.value) }),
        els.browseDb = h('button', { type: 'button', class: 'secondary', onClick: () => vscode.postMessage({ type: 'browse', purpose: 'databaseFile' }) }, 'Browse…'),
      )),

      h('div', { class: 'row', id: 'cred-row' },
        field('user', 'User', input('user', { onInput: () => set('user', els.user.value), autocomplete: 'username' })),
        field('password', 'Password', h('div', { class: 'input-group' },
          input('password', { type: 'password', autocomplete: 'new-password', onInput: onPasswordInput }),
          els.reveal = h('button', { type: 'button', class: 'secondary', 'aria-label': 'Show password', onClick: togglePassword }, 'Show'),
        )),
      ),
      els.saveRow = h('label', { class: 'check' },
        els.savePassword = h('input', { type: 'checkbox', onChange: () => { set('savePassword', els.savePassword.checked); updatePasswordHint(); } }),
        h('span', null, 'Save password', h('span', { class: 'hint', id: 'save-hint' })),
      ),
      els.sslRow = h('label', { class: 'check' },
        els.ssl = h('input', { type: 'checkbox', onChange: () => set('ssl', els.ssl.checked) }),
        h('span', null, 'Use SSL/TLS', h('span', { class: 'hint' }, 'Encrypts the connection. The server certificate is not verified (fine for dev databases).')),
      ),

      els.driverSection = h('div', { id: 'driver' }),

      h('h2', null, 'Display'),
      field('name', 'Connection name', input('name', { onInput: () => set('name', els.name.value) }), { optional: true }),
    );

    const page = h('main', { class: 'page' },
      h('header', { class: 'page-header' },
        h('h1', null, mode === 'edit' ? 'Edit connection' : 'New connection'),
        h('p', { class: 'subtitle' }, 'Connect to a database to browse its schema and generate JPA entities.'),
      ),
      form,
    );

    els.status = h('div', { class: 'status', role: 'status', 'aria-live': 'polite' });
    els.cancel = h('button', { type: 'button', class: 'secondary', onClick: () => vscode.postMessage({ type: 'cancel' }) }, 'Cancel');
    els.test = h('button', { type: 'button', class: 'secondary', onClick: () => submit('test') }, 'Test Connection');
    els.save = h('button', { type: 'button', onClick: () => submit('save') }, mode === 'edit' ? 'Save Changes' : 'Save Connection');
    const footer = h('footer', { class: 'actions' }, h('div', { class: 'inner' }, els.status, els.cancel, els.test, els.save));

    replace(app, page, footer);
    app.removeAttribute('aria-busy');

    // Values
    els.host.value = draft.host;
    els.port.value = draft.port ? String(draft.port) : '';
    els.database.value = draft.database;
    els.user.value = draft.user;
    els.password.value = password;
    els.name.value = draft.name;
    els.savePassword.checked = draft.savePassword;
    els.ssl.checked = draft.ssl;
    els.url.value = draft.jdbcUrl;

    updateKind();
    renderSpring();
    updatePasswordHint();
    if (dialect().target === 'server') {
      requestBuildUrl();
    }
    (mode === 'edit' ? els.name : els.url).focus();
  }

  /** @param {any} d */
  function chip(d) {
    const radio = h('input', { type: 'radio', name: 'kind', value: d.kind, checked: d.kind === draft.kind, onChange: () => setKind(d.kind) });
    return h('label', { class: `chip${d.kind === draft.kind ? ' selected' : ''}`, dataset: { kind: d.kind } }, radio, d.label);
  }

  function renderSpring() {
    const box = document.getElementById('spring');
    if (!box) {
      return;
    }
    if (mode !== 'create' || springSources.length === 0) {
      box.className = 'hidden';
      return;
    }
    box.className = 'banner';
    /** @param {any} s */
    const label = s => `${s.file}${s.profile ? ` (${s.profile})` : ''}`;
    let selected = 0;
    const detail = h('code');
    const updateDetail = () => replace(detail, springSources[selected].url);
    const picker = springSources.length > 1
      ? h('select', { 'aria-label': 'Datasource', onChange: (/** @type {any} */ e) => { selected = Number(e.target.value); updateDetail(); } },
        springSources.map((s, i) => h('option', { value: String(i) }, label(s))))
      : null;
    replace(box,
      h('div', { class: 'grow' },
        h('strong', null, springSources.length > 1 ? `Found ${springSources.length} Spring datasources` : `Found a Spring datasource in ${label(springSources[0])}`),
        h('div', null, picker),
        h('div', null, detail),
      ),
      h('button', { type: 'button', class: 'secondary', onClick: () => useSpring(springSources[selected]) }, 'Use It'),
    );
    updateDetail();
  }

  /** @param {any} s */
  function useSpring(s) {
    applyParsedUrl(s, s.url);
    els.url.value = s.url;
    if (s.user !== undefined && s.user !== null) {
      draft.user = s.user;
      els.user.value = s.user;
    }
    if (s.password) {
      password = s.password;
      passwordTouched = true;
      els.password.value = s.password;
    }
    setStatus('ok', 'Filled in from the Spring configuration. Test the connection to make sure it works.');
  }

  function renderDriver() {
    const d = dialect();
    const box = els.driverSection;
    if (d.driver !== 'jdbc') {
      replace(box);
      return;
    }
    const jarList = h('ul', { class: 'file-list' }, draft.driverJars.map(j =>
      h('li', null, h('code', null, j), h('button', {
        type: 'button', class: 'link', 'aria-label': `Remove ${j}`,
        onClick: () => { draft.driverJars = draft.driverJars.filter(x => x !== j); renderDriver(); },
      }, 'Remove'))));
    const chooseJars = h('button', { type: 'button', class: 'secondary', onClick: () => vscode.postMessage({ type: 'browse', purpose: 'driverJars' }) },
      draft.driverJars.length ? 'Add Jar…' : 'Choose Jar…');
    const artifacts = d.jdbcArtifacts || [];

    if (artifacts.length) {
      const coords = artifacts.map((/** @type {any} */ a) => `${a.group}:${a.artifact}:${a.version}`).join(', ');
      replace(box,
        h('h2', null, 'JDBC driver'),
        h('label', { class: 'check' },
          h('input', { type: 'radio', name: 'driverMode', checked: !draft.useOwnDriver, onChange: () => { draft.useOwnDriver = false; renderDriver(); } }),
          h('span', null, 'Download automatically', h('span', { class: 'hint' }, `${coords} from Maven Central, on first connect`)),
        ),
        h('label', { class: 'check' },
          h('input', { type: 'radio', name: 'driverMode', checked: draft.useOwnDriver, onChange: () => { draft.useOwnDriver = true; renderDriver(); } }),
          h('span', null, 'Use my own driver jar(s)'),
        ),
        draft.useOwnDriver ? h('div', { class: 'field', style: undefined }, jarList, h('div', null, chooseJars), h('p', { class: 'error-text hidden', id: 'err-driverJars' })) : null,
      );
    } else {
      replace(box,
        h('h2', null, 'JDBC driver'),
        h('div', { class: 'field' },
          h('span', { class: 'label' }, 'Driver jar(s)'),
          jarList,
          h('div', null, chooseJars),
          h('p', { class: 'hint' }, 'The jar must contain a java.sql.Driver for your JDBC URL.'),
          h('p', { class: 'error-text hidden', id: 'err-driverJars', role: 'alert' }),
        ),
        field('driverClass', 'Driver class', input('driverClass', {
          placeholder: 'Detected automatically when the jar registers itself',
          onInput: () => { draft.driverClass = els.driverClass.value; },
        }), { optional: true }),
      );
      els.driverClass.value = draft.driverClass;
    }
  }

  function updateKind() {
    const d = dialect();
    els.chips.querySelectorAll('.chip').forEach((/** @type {HTMLElement} */ c) => {
      const on = c.dataset.kind === draft.kind;
      c.classList.toggle('selected', on);
      /** @type {HTMLInputElement} */ (c.querySelector('input')).checked = on;
    });
    const server = d.target === 'server';
    const file = d.target === 'file';
    els.field_host.parentElement.classList.toggle('hidden', !server);
    els.field_database.classList.toggle('hidden', d.target === 'url');
    els.sslRow.classList.toggle('hidden', !server);
    els.browseDb.classList.toggle('hidden', !file);
    // File databases (SQLite) have no authentication.
    document.getElementById('cred-row')?.classList.toggle('hidden', file);
    els.saveRow.classList.toggle('hidden', file);
    updatePortState();

    replace(document.getElementById('label-database'), d.databaseLabel,
      server && !d.databaseRequired ? h('span', { class: 'optional' }, ' (optional)') : null);
    const dbHint = document.getElementById('hint-database');
    replace(dbHint, d.databaseHint || (file ? 'Path to the database file' : ''));
    dbHint.classList.toggle('hidden', !d.databaseHint && !file);
    els.database.placeholder = file ? '/path/to/app.db' : d.kind === 'oracle' ? 'FREEPDB1' : d.kind === 'postgresql' ? 'postgres' : '';

    const urlLabel = document.getElementById('label-url');
    const urlHint = document.getElementById('hint-url');
    if (d.target === 'url') {
      replace(urlLabel, 'JDBC URL');
      replace(urlHint, examples[d.kind] ? `For example ${examples[d.kind]}` : 'The full JDBC URL of the database.');
    } else {
      replace(urlLabel, 'JDBC URL', h('span', { class: 'optional' }, ' (optional)'));
      replace(urlHint, file ? 'Built from the file path.' : 'Paste a JDBC URL to fill in the fields below.');
    }
    urlHint.classList.remove('hidden');
    els.url.readOnly = file;
    els.url.placeholder = examples[d.kind] || 'jdbc:…';
    els.user.placeholder = d.defaultUser || '';

    replace(document.getElementById('kind-hint'), d.driver === 'native'
      ? 'Built-in driver, nothing to install.'
      : d.jdbcArtifacts ? 'Connects through JDBC. Needs Java 11+; the driver is downloaded on first connect.'
        : 'Any database with a JDBC driver. Needs Java 11+ and the driver jar.');
    renderDriver();
    updateNamePlaceholder();
  }

  /** @type {Record<string, string>} */
  const examples = {
    postgresql: 'jdbc:postgresql://localhost:5432/mydb',
    mysql: 'jdbc:mysql://localhost:3306/mydb',
    mariadb: 'jdbc:mariadb://localhost:3306/mydb',
    sqlserver: 'jdbc:sqlserver://localhost:1433;databaseName=mydb',
    oracle: 'jdbc:oracle:thin:@//localhost:1521/FREEPDB1',
    db2: 'jdbc:db2://localhost:50000/MYDB',
    h2: 'jdbc:h2:tcp://localhost:9092/~/test',
    hsqldb: 'jdbc:hsqldb:hsql://localhost:9001/mydb',
    derby: 'jdbc:derby://localhost:1527/mydb',
    sqlite: 'jdbc:sqlite:/path/to/app.db',
    firebird: 'jdbc:firebirdsql://localhost:3050/employee',
    jdbc: 'jdbc:vendor://host:port/database',
  };

  function updateNamePlaceholder() {
    const d = dialect();
    let name;
    if (d.target === 'file') {
      name = draft.database.replace(/^.*[\\/]/, '') || d.label;
    } else if (d.target === 'url') {
      const tail = (draft.jdbcUrl || '').replace(/^jdbc:[a-z0-9][a-z0-9-]*:(\/\/)?/i, '').replace(/[;?].*$/, '').replace(/^.*[\\/]/, '');
      name = tail ? `${d.label} ${tail}` : d.label;
    } else {
      const db = draft.database && !draft.database.startsWith('(') ? draft.database : '';
      name = db ? `${db}@${draft.host}` : draft.host || d.label;
    }
    els.name.placeholder = name;
  }

  function updatePasswordHint() {
    const hint = document.getElementById('save-hint');
    if (!hint) {
      return;
    }
    replace(hint, draft.savePassword
      ? 'Stored in VS Code Secret Storage (your OS keychain), never in settings.'
      : 'You will be asked for the password when connecting.');
    els.password.placeholder = hasSavedPassword && !passwordTouched ? 'Saved. Leave empty to keep it' : '';
  }

  // ------------------------------------------------------------------ behaviour

  /** @param {string} kind @param {boolean} [fromUrl] */
  function setKind(kind, fromUrl) {
    const before = dialect();
    if (kind === draft.kind) {
      return;
    }
    draft.kind = kind;
    const after = dialect();
    if (!fromUrl && (!draft.port || draft.port === before.defaultPort)) {
      draft.port = after.defaultPort;
      els.port.value = after.defaultPort ? String(after.defaultPort) : '';
    }
    if (after.target === 'url' && before.target !== 'url' && !fromUrl) {
      els.url.value = draft.jdbcUrl;
    }
    updateKind();
    clearErrors();
    setStatus(null, '');
    requestBuildUrl();
  }

  /** SQL Server named instances (host\INSTANCE) are resolved by the browser service; the port is ignored. */
  function updatePortState() {
    const named = draft.kind === 'sqlserver' && draft.host.includes('\\');
    els.port.disabled = named;
    els.port.title = named ? 'Named instances are located through SQL Server Browser; the port is not used.' : '';
  }

  /** @param {string} key @param {any} value */
  function set(key, value) {
    // @ts-ignore
    draft[key] = value;
    changed(key);
  }

  /** @param {string} key */
  function changed(key) {
    clearError(key);
    updateNamePlaceholder();
    if (key === 'host') {
      updatePortState();
    }
    if (['host', 'port', 'database', 'ssl', 'kind'].includes(key)) {
      requestBuildUrl();
    }
  }

  const requestBuildUrl = debounce(() => {
    const d = dialect();
    if (d.target === 'url') {
      return;
    }
    vscode.postMessage({ type: 'buildUrl', draft: payloadDraft() });
  }, 150);

  const parseUrlSoon = debounce(() => vscode.postMessage({ type: 'parseUrl', url: els.url.value }), 200);

  function onUrlInput() {
    clearError('url');
    if (dialect().target === 'url') {
      draft.jdbcUrl = els.url.value;
      updateNamePlaceholder();
    }
    if (els.url.value.trim()) {
      parseUrlSoon();
    }
  }

  /** @param {any} p @param {string} url */
  function applyParsedUrl(p, url) {
    if (!p) {
      if (dialect().target !== 'url') {
        showErrors({ url: 'This does not look like a supported JDBC URL.' });
      }
      return;
    }
    if (p.kind !== draft.kind) {
      setKind(p.kind, true);
    }
    const d = dialect();
    if (d.target === 'url') {
      draft.jdbcUrl = p.jdbcUrl || url;
    } else if (d.target === 'file') {
      draft.database = p.database;
      els.database.value = draft.database;
    } else {
      draft.host = p.host;
      draft.port = p.port;
      draft.database = p.database;
      draft.ssl = p.ssl;
      els.host.value = p.host;
      els.port.value = String(p.port);
      els.database.value = p.database;
      els.ssl.checked = p.ssl;
    }
    if (p.user) {
      draft.user = p.user;
      els.user.value = p.user;
    }
    if (p.password) {
      password = p.password;
      passwordTouched = true;
      els.password.value = p.password;
    }
    clearErrors();
    updateNamePlaceholder();
    updatePortState();
  }

  function onPasswordInput() {
    password = els.password.value;
    passwordTouched = true;
    clearError('password');
  }

  function togglePassword() {
    const show = els.password.type === 'password';
    els.password.type = show ? 'text' : 'password';
    replace(els.reveal, show ? 'Hide' : 'Show');
    els.reveal.setAttribute('aria-label', show ? 'Hide password' : 'Show password');
  }

  function payloadDraft() {
    const { useOwnDriver, ...rest } = draft;
    return { ...rest, driverJars: useOwnDriver || draft.kind === 'jdbc' ? draft.driverJars : [], port: Number(draft.port) || 0 };
  }

  /** @param {'test' | 'save'} type */
  function submit(type) {
    if (busy) {
      return;
    }
    if (dialect().target === 'url') {
      draft.jdbcUrl = els.url.value.trim();
    }
    clearErrors();
    setStatus(null, '');
    if (type === 'save') {
      setBusy('save');
    }
    vscode.postMessage({ type, draft: payloadDraft(), password, passwordTouched });
  }

  /** @param {null | 'test' | 'save'} action */
  function setBusy(action) {
    busy = action;
    for (const b of [els.test, els.save]) {
      b.disabled = !!action;
    }
    if (action === 'test') {
      setStatus('busy', 'Testing connection…');
    }
  }

  /** @param {null | 'ok' | 'fail' | 'busy'} kind @param {string} text */
  function setStatus(kind, text) {
    els.status.className = `status ${kind === 'ok' ? 'ok' : kind === 'fail' ? 'fail' : ''}`;
    const icon = kind === 'busy' ? h('span', { class: 'spinner' }) : kind === 'ok' ? h('span', { class: 'icon' }, '✓') : kind === 'fail' ? h('span', { class: 'icon' }, '✕') : null;
    replace(els.status, icon, h('span', { class: 'text', title: text }, text));
  }

  /** @param {Record<string, string>} errors */
  function showErrors(errors) {
    let first = null;
    for (const [key, msg] of Object.entries(errors)) {
      const err = document.getElementById(`err-${key}`);
      if (err) {
        replace(err, msg);
        err.classList.remove('hidden');
      }
      if (els[key] instanceof HTMLElement) {
        els[key].classList.add('invalid');
        els[key].setAttribute('aria-invalid', 'true');
        first = first || els[key];
      }
    }
    if (Object.keys(errors).length) {
      setStatus('fail', 'Please fix the highlighted fields.');
      (first || els.save).focus();
    }
  }

  /** @param {string} key */
  function clearError(key) {
    const err = document.getElementById(`err-${key}`);
    err?.classList.add('hidden');
    if (els[key] instanceof HTMLElement) {
      els[key].classList.remove('invalid');
      els[key].removeAttribute('aria-invalid');
    }
  }

  function clearErrors() {
    document.querySelectorAll('.error-text').forEach(e => e.classList.add('hidden'));
    document.querySelectorAll('.invalid').forEach(e => { e.classList.remove('invalid'); e.removeAttribute('aria-invalid'); });
  }

  vscode.postMessage({ type: 'ready' });
})();
