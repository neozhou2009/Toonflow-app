/**
 * 本地假 ComfyUI（测试替身，不参与生产运行）
 * ---------------------------------------------------------------------------
 * 复刻真实 ComfyUI HTTP API 的路径、字段与协议，并对 Qwen-Image 工作流做结构校验：
 *   GET  /system_stats
 *   POST /upload/image     → { name, subfolder, type }
 *   POST /prompt           → { prompt_id }；同时校验工作流图，结构不符返回 400
 *   GET  /history/{id}     → 奇数次空（模拟排队），偶数次返回 success + 图片
 *   GET  /view?...         → 真实 PNG 字节
 *
 * 用于在没有 GPU / 没有真实 ComfyUI 的环境下验证供应商代码。
 * 启动：bun dev-tools/mock-comfy-server.mjs   默认 127.0.0.1:18188，PORT 可覆盖
 */
import { createServer } from "node:http";
import { PNG } from "./png-lite.mjs";

export const PORT = Number(process.env.PORT ?? 18188);

export const seen = {
  prompts: [],
  problems: null,
  uploads: 0,
  polls: 0,
  viewQuery: null,
};

const server = createServer((req, res) => {
  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", async () => {
    const raw = Buffer.concat(chunks);
    const url = req.url ?? "";
    const path = url.split("?")[0];
    const json = (code, body, headers = {}) => {
      res.writeHead(code, { "Content-Type": "application/json", ...headers });
      res.end(typeof body === "string" || Buffer.isBuffer(body) ? body : JSON.stringify(body));
    };

    if (req.method === "GET" && path === "/system_stats") {
      return json(200, { system: { os: "linux", comfyui_version: "mock-1.0", python_version: "3.11" } });
    }

    if (path === "/upload/image") {
      seen.uploads += 1;
      if (!raw.length) return json(400, { error: "empty upload body" });
      // 校验 multipart 结构：boundary 必须匹配 Content-Type，且四个字段齐全、图片字节完整
      const contentType = req.headers["content-type"] ?? "";
      const m = /boundary=(.+)$/.exec(contentType);
      if (!m) { seen.problems = ["upload: no boundary in Content-Type"]; return json(400, { error: seen.problems[0] }); }
      const boundary = `--${m[1]}`;
      const text = raw.toString("latin1");
      for (const field of ["subfolder", "type", "overwrite", "image"]) {
        if (!text.includes(`name="${field}"`)) seen.problems = [...(seen.problems ?? []), `upload missing field ${field}`];
      }
      // filename 是 image 字段 Content-Disposition 的属性，不是独立字段
      if (!/name="image";\s*filename="[^"]+"/.test(text)) seen.problems = [...(seen.problems ?? []), "image field has no filename"];
      if (!text.includes(`Content-Type: image/png`)) seen.problems = [...(seen.problems ?? []), "image field has no Content-Type"];
      if (!text.endsWith(`${boundary}--\r\n`)) seen.problems = [...(seen.problems ?? []), "upload body not terminated by boundary"];
      // 图片字节：PNG 魔数 + IEND
      const pngStart = raw.indexOf(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
      const iend = raw.indexOf(Buffer.from("IEND", "latin1"));
      if (pngStart < 0) seen.problems = [...(seen.problems ?? []), "upload contains no PNG magic"];
      if (iend < 0) seen.problems = [...(seen.problems ?? []), "upload contains no IEND chunk"];
      if (seen.problems?.length) return json(400, { error: seen.problems.join("; ") });
      seen.problems = null;
      return json(200, { name: "toonflow/ref_1.png", subfolder: "toonflow", type: "input" });
    }

    // 供应商调试器会抓取节点清单；真实 ComfyUI 返回全量 object_info
    if (req.method === "GET" && path === "/object_info") {
      const nodes = {};
      for (const n of ["UNETLoader", "CLIPLoader", "VAELoader", "ModelSamplingAuraFlow", "KSampler",
        "CLIPTextEncode", "TextEncodeQwenImageEditPlus", "EmptySD3LatentImage", "VAEDecode", "SaveImage", "LoadImage"]) {
        nodes[n] = { input: { required: {} } };
      }
      return json(200, nodes);
    }

    if (path === "/prompt" && req.method === "POST") {
      let graph;
      try {
        graph = JSON.parse(raw.toString("utf8")).prompt;
      } catch {
        return json(400, { error: "invalid json" });
      }
      if (!graph || typeof graph !== "object") return json(400, { error: "missing prompt graph" });

      seen.prompts.push(graph);
      const problems = [];

      // 必需节点齐全
      for (const n of ["unet", "clip", "vae", "ms", "neg", "lat", "ks", "dec", "save", "pos"]) {
        if (!graph[n]) problems.push(`missing node ${n}`);
      }
      // KSampler 的连线必须指向真实存在的节点
      for (const [k, v] of Object.entries(graph.ks?.inputs ?? {})) {
        if (Array.isArray(v) && !graph[v[0]]) problems.push(`KSampler.${k} -> unknown node ${v[0]}`);
      }
      if (graph.ks?.inputs?.sampler_name !== "euler") problems.push("sampler_name != euler");
      if (graph.ks?.inputs?.scheduler !== "simple") problems.push("scheduler != simple");
      if (graph.ms?.inputs?.sampling !== "flow") problems.push("ModelSamplingAuraFlow.sampling != flow");
      if (!Number.isFinite(graph.lat?.inputs?.width) || !Number.isFinite(graph.lat?.inputs?.height)) {
        problems.push("latent width/height not numeric");
      }
      if (graph.dec?.inputs?.vae?.[0] !== "vae") problems.push("VAEDecode.vae not wired to vae node");

      // 有参考图 → TextEncodeQwenImageEditPlus + refN LoadImage
      const refs = Object.keys(graph).filter((k) => /^ref\d+$/.test(k));
      if (refs.length) {
        if (graph.pos.class_type !== "TextEncodeQwenImageEditPlus") problems.push("refs require TextEncodeQwenImageEditPlus");
        refs.forEach((r, i) => {
          if (graph[r].class_type !== "LoadImage") problems.push(`${r} is not LoadImage`);
          if (typeof graph[r].inputs?.image !== "string" || !graph[r].inputs.image) problems.push(`${r} has no image name`);
          if (!graph.pos.inputs?.[`image${i + 1}`]) problems.push(`pos missing image${i + 1}`);
        });
      } else if (graph.pos.class_type !== "CLIPTextEncode") {
        problems.push("text-to-image requires CLIPTextEncode");
      }

      if (problems.length) {
        seen.problems = problems;
        return json(400, { error: `bad workflow: ${problems.join("; ")}` });
      }
      seen.problems = null;
      return json(200, { prompt_id: "mock-prompt-1", number: 0, node_errors: {} });
    }

    if (path.startsWith("/history/") && req.method === "GET") {
      seen.polls += 1;
      // 奇数次返回空（排队中），偶数次返回完成
      if (seen.polls % 2 !== 0) return json(200, {});
      return json(200, {
        "mock-prompt-1": {
          status: { status_str: "success", completed: true },
          outputs: {
            save: { images: [{ filename: "toonflow/qwen_00001_.png", subfolder: "toonflow", type: "output" }] },
          },
        },
      });
    }

    if (path === "/view" && req.method === "GET") {
      seen.viewQuery = Object.fromEntries(new URLSearchParams(url.split("?")[1] ?? ""));
      if (!seen.viewQuery.filename) return json(400, { error: "missing filename" });
      return json(200, PNG.solid(64, 96, [180, 200, 240]), { "Content-Type": "image/png" });
    }

    json(404, { error: `mock comfy: no route ${req.method} ${path}` });
  });
});

// 仅当直接运行时才监听，供 import 复用
if (import.meta.main) {
  server.listen(PORT, "127.0.0.1", () => console.log(`MOCK COMFY LISTENING ${PORT}`));
  process.on("SIGTERM", () => process.exit(0));
  process.on("SIGINT", () => process.exit(0));
}

export const close = () => new Promise((r) => server.close(r));
export const listen = (port = PORT) => new Promise((r) => server.listen(port, "127.0.0.1", r));
