export class HttpResponse {
  constructor() {
    this.statusCode = 200;
    this.headers = new Headers();
    this.body = null;
    this.finished = false;
  }
  status(n) { this.statusCode = n; return this; }
  setHeader(k, v) { this.headers.set(k, v); return this; }
  json(obj) {
    this.headers.set('Content-Type', 'application/json; charset=utf-8');
    this.body = JSON.stringify(obj);
    this.finished = true;
    return this;
  }
  text(s) {
    if (!this.headers.has('Content-Type')) this.headers.set('Content-Type', 'text/plain; charset=utf-8');
    this.body = String(s);
    this.finished = true;
    return this;
  }
  sendStatus(n) { this.statusCode = n; this.body = ''; this.finished = true; return this; }
  toResponse() {
    return new Response(this.body ?? '', { status: this.statusCode, headers: this.headers });
  }
}

function compilePath(path) {
  const keys = [];
  const rx = path
    .replace(/[.*+^${}()|[\]\\]/g, '\\$&')
    .replace(/\/:([A-Za-z_][A-Za-z0-9_]*)/g, (_m, k) => { keys.push(k); return '/([^/]+)'; });
  return { regex: new RegExp('^' + rx + '$'), keys };
}

export class Router {
  constructor() {
    this.routes = [];
    this.prefix = '';
  }
  _add(method, path, handlers) {
    const full = (this.prefix + path).replace(/\/+/g, '/') || '/';
    const { regex, keys } = compilePath(full === '/' ? '/' : full.replace(/\/$/, ''));
    this.routes.push({ method, regex, keys, handlers: handlers.flat() });
  }
  get(p, ...h) { this._add('GET', p, h); }
  post(p, ...h) { this._add('POST', p, h); }
  put(p, ...h) { this._add('PUT', p, h); }
  patch(p, ...h) { this._add('PATCH', p, h); }
  delete(p, ...h) { this._add('DELETE', p, h); }
  use(prefix, sub) {
    for (const r of sub.routes) {
      this.routes.push({ ...r, regex: prefixRegex(prefix, r), sourcePrefix: prefix });
    }
  }
  async handle(req, res) {
    const url = new URL(req.raw.url);
    let pathname = url.pathname;
    const method = req.raw.method === 'HEAD' ? 'GET' : req.raw.method;
    const route = this.routes.find(r => r.method === method && r.regex.test(pathname));
    if (!route) return false;
    const m = pathname.match(route.regex);
    if (m && route.keys.length) {
      route.keys.forEach((k, i) => { req.params[k] = decodeURIComponent(m[i + 1]); });
    }
    let idx = 0;
    const next = async (err) => {
      if (err) throw err;
      if (res.finished) return;
      const h = route.handlers[idx++];
      if (!h) return;
      await h(req, res, next);
    };
    await next();
    return true;
  }
}

function prefixRegex(prefix, route) {
  const base = prefix.replace(/\/+$/, '');
  const src = route.regex.source;
  if (src === '^/$') return new RegExp('^' + base.replace(/[.*+^${}()|[\]\\]/g, '\\$&') + '/?$');
  return new RegExp('^' + base + src.slice(1));
}
