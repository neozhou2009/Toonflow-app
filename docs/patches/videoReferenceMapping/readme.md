# Toonflow 视频引用映射补丁

本补丁将 referenceOrder 作为公共视频请求字段传递给所有供应商，移除按 providerId 筛选的白名单。以后安装新视频供应商，无需再修改宿主供应商名单。供应商仍需按自身接口要求转换引用标记；这不代表所有供应商都支持任意数量或任意类型的参考素材。

## 基线和文件

源码基线：c48c2c4fa27d6c97ce747abe818db67198716b8e（本机 local/v2.0.7，目录名仍为 Toonflow-app-v2.0.6）。应用前请先保存已有改动。其他版本必须先检查补丁上下文，不能强行覆盖。

- referenceMapping.patch：后端统一传递字段、公共 VideoRequest 类型、生成供应商文件时使用的协议说明。
- [referenceMapping.zip](referenceMapping.zip) 内的 videoGenerationNode.umd.js：从同一工作树当前源码构建的视频节点插件，补齐旧插件没有发送 referenceOrder 的问题。旧版宿主兼容性未逐版验证。

## 工作原理

视频节点根据当前连接顺序，为每次生成请求创建 referenceOrder。后端验证映射并传给供应商。数组第 1 项对应 {{ref 1}}；image/video/audio 的 index:0 表示对应类别数组中的第 1 个素材。供应商使用映射替换提示词标记，不能猜测混合引用顺序。首尾帧和文本各有独立类型。

安装供应商只注册适配器与模型，不会预先固定素材映射。节点之间的实际连接会变化，所以映射是在每次请求时生成的。

## 在另一份源码中应用

在目标 Toonflow 仓库根目录执行（将路径换成本补丁实际位置）：

```powershell
git apply --check '完整路径/referenceMapping.patch'
git apply '完整路径/referenceMapping.patch'
bun run --cwd apps/server typecheck
bun run --cwd apps/server build
```

如果 check 提示补丁已应用或上下文不符，先检查 generation.ts 中是否已使用下面的代码，不要重复应用：

```typescript
const referenceOrder = mediaType === "video" ? request.referenceOrder : undefined;
```

旧版视频节点也必须更新：在停止使用页面期间，先备份安装数据目录下的 nodes/videoGenerationNode.umd.js，再用本包同名文件替换；如果应用指定了 TOONFLOW_DATA_DIR，则以该目录为准。也可以在对应源码的 packages/nodes/videoGenerationNode 中执行 bun run --bun build，再部署 build/nodes/videoGenerationNode.umd.js。不要删除整个 nodes 目录。

若要更新供应商编辑界面的协议提示文字，还需构建 apps/web。随后重启后端并刷新浏览器，使新的后端和视频节点一起生效。

## 验证及生效方式

服务端类型检查通过；视频节点构建通过。手动检查确认节点下载接口提供的文件包含 referenceOrder。没有发起新的付费生成，这些检查不代表端到端生成成功。

本分支的源码已经包含补丁，不必再次 git apply。部署时仍须构建后端、更新已安装的视频节点插件，随后重启后端并刷新浏览器。仅安装供应商文件无法更新旧版宿主和旧节点插件。

## 白名单能否自己修改

旧版名单位于 apps/server/src/utils/media/generation.ts 的 prepareRequest 函数。可以手动加入与供应商文件 id 完全一致的字符串，但需要重新构建并重启后端，网页中没有对应设置。应用本补丁后不再需要维护这份名单。
