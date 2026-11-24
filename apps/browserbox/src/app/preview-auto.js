// BrowserBox preview automation. Injected first into a page the agent drives
// (the `preview` tool), inside the same sandboxed frame people see: it can only
// touch this page. The window sends commands; this answers them.
/* eslint-disable */
(function () {
  var P = window.parent;
  var logs = [];
  var MAX_LOGS = 300;
  function show(v) {
    try {
      if (v instanceof Error) return v.name + ': ' + v.message;
      if (typeof v === 'string') return v;
      return JSON.stringify(v, null, 0);
    } catch (e) {
      return String(v);
    }
  }
  function keep(level, args) {
    logs.push({ level: level, text: Array.prototype.map.call(args, show).join(' ').slice(0, 2000), at: Date.now() });
    if (logs.length > MAX_LOGS) logs.shift();
  }
  ['log', 'info', 'warn', 'error', 'debug'].forEach(function (level) {
    var original = console[level];
    console[level] = function () {
      keep(level === 'debug' || level === 'info' ? 'log' : level, arguments);
      return original.apply(console, arguments);
    };
  });
  addEventListener('error', function (e) {
    if (e.target && e.target !== window && (e.target.src || e.target.href)) keep('error', ['Failed to load ' + (e.target.src || e.target.href)]);
    else keep('error', [e.message + (e.filename ? ' (' + e.filename.split('/').pop() + ':' + e.lineno + ')' : '')]);
  }, true);
  addEventListener('unhandledrejection', function (e) {
    keep('error', ['Unhandled rejection: ' + show(e.reason)]);
  });

  // ---- reading the page ---------------------------------------------------------------
  var nextRef = 1;
  function refOf(el) {
    if (!el.dataset.bbxRef) el.dataset.bbxRef = String(nextRef++);
    return el.dataset.bbxRef;
  }
  function visible(el) {
    if (el.hidden || el.getAttribute('aria-hidden') === 'true') return false;
    var s = getComputedStyle(el);
    if (s.display === 'none' || s.visibility === 'hidden' || s.opacity === '0') return false;
    return true;
  }
  function clean(t) {
    return String(t || '').replace(/\s+/g, ' ').trim();
  }
  function labelOf(el) {
    var l = el.getAttribute('aria-label') || el.getAttribute('title') || '';
    if (!l && el.id) {
      var lab = document.querySelector('label[for="' + CSS.escape(el.id) + '"]');
      if (lab) l = lab.textContent;
    }
    if (!l && el.closest('label')) l = el.closest('label').textContent;
    if (!l) l = el.getAttribute('placeholder') || el.getAttribute('name') || '';
    return clean(l);
  }
  function interactive(el) {
    var tag = el.tagName;
    if (tag === 'A' && el.hasAttribute('href')) return 'link';
    if (tag === 'BUTTON') return 'button';
    if (tag === 'INPUT') {
      var t = (el.getAttribute('type') || 'text').toLowerCase();
      if (t === 'hidden') return null;
      if (t === 'checkbox' || t === 'radio') return t;
      if (t === 'submit' || t === 'button' || t === 'reset') return 'button';
      return 'textbox';
    }
    if (tag === 'TEXTAREA') return 'textbox';
    if (tag === 'SELECT') return 'select';
    var role = el.getAttribute('role');
    if (role && /^(button|link|checkbox|tab|menuitem|switch|option|slider)$/.test(role)) return role;
    if (el.hasAttribute('onclick') || el.getAttribute('contenteditable') === 'true') return el.getAttribute('contenteditable') === 'true' ? 'textbox' : 'button';
    if (tag === 'CANVAS') return 'canvas';
    return null;
  }
  function describe(el, kind) {
    var ref = refOf(el);
    var name = kind === 'textbox' || kind === 'select' || kind === 'checkbox' || kind === 'radio' ? labelOf(el) : clean(el.innerText || el.value || labelOf(el));
    var line = '[' + ref + '] ' + kind + (name ? ' "' + name.slice(0, 80) + '"' : '');
    if (kind === 'link') line += ' → ' + el.getAttribute('href');
    if (kind === 'textbox') line += ' value="' + String(el.value != null ? el.value : el.textContent).slice(0, 80) + '"';
    if (kind === 'checkbox' || kind === 'radio') line += el.checked ? ' [x]' : ' [ ]';
    if (kind === 'select') line += ' = "' + (el.options[el.selectedIndex] ? clean(el.options[el.selectedIndex].text) : '') + '" of ' + Array.prototype.map.call(el.options, function (o) { return clean(o.text); }).slice(0, 12).join(' | ');
    if (kind === 'canvas') line += ' ' + el.width + '×' + el.height;
    if (el.disabled) line += ' (disabled)';
    return line;
  }
  function snapshot(max, root) {
    var out = ['Page: ' + (document.title || '(no title)')];
    var used = 0;
    var limit = max || 8000;
    function add(s, depth) {
      if (used > limit) return;
      var t = new Array(Math.min(depth, 6) + 1).join('  ') + s;
      out.push(t);
      used += t.length;
    }
    function walk(node, depth) {
      if (used > limit) return;
      if (node.nodeType === 3) {
        var t = clean(node.textContent);
        if (t) add(t.slice(0, 300), depth);
        return;
      }
      if (node.nodeType !== 1) return;
      var el = node;
      if (/^(SCRIPT|STYLE|NOSCRIPT|TEMPLATE|SVG|HEAD)$/.test(el.tagName)) return;
      if (!visible(el)) return;
      var kind = interactive(el);
      if (kind) {
        add(describe(el, kind), depth);
        if (kind !== 'link' && kind !== 'button') return;
        return;
      }
      if (/^H[1-6]$/.test(el.tagName)) return add(new Array(Number(el.tagName[1]) + 1).join('#') + ' ' + clean(el.innerText).slice(0, 200), depth);
      if (el.tagName === 'IMG') return add('image "' + clean(el.alt || el.getAttribute('src') || '') .slice(0, 80) + '"', depth);
      for (var c = el.firstChild; c; c = c.nextSibling) walk(c, depth + (/^(UL|OL|TABLE|FORM|NAV|SECTION|MAIN|DIALOG)$/.test(el.tagName) ? 1 : 0));
    }
    walk(root || document.body || document.documentElement, 0);
    if (used > limit) out.push('… (the page goes on; read less with a selector, or scroll)');
    return out.join('\n');
  }

  // ---- finding and acting --------------------------------------------------------------
  function find(a) {
    var el = null;
    if (a.ref) el = document.querySelector('[data-bbx-ref="' + String(a.ref).replace(/[^0-9]/g, '') + '"]');
    else if (a.selector) el = document.querySelector(a.selector);
    else if (a.text) {
      var want = clean(a.text).toLowerCase();
      var all = document.querySelectorAll('a,button,input,textarea,select,label,[role],[onclick],h1,h2,h3,li,td,span,div,p');
      for (var i = 0; i < all.length && !el; i++) if (visible(all[i]) && clean(all[i].innerText || all[i].value).toLowerCase() === want) el = all[i];
      for (var j = 0; j < all.length && !el; j++) if (visible(all[j]) && clean(all[j].innerText || all[j].value).toLowerCase().indexOf(want) >= 0 && interactive(all[j])) el = all[j];
    }
    if (!el) throw new Error('nothing on the page matches ' + JSON.stringify(a.ref ? '[' + a.ref + ']' : a.selector || a.text) + ' (take a snapshot to see the [numbers])');
    return el;
  }
  function setValue(el, value) {
    var proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : el.tagName === 'SELECT' ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
    var setter = Object.getOwnPropertyDescriptor(proto, 'value');
    // The native setter, so frameworks that track the value (React) see the change.
    if (setter && setter.set) setter.set.call(el, value);
    else el.value = value;
  }
  function fire(el, type, init) {
    var E = /^(key)/.test(type) ? KeyboardEvent : /^(pointer)/.test(type) && window.PointerEvent ? PointerEvent : /^(mouse|click)/.test(type) ? MouseEvent : Event;
    el.dispatchEvent(new E(type, Object.assign({ bubbles: true, cancelable: true, composed: true }, init || {})));
  }
  var actions = {
    snapshot: function (a) {
      var root = a.selector ? document.querySelector(a.selector) : null;
      if (a.selector && !root) throw new Error('nothing matches ' + a.selector);
      return snapshot(a.max, root);
    },
    click: function (a) {
      var el = find(a);
      el.scrollIntoView({ block: 'center' });
      var r = el.getBoundingClientRect();
      var at = { clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 };
      fire(el, 'pointerdown', at);
      fire(el, 'mousedown', at);
      if (el.focus) el.focus();
      fire(el, 'pointerup', at);
      fire(el, 'mouseup', at);
      el.click();
      return 'clicked ' + describe(el, interactive(el) || el.tagName.toLowerCase());
    },
    type: function (a) {
      var el = find(a);
      if (el.focus) el.focus();
      if (el.getAttribute('contenteditable') === 'true') el.textContent = a.clear === false ? el.textContent + a.value : a.value;
      else setValue(el, a.clear === false ? el.value + a.value : String(a.value));
      fire(el, 'input', { data: String(a.value), inputType: 'insertText' });
      fire(el, 'change');
      if (a.submit) actions.press({ key: 'Enter' });
      return 'typed into ' + describe(el, 'textbox');
    },
    select: function (a) {
      var el = find(a);
      if (el.tagName !== 'SELECT') throw new Error('that is not a list to choose from');
      var opt = Array.prototype.find.call(el.options, function (o) { return o.value === a.value || clean(o.text) === clean(a.value); });
      if (!opt) throw new Error('no option ' + JSON.stringify(a.value));
      setValue(el, opt.value);
      fire(el, 'input');
      fire(el, 'change');
      return 'chose ' + clean(opt.text);
    },
    check: function (a) {
      var el = find(a);
      if (el.checked !== !!a.value) el.click();
      return describe(el, interactive(el) || 'checkbox');
    },
    press: function (a) {
      var target = document.activeElement && document.activeElement !== document.body ? document.activeElement : document.body;
      var key = String(a.key || 'Enter');
      var codes = { Enter: 13, Escape: 27, Tab: 9, Backspace: 8, ArrowUp: 38, ArrowDown: 40, ArrowLeft: 37, ArrowRight: 39, ' ': 32 };
      var init = { key: key, code: key.length === 1 ? 'Key' + key.toUpperCase() : key, keyCode: codes[key] || key.toUpperCase().charCodeAt(0), which: codes[key] || 0 };
      fire(target, 'keydown', init);
      if (key.length === 1 || key === 'Enter') fire(target, 'keypress', init);
      // Enter in a form field submits its form, as a browser would.
      if (key === 'Enter' && target.form && target.tagName === 'INPUT') {
        if (target.form.requestSubmit) target.form.requestSubmit();
        else target.form.submit();
      }
      fire(target, 'keyup', init);
      return 'pressed ' + key + ' on ' + (target === document.body ? 'the page' : target.tagName.toLowerCase());
    },
    scroll: function (a) {
      if (a.ref || a.selector || a.text) find(a).scrollIntoView({ block: 'center' });
      else window.scrollBy(0, a.amount || innerHeight * 0.8);
      return 'scrolled';
    },
    eval: function (a) {
      var AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
      var body = /\breturn\b|;|\n/.test(a.code) ? a.code : 'return (' + a.code + ')';
      return new AsyncFunction(body)().then(function (v) {
        return v === undefined ? '(no value)' : show(v);
      });
    },
    console: function (a) {
      var list = logs.splice(0);
      return list.length ? list.map(function (l) { return l.level + ': ' + l.text; }).join('\n') : '(no console output)';
    },
    wait: function (a) {
      var until = Date.now() + Math.min(a.timeout || 5000, 30000);
      return new Promise(function (ok, no) {
        (function check() {
          var done = false;
          try {
            done = a.selector ? !!document.querySelector(a.selector) : a.text ? clean(document.body.innerText).indexOf(clean(a.text)) >= 0 : Date.now() >= until;
          } catch (e) {}
          if (done) return ok(a.selector || a.text ? 'found ' + (a.selector || JSON.stringify(a.text)) : 'waited');
          if (Date.now() >= until) return no(new Error('not found within ' + (a.timeout || 5000) + ' ms: ' + (a.selector || JSON.stringify(a.text))));
          setTimeout(check, 100);
        })();
      });
    },
    screenshot: function () {
      // A sandboxed frame cannot be captured from outside: the page draws itself, through an
      // SVG image of its own DOM (html-to-image; no inner frame, which a sandbox could not read).
      function shoot() {
        var lib = window.htmlToImage;
        var bg = getComputedStyle(document.body).backgroundColor;
        return lib.toPng(document.documentElement, { width: innerWidth, height: innerHeight, backgroundColor: bg && bg !== 'rgba(0, 0, 0, 0)' ? bg : '#ffffff', style: { transform: 'translate(' + -scrollX + 'px,' + -scrollY + 'px)' }, cacheBust: false }).then(function (url) {
          return { image: url, width: innerWidth, height: innerHeight };
        });
      }
      if (window.htmlToImage) return shoot();
      return new Promise(function (ok, no) {
        var s = document.createElement('script');
        s.src = 'https://cdn.jsdelivr.net/npm/html-to-image@1.11.11/dist/html-to-image.js';
        s.onload = function () { shoot().then(ok, no); };
        s.onerror = function () { no(new Error('could not load the screenshot library (offline?)')); };
        document.head.appendChild(s);
      });
    },
  };

  addEventListener('message', function (e) {
    if (e.source !== P || !e.data || e.data.type !== 'bbx-auto:do') return;
    var id = e.data.id;
    var since = logs.length;
    Promise.resolve()
      .then(function () {
        var f = actions[e.data.action];
        if (!f) throw new Error('unknown action ' + e.data.action);
        return f(e.data.args || {});
      })
      .then(function (result) {
        // Let the page react (re-render, run handlers) before reporting.
        return new Promise(function (ok) { setTimeout(function () { ok(result); }, e.data.action === 'snapshot' || e.data.action === 'console' ? 0 : 150); });
      })
      .then(
        function (result) {
          var errors = logs.slice(since).filter(function (l) { return l.level === 'error'; }).map(function (l) { return l.text; });
          P.postMessage({ type: 'bbx-auto:res', id: id, result: result, errors: errors }, '*');
        },
        function (err) {
          P.postMessage({ type: 'bbx-auto:res', id: id, error: show(err) }, '*');
        },
      );
  });
  function ready() {
    P.postMessage({ type: 'bbx-auto:ready', title: document.title }, '*');
  }
  if (document.readyState === 'complete') setTimeout(ready);
  else addEventListener('load', function () { setTimeout(ready, 50); });
})();
