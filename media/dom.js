// @ts-check
/* Tiny DOM helpers shared by the webviews. Text is always inserted via text nodes, never innerHTML. */
(function () {
  // eslint-disable-next-line no-undef
  const vscode = acquireVsCodeApi();

  /**
   * Creates an element. `props` keys: class, on<Event>, dataset, checked/disabled/value/... (properties),
   * everything else becomes an attribute. Children may be strings, nodes, arrays, or null.
   * @param {string} tag
   * @param {Record<string, any> | null} [props]
   * @param {...any} children
   * @returns {HTMLElement}
   */
  function h(tag, props, ...children) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(props || {})) {
      if (v === undefined || v === null || v === false && !['checked', 'disabled', 'value'].includes(k)) {
        continue;
      }
      if (k === 'class') {
        el.className = v;
      } else if (k.startsWith('on') && typeof v === 'function') {
        el.addEventListener(k.substring(2).toLowerCase(), v);
      } else if (k === 'dataset') {
        Object.assign(el.dataset, v);
      } else if (['checked', 'disabled', 'value', 'selected', 'indeterminate'].includes(k)) {
        // @ts-ignore
        el[k] = v;
      } else {
        el.setAttribute(k, v === true ? '' : String(v));
      }
    }
    append(el, children);
    return el;
  }

  /** @param {Node} el @param {any[]} children */
  function append(el, children) {
    for (const c of children.flat(Infinity)) {
      if (c === null || c === undefined || c === false) {
        continue;
      }
      el.appendChild(c instanceof Node ? c : document.createTextNode(String(c)));
    }
  }

  /** @param {Node} el @param {...any} children */
  function replace(el, ...children) {
    while (el.firstChild) {
      el.removeChild(el.firstChild);
    }
    append(el, children);
  }

  /** @param {Function} fn @param {number} ms */
  function debounce(fn, ms) {
    /** @type {any} */
    let t;
    return (/** @type {any[]} */ ...args) => {
      clearTimeout(t);
      t = setTimeout(() => fn(...args), ms);
    };
  }

  // @ts-ignore
  window.ui = { vscode, h, append, replace, debounce };
})();
