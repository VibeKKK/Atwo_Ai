## 2026-11-14 14:07 · 新增 test/store_history.mjs（纯 node:assert，不要第三方包）。用 lib/store.mjs 的 open()，在 os.tmpdir() 下建临时库，验证三件事：(1) put 之后 history('t','k') 返回按时间升序的全部变更；(2) 写 300 条后 compact(200)，allRecords() 总数仍是 300；(3) 两个不同 by 写同一个键，get 拿到后写的值。结束时删临时目录。
- agent: codebuddy · 结果: 待审阅（提案成型）
- 文件: test/store_history.mjs
- 测试: selftest=ok lockpool=ok batch_offline=ok ui_smoke=ok eval_selftest=ok
