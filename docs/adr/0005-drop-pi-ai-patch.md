# 不移植 pi-ai 的增量解析补丁（移除 postinstall）

`0.1.18`/`0.1.19` 曾用 `postinstall`（`scripts/patch-pi-ai.mjs`）把 DSH 的 `patches/@earendil-works__pi-ai@0.87.1.patch` 移植到消费者安装的 pi-ai 副本：删除 6 个 `dist/api/*.js` 中逐 delta 的 `parseStreamingJson` 重解析（上游 issue #9265 的 O(n²) 问题）。`0.1.20` 移除该脚本，接受上游行为。理由：

- 实现脆弱：pi-ai 是 ESM-only 包（`exports` 仅有 `import` 条件），`require.resolve` 在消费者布局下必然 `ERR_PACKAGE_PATH_NOT_EXPORTED`；可靠定位要求沿 Node 查找链逐级探测，且补丁文本绑定精确版本与构建产物形态；
- 补丁把每次发版都绑到一条更脆的链路上：发布物完整性 + 安装脚本执行——0.1.18 的安装失败与 0.1.19 的静默失效均出自这条链路，而它换取的开销只在多 MB 工具参数时显现（issue 实测 1 MB ≈ 1.4 s）；
- 上游修复路径明确：issue #9265 已开 PR #9461，发布后升级 pi-ai 即可获得，不需要长期维护消费者侧改写。

代价（已知并接受）：超长工具调用期间事件循环可能明显停顿，与 DSH 本体（pnpm patch）行为不一致；上游修复发布前不缓解。

考虑过并否决：保留并修好定位逻辑（改动约十行，但保留"消费者侧改写第三方依赖源码"这一永久维护面）；fork pi-ai 发布 patched 副本（干净，但要长期跟版维护 fork）。
