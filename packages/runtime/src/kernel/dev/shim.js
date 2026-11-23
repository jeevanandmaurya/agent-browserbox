// BrowserBox dev runtime. Injected as the first script of every page Preview
// serves from a dev server. The page runs in an opaque-origin frame, so this
// connects it to the virtual server through its parent:
//  - fetch() and XMLHttpRequest to the page's own address are answered by the
//    dev server (project files or the project's backend);
//  - console output, errors and failed loads are reported (the agent reads them);
//  - links to other pages of the site navigate inside Preview;
//  - project images created at run time (e.g. by React) are loaded from the project.
/* eslint-disable */
(function () {
  var cfg = window.__bbxDev || { port: 3000, path: '/', errors: [] };
  var ORIGIN = 'http://localhost:' + cfg.port;
  var P = window.parent;
  var seq = 0;
  var waits = {};
  var nativeFetch = window.fetch.bind(window);

  function post(m) {
    try { P.postMessage(m, '*'); } catch (e) {}
  }
  addEventListener('message', function (e) {
    if (e.source !== P || !e.data || e.data.type !== 'bbx-dev:res') return;
    var w = waits[e.data.id];
    if (!w) return;
    delete waits[e.data.id];
    if (e.data.error) w[1](new TypeError(e.data.error));
    else w[0](e.data.res);
  });
  function ask(req) {
    return new Promise(function (ok, no) {
      var id = ++seq;
      waits[id] = [ok, no];
      post({ type: 'bbx-dev:req', id: id, req: req });
    });
  }

  // The frame's own host: a Request built from a relative URL resolves against it.
  var FRAME_HOST = new URL(location.href).origin;
  // Where the page thinks it is; client-side routers read location.pathname.
  try { history.replaceState(history.state, '', cfg.path); } catch (e) {}
  function pagePath() {
    return /\/preview\/frame\.html$/.test(location.pathname) ? cfg.path : location.pathname + location.search;
  }
  /** The virtual URL for a reference, or null when it points elsewhere. */
  function virtual(ref) {
    var s = String(ref);
    if (/^(blob|data|about|javascript|mailto|tel):/i.test(s)) return null;
    var u;
    try { u = new URL(s, ORIGIN + pagePath()); } catch (e) { return null; }
    if (u.origin === FRAME_HOST) u = new URL(u.pathname.replace(/^\/preview\//, '/') + u.search + u.hash, ORIGIN);
    return u.origin === ORIGIN ? u : null;
  }

  // ---- console and errors ----------------------------------------------------
  function show(v) {
    if (typeof v === 'string') return v;
    if (v instanceof Error) return v.stack || String(v);
    if (v instanceof Node) return '<' + (v.nodeName || 'node').toLowerCase() + '>';
    try {
      var s = JSON.stringify(v, function (k, x) { return typeof x === 'bigint' ? x + 'n' : typeof x === 'function' ? '[function]' : x; });
      return s === undefined ? String(v) : s.length > 2000 ? s.slice(0, 2000) + '…' : s;
    } catch (e) {
      return String(v);
    }
  }
  function log(level, source, text) {
    post({ type: 'bbx-dev:log', entry: { level: level, source: source, text: String(text).slice(0, 8000) } });
  }
  ['log', 'info', 'warn', 'error', 'debug'].forEach(function (level) {
    var orig = console[level];
    console[level] = function () {
      var args = [].slice.call(arguments);
      log(level, 'page', args.map(show).join(' '));
      return orig.apply(console, arguments);
    };
  });
  addEventListener('error', function (e) {
    var t = e.target;
    if (t && t !== window && t.tagName) {
      var ref = t.getAttribute('src') || t.getAttribute('href') || '';
      if (virtual(ref) && !t.dataset.bbxTried) return; // loaded from the project below
      log('error', 'network', 'failed to load ' + t.tagName.toLowerCase() + ' ' + ref);
      return;
    }
    log('error', 'page', (e.error && e.error.stack) || e.message + (e.filename ? ' (' + e.lineno + ':' + e.colno + ')' : ''));
  }, true);
  addEventListener('unhandledrejection', function (e) {
    log('error', 'page', 'Unhandled promise rejection: ' + show(e.reason));
  });

  // ---- requests --------------------------------------------------------------
  function toResponse(r) {
    var nobody = r.status === 204 || r.status === 304 || r.status < 200;
    return new Response(nobody ? null : r.body, { status: r.status, statusText: r.statusText || '', headers: r.headers });
  }
  window.fetch = function (input, init) {
    var ref = input instanceof Request ? input.url : input;
    var u = virtual(ref);
    if (!u) return nativeFetch(input, init);
    var req = new Request(u.href, input instanceof Request ? input : init);
    if (init && input instanceof Request) req = new Request(req, init);
    return req.arrayBuffer().then(function (buf) {
      var headers = [];
      req.headers.forEach(function (v, k) { headers.push([k, v]); });
      return ask({ method: req.method, url: u.pathname + u.search, headers: headers, body: buf.byteLength ? new Uint8Array(buf) : null });
    }).then(toResponse);
  };

  // XMLHttpRequest on top of fetch, for libraries that still use it (axios).
  var NativeXHR = window.XMLHttpRequest;
  function XHR() {
    this.readyState = 0; this.status = 0; this.statusText = ''; this.response = null; this.responseText = '';
    this.responseType = ''; this.responseURL = ''; this.timeout = 0; this.withCredentials = false;
    this._h = {}; this._l = {}; this._resH = null; this.upload = { addEventListener: function () {}, removeEventListener: function () {} };
  }
  XHR.UNSENT = 0; XHR.OPENED = 1; XHR.HEADERS_RECEIVED = 2; XHR.LOADING = 3; XHR.DONE = 4;
  XHR.prototype.open = function (method, url) { this._m = method; this._u = url; this._set(1); };
  XHR.prototype.setRequestHeader = function (k, v) { this._h[k] = v; };
  XHR.prototype.getResponseHeader = function (k) { return this._resH ? this._resH.get(k) : null; };
  XHR.prototype.getAllResponseHeaders = function () {
    var s = '';
    if (this._resH) this._resH.forEach(function (v, k) { s += k + ': ' + v + '\r\n'; });
    return s;
  };
  XHR.prototype.overrideMimeType = function () {};
  XHR.prototype.addEventListener = function (t, fn) { (this._l[t] = this._l[t] || []).push(fn); };
  XHR.prototype.removeEventListener = function (t, fn) { this._l[t] = (this._l[t] || []).filter(function (f) { return f !== fn; }); };
  XHR.prototype._fire = function (t) {
    var ev = { type: t, target: this, currentTarget: this, lengthComputable: false, loaded: 0, total: 0 };
    if (typeof this['on' + t] === 'function') this['on' + t](ev);
    (this._l[t] || []).slice().forEach(function (f) { f.call(this, ev); }, this);
  };
  XHR.prototype._set = function (s) { this.readyState = s; this._fire('readystatechange'); };
  XHR.prototype.abort = function () { this._aborted = true; if (this._ctl) this._ctl.abort(); this._fire('abort'); this._fire('loadend'); };
  XHR.prototype.send = function (body) {
    var self = this;
    this._ctl = new AbortController();
    this._fire('loadstart');
    window.fetch(this._u, { method: this._m, headers: this._h, body: body == null ? undefined : body, signal: this._ctl.signal })
      .then(function (res) {
        self.status = res.status; self.statusText = res.statusText; self.responseURL = res.url || String(self._u); self._resH = res.headers;
        self._set(2);
        return self.responseType === 'arraybuffer' ? res.arrayBuffer() : self.responseType === 'blob' ? res.blob() : res.text();
      })
      .then(function (data) {
        if (self._aborted) return;
        if (typeof data === 'string') {
          self.responseText = data;
          if (self.responseType === 'json') { try { self.response = JSON.parse(data); } catch (e) { self.response = null; } }
          else self.response = data;
        } else self.response = data;
        self._set(3); self._set(4);
        self._fire('load'); self._fire('loadend');
      })
      .catch(function () {
        if (self._aborted) return;
        self._set(4); self._fire('error'); self._fire('loadend');
      });
  };
  window.XMLHttpRequest = function () {
    return new XHR();
  };
  window.XMLHttpRequest.prototype = XHR.prototype;
  window.XMLHttpRequest.DONE = 4;
  window.__bbxNativeXHR = NativeXHR;

  // ---- project images and media created at run time ------------------------------
  var MEDIA = { IMG: 'src', SOURCE: 'src', VIDEO: 'src', AUDIO: 'src', TRACK: 'src' };
  function adopt(el) {
    var attr = MEDIA[el.tagName];
    if (!attr || el.dataset.bbxTried) return;
    var ref = el.getAttribute(attr);
    if (!ref || !virtual(ref)) return;
    el.dataset.bbxTried = '1';
    window.fetch(ref).then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.blob();
    }).then(function (b) {
      el.setAttribute(attr, URL.createObjectURL(b));
    }, function (err) {
      log('error', 'network', 'failed to load ' + el.tagName.toLowerCase() + ' ' + ref + ' (' + err.message + ')');
    });
  }
  function scan(root) {
    if (root.nodeType !== 1) return;
    adopt(root);
    if (root.querySelectorAll) [].forEach.call(root.querySelectorAll('img,source,video,audio,track'), adopt);
  }
  new MutationObserver(function (records) {
    records.forEach(function (r) {
      if (r.type === 'attributes') {
        if (r.target.dataset && r.target.getAttribute(r.attributeName) && !/^blob:/.test(r.target.getAttribute(r.attributeName))) delete r.target.dataset.bbxTried;
        adopt(r.target);
      } else [].forEach.call(r.addedNodes, scan);
    });
  }).observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['src'] });

  // ---- navigation --------------------------------------------------------------
  document.addEventListener('click', function (e) {
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey) return;
    var a = e.target && e.target.closest && e.target.closest('a[href]');
    if (!a || a.target === '_blank' || a.hasAttribute('download')) return;
    var href = a.getAttribute('href');
    if (!href || href.charAt(0) === '#') return;
    var u = virtual(href);
    if (!u) return; // other sites open as the browser decides
    e.preventDefault();
    post({ type: 'bbx-dev:nav', path: u.pathname + u.search + u.hash });
  });

  // Client-side navigation: tell Preview, so its address bar and reloads follow the app.
  ['pushState', 'replaceState'].forEach(function (k) {
    var orig = history[k];
    history[k] = function () {
      var r = orig.apply(history, arguments);
      post({ type: 'bbx-dev:path', path: pagePath() });
      return r;
    };
  });
  addEventListener('popstate', function () { post({ type: 'bbx-dev:path', path: pagePath() }); });
  addEventListener('hashchange', function () { post({ type: 'bbx-dev:path', path: pagePath() + location.hash }); });

  // ---- build errors ------------------------------------------------------------
  if (cfg.errors && cfg.errors.length) {
    var overlay = function () {
      var box = document.createElement('div');
      box.setAttribute('role', 'alert');
      box.style.cssText = 'position:fixed;inset:0;z-index:2147483647;overflow:auto;padding:24px;background:rgba(20,20,20,.94);color:#f3f3f3;font:13px/1.5 ui-monospace,Menlo,monospace;white-space:pre-wrap';
      box.textContent = 'Build failed\n\n' + cfg.errors.join('\n\n');
      (document.body || document.documentElement).appendChild(box);
    };
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', overlay);
    else overlay();
  }
})();
