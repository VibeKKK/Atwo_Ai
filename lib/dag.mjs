// 自检: node --check lib/dag.mjs && node --input-type=module -e "import('./lib/dag.mjs').then(m=>console.log(m.topoSort([{id:1,deps:[]},{id:2,deps:[1]}])))"

/**
 * 把 id 统一转成字符串作为 Map 的键。
 * 之所以要归一化，是因为 deps 允许字符串与数字混用（例如任务 id 是 2、依赖写成 '2'），
 * 若直接用原始值做键会查不到而误判为「缺依赖」；统一成字符串可让两种写法命中同一节点。
 * @param {string|number} id 任务 id 或依赖引用
 * @returns {string} 归一化后的键
 */
function toKey(id) {
  return String(id);
}

/**
 * 比较原始 id，供同层升序排序使用。
 * 之所以既比较数值又比较字符串，是因为纯字典序会把 '10' 排在 '2' 前面，
 * 而数字 id 期望的是数值升序；只对「看起来是数字」的 id 走数值比较，其余按字典序兜底。
 * @param {string|number} a
 * @param {string|number} b
 * @returns {number} 负值/0/正值
 */
function cmpId(a, b) {
  const sa = String(a);
  const sb = String(b);
  const na = Number(sa);
  const nb = Number(sb);
  const bothNumeric = sa !== '' && sb !== '' && !Number.isNaN(na) && !Number.isNaN(nb);
  if (bothNumeric && na !== nb) {
    return na - nb;
  }
  return sa < sb ? -1 : sa > sb ? 1 : 0;
}

/**
 * 解析任务列表，构建依赖图的三张索引表。
 * 之所以预先建 byId/children/indegree 三张 Map，是为了让后续拓扑、就绪、阻塞查询
 * 都能 O(1) 定位，避免用 array.find 在 1000 任务规模下反复线性扫描；
 * 之所以在建 children 时校验每个依赖是否存在，是为了尽早把「缺依赖」暴露成错误，
 * 而不是让它在拓扑排序里表现成一个永远无法归零的入度。
 * @param {Array<{id: string|number, deps?: Array<string|number>, dependencies?: Array<string|number>}>} list 任务列表，每项含 id 和依赖数组
 * @returns {{byId: Map<string, {id: string|number, deps: string[]}>, children: Map<string, string[]>, indegree: Map<string, number>}} 索引表
 * @throws {Error} 存在重复 id 或引用了不存在的依赖时抛出
 */
export function parseDeps(list) {
  const byId = new Map();
  for (const item of list) {
    const id = item.id;
    const key = toKey(id);
    if (byId.has(key)) {
      throw new Error('重复的任务 id: ' + id);
    }
    let raw = item.deps;
    if (raw == null) {
      raw = item.dependencies;
    }
    if (raw == null) {
      raw = [];
    }
    if (!Array.isArray(raw)) {
      raw = [raw];
    }
    // 用 Set 去重，避免同一依赖被计入两次入度，导致 Kahn 永远消不掉该节点。
    const deps = [...new Set(raw.map((x) => toKey(x)))];
    byId.set(key, { id: id, deps: deps });
  }
  const children = new Map();
  const indegree = new Map();
  for (const key of byId.keys()) {
    children.set(key, []);
    indegree.set(key, 0);
  }
  for (const [key, node] of byId) {
    for (const depKey of node.deps) {
      if (!byId.has(depKey)) {
        throw new Error('任务 ' + node.id + ' 缺少依赖: ' + depKey);
      }
      children.get(depKey).push(key);
      indegree.set(key, indegree.get(key) + 1);
    }
  }
  return { byId: byId, children: children, indegree: indegree };
}

/**
 * 在剩余（入度未归零）节点里找出一条真实的环路径。
 * 之所以单独做一次 DFS 而不是只报「有环」，是因为调用方需要完整路径（如 1 -> 2 -> 1）
 * 才能定位是哪些任务互相卡住；只遍历剩余节点能保证命中一个真正的强连通环，
 * 且用显式栈下标 Map 记录位置，避免用 array.find 线性回查。
 * @param {Map} byId 节点索引
 * @param {Set<string>} processed 已完成节点集合
 * @returns {Array<string|number>} 环上原始 id 序列，首尾相同
 */
function findCycle(byId, processed) {
  const state = new Map();
  const stack = [];
  const pos = new Map();
  function dfs(u) {
    state.set(u, 1);
    pos.set(u, stack.length);
    stack.push(u);
    for (const v of byId.get(u).deps) {
      if (processed.has(v)) {
        continue;
      }
      const s = state.get(v) || 0;
      if (s === 1) {
        const cycle = stack.slice(pos.get(v)).map((k) => byId.get(k).id);
        cycle.push(byId.get(v).id);
        return cycle;
      }
      if (s === 0) {
        const found = dfs(v);
        if (found) {
          return found;
        }
      }
    }
    stack.pop();
    pos.delete(u);
    state.set(u, 2);
    return null;
  }
  for (const key of byId.keys()) {
    if (processed.has(key) || state.get(key) === 2) {
      continue;
    }
    const found = dfs(key);
    if (found) {
      return found;
    }
  }
  return [];
}

/**
 * 分层执行 Kahn 算法，返回「层」的数组。
 * 之所以按层推进而非用最小堆逐个取，是因为题目要求同层 id 升序、且 layers() 需要按层分组，
 * 一次收集整层再统一排序能同时满足两者且保证 topoSort 与 layers 结果一致；
 * 入度用副本 deg 是为了不污染 parseDeps 的返回值，便于同一份图被多个查询复用。
 * @param {Map} byId 节点索引
 * @param {Map} children 反向邻接表
 * @param {Map} indegree 入度表
 * @returns {Array<Array<string|number>>} 每层一组原始 id
 * @throws {Error} 存在环时抛出，错误信息带完整环路径
 */
function computeLayers(byId, children, indegree) {
  const deg = new Map(indegree);
  const result = [];
  const processed = new Set();
  let current = [];
  for (const [key, d] of deg) {
    if (d === 0) {
      current.push(key);
    }
  }
  current.sort((a, b) => cmpId(byId.get(a).id, byId.get(b).id));
  while (current.length > 0) {
    result.push(current.map((k) => byId.get(k).id));
    const next = [];
    for (const key of current) {
      processed.add(key);
      for (const childKey of children.get(key)) {
        const nd = deg.get(childKey) - 1;
        deg.set(childKey, nd);
        if (nd === 0) {
          next.push(childKey);
        }
      }
    }
    current = next.sort((a, b) => cmpId(byId.get(a).id, byId.get(b).id));
  }
  if (processed.size !== byId.size) {
    const cycle = findCycle(byId, processed);
    throw new Error('存在循环依赖: ' + cycle.join(' -> '));
  }
  return result;
}

/**
 * 拓扑排序，返回可执行的任务 id 序列。
 * 之所以直接复用分层结果再摊平，是为了保证顺序与 layers() 完全一致，
 * 同时把「同层升序」和「环检测」逻辑集中在一处，避免两处实现漂移。
 * @param {Array} list 任务列表
 * @returns {Array<string|number>} 拓扑序 id 数组
 * @throws {Error} 存在环时抛出，错误信息带完整环路径
 */
export function topoSort(list) {
  const { byId, children, indegree } = parseDeps(list);
  const groups = computeLayers(byId, children, indegree);
  const out = [];
  for (const layer of groups) {
    for (const id of layer) {
      out.push(id);
    }
  }
  return out;
}

/**
 * 按层分组，返回每一层可并行执行的任务 id 数组。
 * 之所以单独暴露分层结果，是因为调度器常需要「同一批一起下发」的批次信息，
 * 而摊平后的拓扑序会丢失这个批次边界。
 * @param {Array} list 任务列表
 * @returns {Array<Array<string|number>>} 层数组，层内 id 升序
 * @throws {Error} 存在环时抛出，错误信息带完整环路径
 */
export function layers(list) {
  const { byId, children, indegree } = parseDeps(list);
  return computeLayers(byId, children, indegree);
}

/**
 * 把已完成集合归一化成键集合。
 * 之所以接受任意可迭代对象并统一转字符串键，是因为 done 可能是数组、Set 或混合类型 id，
 * 与 deps 的字符串数字混用规则保持一致，查询时才能直接命中。
 * @param {Iterable<string|number>|null|undefined} done 已完成 id
 * @returns {Set<string>} 归一化后的键集合
 */
function toKeySet(done) {
  const set = new Set();
  if (done == null) {
    return set;
  }
  for (const x of done) {
    set.add(toKey(x));
  }
  return set;
}

/**
 * 求当前可就绪的未完成 id：依赖全部完成、且自身尚未完成。
 * 之所以用「遍历节点 + 逐个查依赖」而不是从 done 反推，是因为前者对每个节点只做 O(依赖数) 检查，
 * 在 1000 任务、3 依赖规模下总开销稳定且无需维护额外反向状态。
 * @param {Array} list 任务列表
 * @param {Iterable<string|number>} done 已完成 id 集合
 * @returns {Array<string|number>} 就绪 id 数组，升序
 */
export function readySet(list, done) {
  const { byId } = parseDeps(list);
  const doneKeys = toKeySet(done);
  const ready = [];
  for (const [key, node] of byId) {
    if (doneKeys.has(key)) {
      continue;
    }
    let ok = true;
    for (const depKey of node.deps) {
      if (!doneKeys.has(depKey)) {
        ok = false;
        break;
      }
    }
    if (ok) {
      ready.push(node.id);
    }
  }
  ready.sort(cmpId);
  return ready;
}

/**
 * 求某任务还缺哪些直接前置（未完成的依赖）。
 * 之所以只报直接依赖而非递归展开所有祖先，是因为「还缺哪些前置」在调度语境下指挡在当前节点前的那一层，
 * 直接依赖未完成本身已足以解释为何不可执行，递归展开反而会淹没关键信息。
 * @param {Array} list 任务列表
 * @param {string|number} id 目标任务 id
 * @param {Iterable<string|number>} done 已完成 id 集合
 * @returns {Array<string|number>} 仍缺失的前置 id 数组，升序
 * @throws {Error} 目标 id 不存在时抛出
 */
export function blockedBy(list, id, done) {
  const { byId } = parseDeps(list);
  const key = toKey(id);
  const node = byId.get(key);
  if (!node) {
    throw new Error('未找到任务: ' + id);
  }
  const doneKeys = toKeySet(done);
  const missing = [];
  for (const depKey of node.deps) {
    if (!doneKeys.has(depKey)) {
      missing.push(byId.get(depKey).id);
    }
  }
  missing.sort(cmpId);
  return missing;
}
