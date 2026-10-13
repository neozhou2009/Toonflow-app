# Toonflow 本地部署（本目录）

这是 [HBAI-Ltd/Toonflow-app](https://github.com/HBAI-Ltd/Toonflow-app) v2.0.5 的一份源码部署，
**外加一个本地 ComfyUI 供应商**（本项目新增，见下文）。

MIT 许可。上游未做任何功能性改动，`git log` 仍指向 `2c7fb25`（tag v2.0.5）。

---

## 一、这是什么

Toonflow 是一个 AI 短剧/漫剧创作平台：剧本、角色场景资产、图片/视频生成，都在同一张无限画布上完成。
本目录是它的**服务器部署**（Web UI + 后端），跑在你自己的机器上，项目文件存在本地 `data/`。

浏览器打开 `http://127.0.0.1:3000` 就能用，不需要登录。

---

## 二、启动

```bash
./start-toonflow.sh            # 前台
./start-toonflow.sh --bg       # 后台，日志 logs/toonflow.log
./start-toonflow.sh --port 3001
./stop-toonflow.sh             # 停止
```

**前提**：Bun 1.3.14（脚本会自动装）、ffmpeg（可选，视频合成才需要）。
首次启动会自动 `bun install` 并构建，耗时 3–8 分钟；之后只起服务，1 秒内就绪。

Windows 用户：当前脚本是 bash。想用 PowerShell / Docker Desktop，见第五节。

---

## 三、配置模型供应商（关键一步）

启动只是让服务跑起来，**要真正出图/出视频，必须在页面里配好供应商**。

### 3.1 本地 ComfyUI（本目录已内置，推荐）

页面里进入 **设置 → 媒体模型 → 添加**，供应商选「本地 ComfyUI」，需要填：

| 字段 | 说明 |
| --- | --- |
| ComfyUI 地址 | 例如 `http://192.168.1.76:8188` |
| UNet / CLIP / VAE | **必须与 ComfyUI 里 `models/` 下的实际文件名完全一致** |
| shift / steps / cfg | 采样参数，默认 3.1 / 20 / 2.5 |
| 用户名 / 密码 | 仅当 ComfyUI 开了 Basic 认证才填 |

填错模型文件名会在出图时报「加载模型失败」，改这里即可，不用改代码。

### 3.2 云端供应商

内置 4 家（APIMart、优云智算、秘塔 MiniMax H3、TF-Router），在页面里填各自 API Key 即可。
本机部署没有内置登录鉴权，**不要把 3000 端口暴露到公网**。

---

## 四、这个仓库比上游多了什么

### `packages/providers/src/media/comfyui.ts`

上游只内置了 4 家云厂商，**没有 ComfyUI 供应商**（ComfyUI 是插件市场里的能力，需要 TF-Router API Key
才能浏览插件市场）。所以自己写了一个，工作流直接复用你项目里 `character-refs` skill 已验证的
Qwen-Image 实现：

- 文生图走 `CLIPTextEncode`
- 带参考图走 `TextEncodeQwenImageEditPlus`（参考图先 `POST /upload/image` 传到 ComfyUI）
- `euler / simple` 采样、`ModelSamplingAuraFlow` shift 3.1
- 尺寸表与 skill 的 `QWEN_SIZES` 完全一致（如 `2:3 → 1056x1584`）
- 已装进 `data/providers/comfyui.ts`，重启服务后页面里直接能选

`packages/providers/package.json` 里加了一行 `./media/comfyui` 导出，仅此一处结构性改动。

### `dev-tools/`（测试资产，不影响运行）

| 文件 | 用途 |
| --- | --- |
| `mock-comfy-server.mjs` | 假 ComfyUI，复刻真实 API 路径/字段，并校验工作流结构 |
| `e2e-comfyui.mjs` | 供应商单测，29 条断言，不连真实服务 |
| `e2e-debug-run.sh` | 经 Toonflow 自己的 `/api/providers/debug/run` 跑完整链路 |
| `png-lite.mjs` | 极简 PNG 编解码，给测试替身用 |

```bash
bun run dev-tools/e2e-comfyui.mjs                  # 29 条断言
bash dev-tools/e2e-debug-run.sh                    # 端到端连 server
```

---

## 五、Windows / Docker Desktop

当前启动脚本是给 Linux/macOS 的 bash。

**PowerShell 起服务**（已装好依赖和构建的话）：

```powershell
$env:NODE_ENV="production"
$env:TOONFLOW_DATA_DIR="$PWD\data"
bun build\server\index.js
```

**Docker Desktop**（上游原生支持，适合不想装 Bun 的机器）：

```powershell
docker compose up -d --build
# 首次构建同样 3–8 分钟
# 打开 http://127.0.0.1:3000
```

数据在命名卷 `toonflowData` 里。**不要用 `docker compose down -v`**，那会连数据一起删。

⚠️ 注意：本目录在 OneDrive 里，`node_modules` 有上万个文件，OneDrive 同步会很慢甚至卡死。
如果明显卡，把 `Toonflow-app` 整个移到 OneDrive 以外的路径（比如 `D:\Toonflow-app`）再跑。

---

## 六、目录说明

```
Toonflow-app/
├── start-toonflow.sh / stop-toonflow.sh   ← 本目录新增的启动脚本
├── dev-tools/                             ← 本目录新增的测试资产
├── packages/providers/src/media/comfyui.ts← 本目录新增的 ComfyUI 供应商
├── build/                                 ← 构建产物（可删，重新构建即可）
├── data/                                  ← 你的项目、配置、插件（重要，别删）
│   ├── settings.json                      配置
│   ├── providers/comfyui.ts               已安装的 ComfyUI 供应商
│   └── workspaces/myProject/              你的短剧项目放这里
└── apps/ packages/                        ← 上游源码
```

`build/` 可以随时删掉，`start-toonflow.sh` 会重新构建。
`data/` 是你的实际资产，迁移或备份时整个拷走。

---

## 七、常见问题

**改完供应商代码不生效？**
供应商是运行时按源码加载的，但装过的供应商存在 `data/providers/` 里。改完源码后要删掉
`data/providers/comfyui.ts` 再重启，或在页面里「删除后重新安装」。

**端口被占用？** `./start-toonflow.sh --port 3001`

**出图报「模型加载失败」？** 模型文件名填错了，回第三节第 1 条对照改。

**构建时内存不足？** `export NODE_OPTIONS="--max-old-space-size=2560"` 再跑构建。

**`bun run --filter` 报 `error: ENOENT`？** 这是 Bun 1.3.14 在部分 Linux 上的已知问题，
上游的 `buildStandalone.ts` 已改用逐目录 `cwd` 的方式绕开；直接用官方构建脚本即可。
