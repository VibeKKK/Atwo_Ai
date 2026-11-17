ANSWER: 读了 lib/gate.mjs，结论：这两处定义就是任务要求的实现入口与判据来源。

EVIDENCE:
- lib/gate.mjs:13 — `function run(cmd, args, cwd, timeoutMs) {`
- lib/gate.mjs:14 — `const t0 = Date.now();`
