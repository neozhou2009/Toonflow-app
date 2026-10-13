/**
 * ComfyUI 本地供应商（Toonflow）
 * ---------------------------------------------------------------------------
 * 直接对接本地 ComfyUI HTTP API，把 Qwen-Image 生成能力接进 Toonflow。
 *
 * 已验证的调用路径（来自项目内 character-refs skill 的 Qt 实现）：
 *   POST /upload/image   ← 参考图上传（multipart: image / subfolder / type / overwrite）
 *   POST /prompt         ← { prompt: <workflow graph> } 提交
 *   GET  /history/{id}   ← 轮询，读 status.status_str 与 outputs.<saveNode>.images
 *   GET  /view?filename=…&subfolder=…&type=…  ← 取图字节
 *
 * 工作流节点（Qwen-Image / Qwen-Image-Edit-Plus）：
 *   UNETLoader + CLIPLoader(type=qwen_image) + VAELoader + ModelSamplingAuraFlow
 *   KSampler(euler/simple) + EmptySD3LatentImage
 *   文生图 → CLIPTextEncode；带参考图 → TextEncodeQwenImageEditPlus
 *   VAEDecode + SaveImage
 *
 * 说明：模型文件名、CLIP 名称、steps、cfg、shift 都做成「表单字段」，
 *       在 Toonflow 页面里直接填，无需改代码即可适配别的 ComfyUI 安装。
 */

const rules = [
  {
    type: "input",
    field: "baseUrl",
    title: "ComfyUI 地址",
    value: "http://192.168.1.76:8188",
    props: { placeholder: "http://192.168.1.76:8188" },
  },
  {
    type: "input",
    field: "unet",
    title: "UNet 模型文件名",
    value: "qwen_image_2.1.int8_convrot.safetensors",
    props: { placeholder: "models/unet/ 下的文件名" },
  },
  {
    type: "input",
    field: "clip",
    title: "CLIP 模型文件名",
    value: "qwen3vl_8b_int8_convrot.safetensors",
    props: { placeholder: "models/clip/ 下的文件名" },
  },
  {
    type: "input",
    field: "vae",
    title: "VAE 模型文件名",
    value: "qwen_image_2.1_vae_bf16.safetensors",
    props: { placeholder: "models/vae/ 下的文件名" },
  },
  {
    type: "input",
    field: "shift",
    title: "ModelSampling shift",
    value: "3.1",
    props: { placeholder: "3.1" },
  },
  {
    type: "input",
    field: "steps",
    title: "采样步数",
    value: "20",
    props: { placeholder: "20" },
  },
  {
    type: "input",
    field: "cfg",
    title: "CFG",
    value: "2.5",
    props: { placeholder: "2.5" },
  },
  {
    type: "input",
    field: "username",
    title: "Basic 认证用户名（可选）",
    value: "",
    props: { placeholder: "留空表示不需要认证" },
  },
  {
    type: "input",
    field: "password",
    title: "Basic 认证密码（可选）",
    value: "",
    props: { type: "password", showPassword: true, autocomplete: "off" },
  },
] as const;

const version = "1.0.0";

/** 宽高比 → [宽, 高]，与 character-refs skill 的 QWEN_SIZES 保持一致。 */
const QWEN_SIZES: Record<string, [number, number]> = {
  "2:3": [1056, 1584],
  "4:5": [1152, 1440],
  "1:1": [1328, 1328],
  "3:4": [1120, 1472],
  "4:3": [1472, 1120],
  "3:2": [1536, 1024],
  "16:9": [1536, 864],
  "9:16": [864, 1536],
};

function parseNumber(value: string | undefined, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function basicAuth(username: string | undefined, password: string | undefined): Record<string, string> {
  if (!username && !password) return {};
  return { Authorization: `Basic ${Buffer.from(`${username ?? ""}:${password ?? ""}`).toString("base64")}` };
}

/** mediaUrl：把 MediaInput 统一转成 ComfyUI 能吃的 base64 data URL（不带 data: 前缀也兼容 TextEncodeQwenImageEditPlus）。 */
function mediaUrl(input: MediaInput) {
  if (input.type === "url") return input.url;
  const data = input.type === "binary" ? Buffer.from(input.data).toString("base64") : input.data;
  const mime = input.mimeType || "image/png";
  return data.startsWith("data:") ? data : `data:${mime};base64,${data}`;
}

async function comfyFetch(
  context: ProviderContext,
  path: string,
  init: RequestInit = {},
  timeoutMs = 600_000,
): Promise<Response> {
  const baseUrl = (context.config.baseUrl?.trim() || "http://192.168.1.76:8188").replace(/\/+$/, "");
  const signal = AbortSignal.any([AbortSignal.timeout(timeoutMs), ...(context.signal ? [context.signal] : [])]);
  return context.tool.fetch(`${baseUrl}${path}`, {
    ...init,
    signal,
    headers: { ...basicAuth(context.config.username, context.config.password), ...(init.headers ?? {}) },
  });
}

function pickSize(ratio: string | undefined, size: string | undefined): [number, number] {
  // 优先按 ratio 映射；其次解析 "1024x1024"；最后用 Qwen 原生 1:1。
  if (size && size.includes("x")) {
    const [w, h] = size.split("x").map((v) => Number(v.trim()));
    if (Number.isFinite(w) && Number.isFinite(h) && w > 0 && h > 0) return [w, h];
  }
  const key = (ratio ?? "1:1").trim();
  return QWEN_SIZES[key] ?? QWEN_SIZES["1:1"];
}

/** 把 Qwen-Image 图生图/参考图工作流组装成 ComfyUI prompt graph。 */
function buildWorkflow(
  config: Record<string, unknown>,
  prompt: string,
  negative: string,
  width: number,
  height: number,
  seed: number,
  refImages: string[],
): Record<string, unknown> {
  const unet = String(config.unet || "qwen_image_2.1.int8_convrot.safetensors");
  const clip = String(config.clip || "qwen3vl_8b_int8_convrot.safetensors");
  const vae = String(config.vae || "qwen_image_2.1_vae_bf16.safetensors");
  const steps = parseNumber(config.steps as string | undefined, 20);
  const cfg = parseNumber(config.cfg as string | undefined, 2.5);
  const shift = parseNumber(config.shift as string | undefined, 3.1);

  const graph: Record<string, unknown> = {
    unet: { class_type: "UNETLoader", inputs: { unet_name: unet, weight_dtype: "default" } },
    clip: { class_type: "CLIPLoader", inputs: { clip_name: clip, type: "qwen_image", device: "default" } },
    vae: { class_type: "VAELoader", inputs: { vae_name: vae } },
    ms: { class_type: "ModelSamplingAuraFlow", inputs: { model: ["unet", 0], shift, sampling: "flow" } },
    neg: { class_type: "CLIPTextEncode", inputs: { clip: ["clip", 0], text: negative } },
    lat: { class_type: "EmptySD3LatentImage", inputs: { width, height, batch_size: 1 } },
    ks: {
      class_type: "KSampler",
      inputs: {
        model: ["ms", 0],
        positive: ["pos", 0],
        negative: ["neg", 0],
        latent_image: ["lat", 0],
        seed,
        steps,
        cfg,
        sampler_name: "euler",
        scheduler: "simple",
        denoise: 1.0,
      },
    },
    dec: { class_type: "VAEDecode", inputs: { samples: ["ks", 0], vae: ["vae", 0] } },
    save: { class_type: "SaveImage", inputs: { images: ["dec", 0], filename_prefix: "toonflow/qwen" } },
  };

  if (!refImages.length) {
    graph.pos = { class_type: "CLIPTextEncode", inputs: { clip: ["clip", 0], text: prompt } };
  } else {
    // TextEncodeQwenImageEditPlus 的约定：clip/vae + prompt + image1..imageN（控件名称即 imageN）。
    const enc: Record<string, unknown> = { clip: ["clip", 0], vae: ["vae", 0], prompt };
    refImages.forEach((name, i) => {
      graph[`ref${i + 1}`] = { class_type: "LoadImage", inputs: { image: name } };
      enc[`image${i + 1}`] = [`ref${i + 1}`, 0];
    });
    graph.pos = { class_type: "TextEncodeQwenImageEditPlus", inputs: enc };
  }
  return graph;
}

/** 把二进制参考图上传到 ComfyUI input/ 目录，返回给 LoadImage 用的名字。 */
async function uploadReference(context: ProviderContext, input: MediaInput): Promise<string> {
  const bytes = input.type === "binary" ? input.data : Buffer.from(mediaUrl(input).split(",")[1] ?? "", "base64");
  if (!bytes.length) throw new Error("参考图为空");
  const ext = (input.mimeType || "image/png").split("/")[1] || "png";
  const mimeType = input.mimeType || "image/png";
  // ACT: 宿主运行时不保证有 FormData / File（内置供应商同样手写 multipart），这里按 API 协议手工拼装。
  const boundary = `----toonflow${Date.now().toString(16)}${Math.random().toString(16).slice(2)}`;
  const text = (name: string, value: string) =>
    `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`;
  const body = new Blob([
    text("subfolder", "toonflow"),
    text("type", "input"),
    text("overwrite", "true"),
    `--${boundary}\r\nContent-Disposition: form-data; name="image"; filename="ref.${ext}"\r\nContent-Type: ${mimeType}\r\n\r\n`,
    new Uint8Array(bytes),
    `\r\n--${boundary}--\r\n`,
  ]);
  const response = await comfyFetch(context, "/upload/image", {
    method: "POST",
    headers: { "Content-Type": `multipart/form-data; boundary=${boundary}` },
    body,
  });
  if (!response.ok) throw new Error(`参考图上传失败：HTTP ${response.status} ${await context.tool.errorMessage(await response.text().catch(() => ""))}`);
  const result = (await response.json()) as { name?: string; subfolder?: string };
  if (!result.name) throw new Error("参考图上传未返回文件名");
  return result.subfolder ? `${result.subfolder}/${result.name}` : result.name;
}

/** 提交 → 轮询 history → 取图。 */
async function runComfy(context: ProviderContext, graph: Record<string, unknown>): Promise<MediaAsset[]> {
  const submit = await comfyFetch(context, "/prompt", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ prompt: graph }),
  });
  if (!submit.ok) throw new Error(`提交任务失败：HTTP ${submit.status} ${await context.tool.errorMessage(await submit.text().catch(() => ""))}`);
  const { prompt_id: promptId } = (await submit.json()) as { prompt_id?: string };
  if (!promptId) throw new Error("ComfyUI 未返回 prompt_id");

  const deadline = Date.now() + 15 * 60_000;
  let image: { filename: string; subfolder?: string; type?: string } | undefined;
  while (!image) {
    if (Date.now() > deadline) throw new Error("ComfyUI 等待超时（15 分钟）");
    await new Promise((ok) => setTimeout(ok, 3000));
    const historyResponse = await comfyFetch(context, `/history/${encodeURIComponent(promptId)}`);
    if (!historyResponse.ok) continue;
    const history = (await historyResponse.json()) as Record<string, {
      status?: { status_str?: string; messages?: [string, Record<string, unknown>][] };
      outputs?: Record<string, { images?: { filename: string; subfolder?: string; type?: string }[] }>;
    }>;
    const entry = history[promptId];
    if (!entry) continue;
    if (entry.status?.status_str === "error") {
      const message = entry.status.messages?.find((m) => m[0] === "execution_error");
      throw new Error(`ComfyUI 执行出错：${(message?.[1] as { exception_message?: string })?.exception_message ?? "未知错误"}`);
    }
    for (const output of Object.values(entry.outputs ?? {})) {
      const found = output.images?.[0];
      if (found?.filename) {
        image = found;
        break;
      }
    }
  }

  const query = new URLSearchParams({
    filename: image.filename,
    subfolder: image.subfolder ?? "",
    type: image.type ?? "output",
  });
  const view = await comfyFetch(context, `/view?${query.toString()}`, {}, 600_000);
  if (!view.ok) throw new Error(`取图失败：HTTP ${view.status}`);
  const buffer = Buffer.from(await view.arrayBuffer());
  const mimeType = view.headers.get("content-type") || "image/png";
  return [{ mediaType: "image", type: "binary", data: new Uint8Array(buffer), mimeType }];
}

export default {
  id: "comfyui",
  label: "本地 ComfyUI",
  version,
  readme: `本地 ComfyUI 供应商：把自建 ComfyUI 实例的 Qwen-Image 能力接入 Toonflow。
无需 API Key，在图生图与参考图模式下会把参考图先上传到 ComfyUI 的 input 目录。
**请确认上面填的模型文件名与 ComfyUI 中 models/unet、models/clip、models/vae 下的实际文件一致。**
文生图与参考图都已实测可用；视频生成需工作流另行适配，本供应商暂不提供。`,
  rules,
  models: [
    {
      id: "qwen-image",
      label: "Qwen-Image（本地）",
      type: "image",
      // ACT: imageRatios 必须是 JSON 字面量（Toonflow 用 Babel AST 静态解析），与 QWEN_SIZES 保持一致。
      mode: ["text", "singleImage", "multiReference"],
      imageRatios: ["1:1", "2:3", "3:4", "4:5", "4:3", "3:2", "16:9", "9:16"],
    },
  ] satisfies ProviderModel[],
  async generateImage(request: ImageRequest): Promise<MediaAsset[]> {
    const baseUrl = (this.config.baseUrl?.trim() || "").replace(/\/+$/, "");
    if (!baseUrl) throw new Error("请填写 ComfyUI 地址");

    // 连通性预检：顺手暴露配置错误，避免提交后才失败。
    const probe = await comfyFetch(this, "/system_stats", {}, 30_000);
    if (!probe.ok) throw new Error(`无法连接 ComfyUI：HTTP ${probe.status}`);

    const refImages: string[] = [];
    for (const image of request.images ?? []) refImages.push(await uploadReference(this, image));
    if (request.mask) refImages.push(await uploadReference(this, request.mask));

    const [width, height] = pickSize(request.ratio, request.size);
    const count = Math.min(Math.max(request.n ?? 1, 1), 4);
    const negative = (request.other?.negative as string | undefined) ?? "";
    const results: MediaAsset[] = [];
    for (let i = 0; i < count; i += 1) {
      const seed = Number(request.other?.seed ?? 0) || (Date.now() % 2 ** 32) + i;
      const graph = buildWorkflow(this.config, request.prompt, negative, width, height, seed, refImages);
      results.push(...(await runComfy(this, graph)));
    }
    return results;
  },
} satisfies ProviderDefinition<typeof rules>;
