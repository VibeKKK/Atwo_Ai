ANSWER: 闸门入口是 lib/gate.mjs:69 的 runGate，契约从 vm/oracle-contract.json 读（lib/gate.mjs:118-119）。

EVIDENCE:
- lib/gate.mjs:69 — `export function runGate(opts = {}) {`
- lib/gate.mjs:118 — `const c = JSON.parse(fs.readFileSync(p, 'utf8'));`

NOTES: 结论只覆盖「入口在哪、契约怎么读」这两件事，不评价闸门判据是否完整。
