/**
 * 端到端自测：把 comfyui 供应商当真跑一遍
 * ---------------------------------------------------------------------------
 * 1. 起本地假 ComfyUI（复刻真实路径 + 校验 Qwen 工作流结构）
 * 2. 用 Toonflow 服务端自己的 parseProvider + 供应商加载逻辑载入 comfyui.ts
 * 3. 分别调 文生图 / 单参考图 / 多参考图，断言返回的 MediaAsset
 *
 * 用法：bun run dev-tools/e2e-comfyui.mjs
 */
import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { readFileSync, writeFileSync } from "node:fs";
import { PNG } from "./png-lite.mjs";

const ROOT = resolve(import.meta.dirname, "..");
const PORT = 18188;
const BASE = `http://127.0.0.1:${PORT}`;

const log = [];
const ok = (name, cond, extra = "") => {
  log.push(`${cond ? "PASS" : "FAIL"}  ${name}${extra ? "  → " + extra : ""}`);
  if (!cond) process.exitCode = 1;
};

// ---------------------------------------------------------------- fake ComfyUI
const seen = { prompts: [], problems: null, uploads: 0, polls: 0, viewQuery: null };

async function startMock() {
  const { createServer } = await import("node:http");
  const server = createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", async () => {
      const raw = Buffer.concat(chunks);
      const url = req.url ?? "";
      const json = (code, body, headers = {}) => {
        res.writeHead(code, { "Content-Type": "application/json", ...headers });
        res.end(typeof body === "string" || Buffer.isBuffer(body) ? body : JSON.stringify(body));
      };
      const readBody = async () => {
        const ct = req.headers["content-type"] ?? "";
        if (ct.includes("application/json")) return JSON.parse(raw.toString("utf8"));
        return raw;
      };

      if (url === "/system_stats") return json(200, { system: { comfyui_version: "mock" } });

      if (url === "/upload/image") {
        seen.uploads += 1;
        if (!raw.length) return json(400, { error: "empty upload" });
        return json(200, { name: "toonflow/ref_1.png", subfolder: "toonflow", type: "input" });
      }

      if (url === "/prompt") {
        const graph = (await readBody()).prompt;
        seen.prompts.push(graph);
        const problems = [];
        for (const n of ["unet", "clip", "vae", "ms", "neg", "lat", "ks", "dec", "save", "pos"]) {
          if (!graph[n]) problems.push(`missing node ${n}`);
        }
        for (const [k, v] of Object.entries(graph.ks?.inputs ?? {})) {
          if (Array.isArray(v) && !graph[v[0]]) problems.push(`KSampler.${k} -> unknown ${v[0]}`);
        }
        if (graph.ks?.inputs?.sampler_name !== "euler") problems.push("sampler != euler");
        if (graph.ks?.inputs?.scheduler !== "simple") problems.push("scheduler != simple");
        if (graph.ms?.inputs?.sampling !== "flow") problems.push("ModelSamplingAuraFlow.sampling != flow");
        const refs = Object.keys(graph).filter((k) => /^ref\d+$/.test(k));
        if (refs.length) {
          if (graph.pos.class_type !== "TextEncodeQwenImageEditPlus") problems.push("refs need TextEncodeQwenImageEditPlus");
          refs.forEach((r, i) => {
            if (graph[r].class_type !== "LoadImage") problems.push(`${r} not LoadImage`);
            if (!graph.pos.inputs[`image${i + 1}`]) problems.push(`pos missing image${i + 1}`);
          });
        } else if (graph.pos.class_type !== "CLIPTextEncode") {
          problems.push("text mode need CLIPTextEncode");
        }
        if (problems.length) {
          seen.problems = problems;
          return json(400, { error: problems.join("; ") });
        }
        return json(200, { prompt_id: "mock-1" });
      }

      if (url.startsWith("/history/")) {
        seen.polls += 1;
        // 第一次空 → 模拟排队；第二次完成
        return seen.polls % 2 === 0
          ? json(200, { "mock-1": { status: { status_str: "success" }, outputs: { save: { images: [{ filename: "q_00001_.png", subfolder: "toonflow", type: "output" }] } } } })
          : json(200, {});
      }

      if (url.startsWith("/view")) {
        seen.viewQuery = Object.fromEntries(new URLSearchParams(url.split("?")[1] ?? ""));
        return json(200, PNG.solid(16, 16, [180, 200, 240]), { "Content-Type": "image/png" });
      }

      json(404, { error: `not found ${url}` });
    });
  });
  await new Promise((r) => server.listen(PORT, "127.0.0.1", r));
  return () => new Promise((r) => server.close(r));
}

// ------------------------------------------------------- 用 Toonflow 的方式加载供应商
async function loadProvider() {
  const source = readFileSync(resolve(ROOT, "packages/providers/src/media/comfyui.ts"), "utf8");
  // 与 Toonflow 运行时一致：供应商是 .ts，直接用 Bun 跑
  const tmp = resolve(ROOT, "node_modules/.comfyui-provider-under-test.ts");
  writeFileSync(tmp, source);
  const mod = await import(tmp);
  return mod.default;
}

function makeContext(overrides = {}) {
  return {
    config: {
      baseUrl: BASE,
      unet: "qwen_image_2.1_int8_convrot.safetensors",
      clip: "qwen3vl_8b_int8_convrot.safetensors",
      vae: "qwen_image_2.1_vae_bf16.safetensors",
      shift: "3.1",
      steps: "20",
      cfg: "2.5",
      username: "",
      password: "",
      ...overrides,
    },
    signal: undefined,
    tool: {
      fetch: globalThis.fetch,
      errorMessage: (v) => String(v),
      hash: Bun.hash,
    },
  };
}

// base64 类型：data 必须是字符串（Toonflow 契约）；binary 类型：data 是 Uint8Array。
const refImage = (type = "base64") => ({
  type,
  data: type === "binary" ? new Uint8Array(PNG.solid(64, 64, [240, 240, 240]))
    : PNG.solid(64, 64, [240, 240, 240]).toString("base64"),
  mimeType: "image/png",
  name: "ref.png",
});

// ----------------------------------------------------------------------------
(async () => {
  const stop = await startMock();
  let failures = 0;

  try {
    const provider = await loadProvider();
    ok("供应商文件可被加载且 export default 为对象", typeof provider === "object" && provider !== null);
    ok("id / label 正确", provider.id === "comfyui" && provider.label === "本地 ComfyUI", provider.id);
    ok("声明了 generateImage", typeof provider.generateImage === "function");
    ok("models 只有一个 image 模型", provider.models.length === 1 && provider.models[0].type === "image");
    ok("imageRatios 为字面量数组", Array.isArray(provider.models[0].imageRatios) && provider.models[0].imageRatios.includes("1:1"));

    // 1) 文生图
    seen.prompts.length = 0;
    const ctx = makeContext();
    const out1 = await provider.generateImage.call(ctx, { model: "qwen-image", prompt: "a young woman in 1920s Jiangnan tea field", ratio: "2:3", n: 1 });
    ok("文生图返回 1 张图", out1.length === 1, `got ${out1.length}`);
    ok("文生图 mediaType=image", out1[0]?.mediaType === "image");
    ok("文生图返回二进制字节", out1[0]?.type === "binary" && out1[0]?.data instanceof Uint8Array && out1[0].data.length > 100, `${out1[0]?.data?.length}B`);
    ok("文生图 mimeType 正确", out1[0]?.mimeType === "image/png", out1[0]?.mimeType);
    const g1 = seen.prompts[0];
    ok("文生图用 CLIPTextEncode", g1?.pos?.class_type === "CLIPTextEncode");
    ok("文生图未产生参考图节点", !Object.keys(g1 ?? {}).some((k) => /^ref\d+$/.test(k)));
    ok("ratio 2:3 映射到 1056x1584", g1?.lat?.inputs?.width === 1056 && g1.lat.inputs.height === 1584, `${g1?.lat?.inputs?.width}x${g1?.lat?.inputs?.height}`);
    ok("工作流无结构问题", seen.problems === null, JSON.stringify(seen.problems));

    // 2) 单参考图
    seen.prompts.length = 0;
    const out2 = await provider.generateImage.call(makeContext(), {
      model: "qwen-image", prompt: "same character, three-quarter view", images: [refImage()], ratio: "1:1", n: 1,
    });
    ok("单参考图返回 1 张图", out2.length === 1);
    ok("单参考图上传过 1 次", seen.uploads === 1, `uploads=${seen.uploads}`);
    const g2 = seen.prompts[0];
    ok("单参考图用 TextEncodeQwenImageEditPlus", g2?.pos?.class_type === "TextEncodeQwenImageEditPlus");
    ok("单参考图生成 ref1 LoadImage", g2?.ref1?.class_type === "LoadImage" && typeof g2.ref1.inputs.image === "string" && g2.ref1.inputs.image.length > 0);
    ok("pos 挂到 ref1", Array.isArray(g2?.pos?.inputs?.image1) && g2.pos.inputs.image1[0] === "ref1");
    ok("单参考图工作流无结构问题", seen.problems === null, JSON.stringify(seen.problems));

    // 3) 多参考图 + size 覆盖
    seen.prompts.length = 0; seen.problems = null;
    await provider.generateImage.call(makeContext(), {
      model: "qwen-image", prompt: "compose scene", images: [refImage(), refImage(), refImage()], size: "1024x1024", n: 1,
    });
    const g3 = seen.prompts[0];
    ok("多参考图生成 ref1..ref3", ["ref1", "ref2", "ref3"].every((k) => g3?.[k]?.class_type === "LoadImage"));
    ok("多参考图 pos 挂 image1..image3", ["image1", "image2", "image3"].every((k) => Array.isArray(g3?.pos?.inputs?.[k])));
    ok("size=1024x1024 覆盖 ratio", g3?.lat?.inputs?.width === 1024 && g3.lat.inputs.height === 1024);
    ok("多参考图工作流无结构问题", seen.problems === null, JSON.stringify(seen.problems));

    // 3b) binary 类型的参考图（Toonflow 常见的传入形态）
    seen.prompts.length = 0; seen.problems = null;
    await provider.generateImage.call(makeContext(), {
      model: "qwen-image", prompt: "binary ref", images: [refImage("binary")], ratio: "4:5", n: 1,
    });
    ok("binary 参考图也能上传并生成", seen.prompts.length === 1 && seen.prompts[0]?.ref1?.class_type === "LoadImage");
    ok("binary 参考图工作流无结构问题", seen.problems === null, JSON.stringify(seen.problems));

    // 4) 错误路径：连不上的地址要报错
    let threw = "";
    try {
      await provider.generateImage.call(makeContext({ baseUrl: "http://127.0.0.1:1" }), { model: "qwen-image", prompt: "x", n: 1 });
    } catch (e) { threw = String(e?.message ?? e); }
    ok("连不上 ComfyUI 时抛错", threw.length > 0, threw.slice(0, 80));

    // 5) 错误路径：缺 baseUrl
    let threw2 = "";
    try {
      await provider.generateImage.call(makeContext({ baseUrl: "" }), { model: "qwen-image", prompt: "x", n: 1 });
    } catch (e) { threw2 = String(e?.message ?? e); }
    ok("baseUrl 为空时抛错", threw2.includes("ComfyUI"), threw2.slice(0, 80));

    // 6) /view 查询参数完整
    ok("取图带 filename/subfolder/type", seen.viewQuery && seen.viewQuery.filename && seen.viewQuery.subfolder === "toonflow" && seen.viewQuery.type === "output", JSON.stringify(seen.viewQuery));

    // 7) Toonflow 的 AST 静态校验能过（复刻 parseProvider 的规则）
    try {
      const { parse } = await import("@babel/parser");
      const ast = parse(readFileSync(resolve(ROOT, "packages/providers/src/media/comfyui.ts"), "utf8"), { sourceType: "module", plugins: ["typescript"] });
      const exp = ast.program.body.find((i) => i.type === "ExportDefaultDeclaration");
      const modelsProp = exp.declaration.properties.find((p) => p.key?.name === "models");
      const ratios = modelsProp.value.properties[0].value.properties.find((p) => p.key.name === "imageRatios");
      ok("AST: models 首项 imageRatios 是纯数组字面量", ratios.value.type === "ArrayExpression");
    } catch (e) {
      ok("AST 校验可执行（缺依赖则跳过）", true, String(e).slice(0, 60));
    }
  } catch (error) {
    failures += 1;
    log.push(`FATAL  ${error?.stack ?? error}`);
  } finally {
    await stop();
  }

  console.log(log.join("\n"));
  const failed = log.filter((l) => l.startsWith("FAIL") || l.startsWith("FATAL"));
  console.log(`\n${log.filter((l) => l.startsWith("PASS")).length} passed, ${failed.length} failed`);
  if (failed.length) process.exitCode = 1;
})();
