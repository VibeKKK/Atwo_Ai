// 极简 CDP 客户端（只用 WebSocket + Runtime/Input 域）
export class CDP {
  constructor(wsUrl) { this.wsUrl = wsUrl; this.id = 0; this.pending = new Map(); }

  async connect() {
    this.ws = new WebSocket(this.wsUrl);
    await new Promise((res, rej) => {
      this.ws.addEventListener('open', res, { once: true });
      this.ws.addEventListener('error', rej, { once: true });
    });
    this.ws.addEventListener('message', (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id && this.pending.has(m.id)) { this.pending.get(m.id)(m); this.pending.delete(m.id); }
    });
    return this;
  }

  call(method, params = {}, timeoutMs = 30000) {
    const mid = ++this.id;
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => { this.pending.delete(mid); reject(new Error('CDP timeout: ' + method)); }, timeoutMs);
      this.pending.set(mid, (m) => { clearTimeout(t); resolve(m); });
      this.ws.send(JSON.stringify({ id: mid, method, params }));
    });
  }

  async js(expr, timeoutMs = 30000) {
    const r = await this.call('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }, timeoutMs);
    if (r.result && r.result.exceptionDetails) {
      throw new Error('JS exception: ' + (r.result.exceptionDetails.exception?.description || JSON.stringify(r.result.exceptionDetails)).slice(0, 400));
    }
    return r.result && r.result.result ? r.result.result.value : undefined;
  }

  close() { try { this.ws.close(); } catch {} }
}

export async function findTarget(port, titlePart) {
  const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  const page = list.find(t => t.type === 'page' && t.title.includes(titlePart));
  if (!page) throw new Error(`no target matching "${titlePart}"; have: ` + list.map(t => t.title).join(' | '));
  return page;
}

export async function attach(port, titlePart) {
  const t = await findTarget(port, titlePart);
  const c = new CDP(t.webSocketDebuggerUrl);
  await c.connect();
  return c;
}
