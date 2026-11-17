// 极简 CDP 客户端（只用 WebSocket + Runtime/Input 域）
export class CDP {
  constructor(wsUrl) { this.wsUrl = wsUrl; this.id = 0; this.pending = new Map(); this.handlers = new Map(); }

  // 订阅 CDP 事件（无 id 的消息）。要收网络事件必须先调 Network.enable。
  //
  // 为什么需要：Trae 的 commercial/get_session_usage 是内部模块发的，不经过页面的
  // window.fetch，所以注入 hook 抓不到（实测 hook 装上、对话正常、记录数仍为 0）。
  // 只有 CDP 的 Network 域能看见它。
  on(method, fn) {
    if (!this.handlers.has(method)) this.handlers.set(method, new Set());
    this.handlers.get(method).add(fn);
    return () => this.handlers.get(method)?.delete(fn);
  }

  async connect() {
    this.ws = new WebSocket(this.wsUrl);
    await new Promise((res, rej) => {
      this.ws.addEventListener('open', res, { once: true });
      this.ws.addEventListener('error', rej, { once: true });
    });
    this.ws.addEventListener('message', (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id && this.pending.has(m.id)) { this.pending.get(m.id)(m); this.pending.delete(m.id); return; }
      if (m.method && this.handlers.has(m.method)) {
        for (const fn of [...this.handlers.get(m.method)]) { try { fn(m.params); } catch {} }
      }
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
  const list = await (await fetch(`http://localhost:${port}/json/list`)).json();
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

// 有些客户端（豆包）页面标题会跟着当前会话变（「读取并执行任务 - 豆包」），
// 按标题匹配不稳定，只能按 URL 前缀找：doubao://doubao-chat/chat/<id>。
export async function findTargetByUrl(port, urlPart) {
  const list = await (await fetch(`http://localhost:${port}/json/list`)).json();
  const page = list.find((t) => t.type === 'page' && String(t.url || '').includes(urlPart));
  if (!page) throw new Error(`no page whose url includes "${urlPart}"; have: ` + list.filter(t => t.type === 'page').map(t => t.url).join(' | '));
  return page;
}

export async function attachUrl(port, urlPart) {
  const t = await findTargetByUrl(port, urlPart);
  const c = new CDP(t.webSocketDebuggerUrl);
  await c.connect();
  return c;
}
