// lib/pool.mjs —— 多池调度：一组作业按通道能力分池，池内并发受硬上限约束，某池连败整池改派。
//
// 上限是实测出来的墙，不是配额偏好：codebuddy 12 路时单路由 4.85s 涨到 11.05s、吞吐停在
// 0.96/s（见 lib/lanes.mjs 里 LANE_DEFS 的注释）—— 超发换来的不是更快，而是每路都变慢。
// 所以宁可让作业在 unassigned 里留空，也不把通道推到拐点之后。

export const POOL_CONTRACT = 'atwo-pool/1';

// 每通道的并发拐点（实测）。
export const LANE_CAPS = { codebuddy: 6, codex: 6, ollama: 2, trae: 1, workbuddy: 1, doubao: 1 };

export const WRITER_LANES = ['codebuddy', 'codex', 'ollama'];

// GUI 通道单窗口独占：多开抢的是同一个窗口，表现出来是「每路都变慢」而不是并行。
// 这条写死：opts.caps 能调调用方自己的分配偏好，改不了别人的物理天花板。
const GUI_LANES = ['trae', 'workbuddy', 'doubao'];
const GUI_CAP = 1;

// 单条失败多是偶发超时；连续 2 条才是「这条通道现在坏了」，到这一步池里剩下的活得换人跑。
const DEAD_AFTER = 2;

function has(obj, key) {
  return !!obj && Object.prototype.hasOwnProperty.call(obj, key);
}

function availableLanes(opts) {
  const asked = Array.isArray(opts.lanes) && opts.lanes.length ? opts.lanes : WRITER_LANES;
  const probes = opts.probes || null;
  const seen = new Set();
  const out = [];
  for (const raw of asked) {
    const lane = String(raw == null ? '' : raw).trim();
    // 不认识的通道不猜能力：猜错等于把活派给一个不存在的池。
    if (!lane || seen.has(lane) || !has(LANE_CAPS, lane)) continue;
    // probes 里没提到的通道按可用算（没给 probes 就是全可用）；只有明确 false 才剔除。
    if (probes && has(probes, lane) && !probes[lane]) continue;
    seen.add(lane);
    out.push(lane);
  }
  return out;
}

function capOf(lane, caps) {
  // GUI 通道没有「调高」这个选项：单窗口就是 1。
  if (GUI_LANES.includes(lane)) return GUI_CAP;
  const raw = has(caps, lane) ? caps[lane] : LANE_CAPS[lane];
  const n = Math.floor(Number(raw));
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function liveLanes(opts) {
  const caps = new Map();
  const live = [];
  for (const lane of availableLanes(opts)) {
    const cap = capOf(lane, opts.caps);
    caps.set(lane, cap);
    if (cap > 0) live.push(lane);
  }
  return { live, caps };
}

export function planPool(jobs, opts = {}) {
  const list = Array.isArray(jobs) ? jobs : [];
  const { live, caps } = liveLanes(opts);
  if (!live.length) {
    return { ok: false, contract: POOL_CONTRACT, plan: [], unassigned: list.map((j) => j && j.id), reason: 'no-writer-lane' };
  }

  const room = new Map(live.map((l) => [l, caps.get(l)]));
  const pools = new Map(live.map((l) => [l, []]));
  let cursor = 0;
  let placed = 0;
  for (const job of list) {
    let target = null;
    for (let step = 0; step < live.length; step += 1) {
      const lane = live[(cursor + step) % live.length];
      if (room.get(lane) > 0) {
        target = lane;
        cursor = (cursor + step + 1) % live.length;
        break;
      }
    }
    // 每个池都到顶了：剩下的留空。硬塞进去只会把整条通道一起拖慢。
    if (!target) break;
    room.set(target, room.get(target) - 1);
    pools.get(target).push(job && job.id);
    placed += 1;
  }

  // 空池不进 plan：计划是「要跑什么」，不是通道清单。
  const plan = live.filter((l) => pools.get(l).length).map((l) => ({ lane: l, jobs: pools.get(l) }));
  const unassigned = list.slice(placed).map((j) => j && j.id);
  return { ok: true, contract: POOL_CONTRACT, plan, unassigned, reason: 'ok' };
}

export async function runPool(jobs, opts = {}) {
  const none = { contract: POOL_CONTRACT, results: [], laneStats: {}, reassigned: [] };
  if (typeof opts.ask !== 'function') return { ok: false, ...none, reason: 'no-ask' };

  const list = Array.isArray(jobs) ? jobs : [];
  const { live, caps } = liveLanes(opts);
  if (!live.length) return { ok: false, ...none, reason: 'no-writer-lane' };

  // 总量仍按 cap 之和封顶；但池是队列：cap 只约束「同时跑几条」，不限制排队几条。
  // 队列要是也卡在 cap，池里就永远没有「还没跑的作业」，连败改派会变成死代码。
  const total = live.reduce((sum, l) => sum + caps.get(l), 0);
  const taken = list.slice(0, total);
  const unassigned = list.slice(total).map((j) => j && j.id);

  const lanes = new Map();
  const laneStats = {};
  for (const lane of live) {
    lanes.set(lane, { lane, cap: caps.get(lane), running: 0, fails: 0, dead: false, queue: [] });
    laneStats[lane] = { ok: 0, fail: 0, ms: 0 };
  }
  taken.forEach((job, i) => {
    lanes.get(live[i % live.length]).queue.push({ id: job && job.id, job, index: i });
  });

  const results = [];
  const reassigned = [];
  const spill = [];
  const inflight = new Set();

  const runOne = (st, item) => {
    const started = Date.now();
    st.running += 1;
    const task = (async () => {
      let r = null;
      try {
        r = await opts.ask(st.lane, item.job);
      } catch (e) {
        r = { ok: false, error: (e && e.message) || String(e) };
      }
      const ok = !!(r && r.ok);
      const ms = Date.now() - started;
      st.running -= 1;
      const error = ok ? null : String((r && r.error) || 'failed');
      results.push({ id: item.id, lane: st.lane, ok, ms, error, out: r ? r.out : null, index: item.index });
      const s = laneStats[st.lane];
      s.ms += ms;
      if (ok) {
        s.ok += 1;
        st.fails = 0;
      } else {
        s.fail += 1;
        st.fails += 1;
        if (!st.dead && st.fails >= DEAD_AFTER) {
          // 整池改派：连败说明通道现在不可用，池里还没跑的活不能陪着一起沉。
          st.dead = true;
          while (st.queue.length) {
            const left = st.queue.shift();
            spill.push({ ...left, from: left.from || st.lane });
          }
        }
      }
    })();
    // 用 finally 清账：race 看到它落定时，inflight 里已经没有它了。
    const tracked = task.finally(() => inflight.delete(tracked));
    inflight.add(tracked);
  };

  const fill = () => {
    for (const st of lanes.values()) {
      while (!st.dead && st.running < st.cap) {
        const item = st.queue.shift() || (spill.length ? spill.shift() : null);
        if (!item) break;
        // 改派只有真跑起来才算数：记下「原本派给谁、实际谁跑」。
        if (item.from && item.from !== st.lane) reassigned.push({ id: item.id, from: item.from, to: st.lane });
        runOne(st, item);
      }
    }
  };

  fill();
  while (inflight.size) {
    await Promise.race(inflight);
    fill();
  }

  // 所有池都死了才会走到这里：剩下的活没有通道可跑，记成失败而不是静默丢掉。
  const left = [];
  for (const st of lanes.values()) left.push(...st.queue.splice(0));
  left.push(...spill.splice(0));
  for (const item of left) {
    const from = item.from || live[0];
    laneStats[from].fail += 1;
    results.push({ id: item.id, lane: from, ok: false, ms: 0, error: 'lane-dead', out: null, index: item.index });
  }

  results.sort((a, b) => a.index - b.index);
  const clean = results.map(({ index, ...rest }) => rest);
  const ok = clean.length === list.length && clean.every((r) => r.ok);
  return {
    ok,
    contract: POOL_CONTRACT,
    results: clean,
    laneStats,
    reassigned,
    unassigned,
    reason: ok ? 'ok' : (clean.length === list.length ? 'some-failed' : 'incomplete'),
  };
}
