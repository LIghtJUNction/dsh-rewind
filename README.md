# dsh-rewind

为明确选定的本地文件保存 Git 对象检查点，预览后恢复，并在覆盖前持久保存 redo 检查点。它不会 reset/checkout/clean，也不修改 HEAD、分支或用户 index。

## 安装

需要 Git、Node.js 24+ 和 DeepSeek Harness **0.2.1-rc.2**。当前为源码交付，不表示 npm 已发布。在已安装 monorepo 依赖的目录：

```sh
npm run check --workspace @lightjunction/dsh-rewind
cd plugins/dsh-rewind
npm pack
dsh plugin --profile web add "$PWD/lightjunction-dsh-rewind-0.1.0.tgz" --ignore-scripts
```

重启 profile，确认出现 `rewind` 工具。其他 profile 将 `web` 替换为实际名字。

## 使用

以下都是 `rewind` 工具参数：

```json
{"action":"checkpoint","paths":["src/example.ts","README.md"]}
```

返回 id。paths 必须明确列出已有文件；不会自动扩大到整个仓库。

```json
{"action":"list"}
```

列出本仓库 `refs/dsh-rewind/` 下的检查点，重启后仍可使用。

```json
{"action":"preview","id":"<检查点 id>"}
```

返回 token 和各文件 before/after 的 **base64 原始字节**，changed 标记也包括权限差异；不是统一 diff。请先解码比较。随后：

```json
{"action":"restore","id":"<检查点 id>","token":"<最新 preview token>"}
```

仅恢复检查点中明确选定的文件。返回 backupId 是覆盖前的 redo 检查点；要撤销本次恢复，对 backupId 再 preview/restore。token 绑定当前文件字节、权限、HEAD 和分支；预览后改动文件会使恢复失败。恢复操作会覆盖这些选定文件的当前内容，包括其未提交改动；这些内容先保存在 backupId 中。其他 dirty/untracked 文件保持原样。

## 配置和保护

默认取当前 agent workingDirectory；宿主无 agent 调用可配置 `root`。工作区必须恰好是已有提交、具名分支的 Git 仓库根目录；未提交的新仓库、detached HEAD 和子目录根不支持。跨 HEAD 或分支恢复被拒绝。

检查点将 JSON manifest 和 base64 文件内容写入 Git blob，并用独立 refs 引用；不创建普通提交，不调用 git add/read-tree/write-tree/reset/clean，不读取或重建用户暂存区。Git 子进程去除继承的 GIT_* 环境覆盖，使用参数数组，不经过 shell。检查点占用 `.git/objects`；不会自动删除 refs 或回收对象，可能保存敏感文件内容，paths 应由调用者明确选择。

拒绝工作区外路径、`.git` 元数据、符号链接、多重硬链接和非普通文件。每次 1–100 个文件，每文件最多 1 MiB，整个 manifest 最多 8 MiB；不删除或创建恢复目标。支持二进制字节和普通权限位。被删除的文件需要调用者先恢复文件路径后才能使用本工具。

恢复会先持久保存备份、准备同目录临时文件、再次检查当前文件，再逐文件原子 rename。多文件不是全批事务；中途文件系统失败可能留下部分恢复，错误会给出 redo 检查点。不同插件实例/外部进程的恶意并发不能被 Node 可移植文件 API 完全隔离；不要在其他进程同步改目录时恢复。不保留 ACL、扩展属性、inode 或特殊权限位。

仅支持**宿主机本地文件系统和本地 Git**，不声称支持 DSH remote world/sandbox，也不是安全沙箱。

## v0.1 与 pi 来源的差异

来源为 [arpagon/pi-rewind](https://github.com/arpagon/pi-rewind)，MIT，归属见 [UPSTREAM.md](UPSTREAM.md)、[NOTICE](NOTICE)。独立实现，没有复制上游源码。

保留 checkpoint、preview、恢复、redo 和分支保护的行为目标。取消自动每轮快照、全仓库恢复、会话回退、交互选择器、自动 pruning；不用上游的 reset --hard、read-tree 和 clean。首版不是完整 pi-rewind 移植。

## 本地测试

```sh
npm run check --workspace @lightjunction/dsh-rewind
```

真实 rc.2 ToolRuntime 配合真实临时 Git 仓库，覆盖持久检查点、恢复/redo、逐字节 index 保持、HEAD 保持、预存 dirty 和新增 untracked 文件保持、过期 token、分支变化、越界、符号链接和取消。测试不调用付费模型。
