#!/bin/bash
# 端到端自测：经 Toonflow 自己的 /api/providers/debug/run 跑 comfyui 供应商
# 这条路径会：载入供应商源码 → 校验 → 调 generateImage → 逐条回传 HTTP 请求轨迹
#
# 用法：
#   bash e2e-debug-run.sh                                   # 用内置假 ComfyUI
#   COMFY_URL=http://192.168.1.76:8188 bash e2e-debug-run.sh # 打你真实的 ComfyUI
# 需要 build/ 已构建，且 bun 在 PATH 中。
export BUN_INSTALL=/tmp/bun PATH="/tmp/bun/bin:$PATH" TMPDIR=/tmp NODE_ENV=production
export TOONFLOW_DATA_DIR=/tmp/Toonflow-app/data
APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
B=http://127.0.0.1:3000
LOG=/tmp/e2e-debugrun.log; : > $LOG
cd "$APP_DIR"

# 1) ComfyUI：默认起假服务；给了 COMFY_URL 就直接打真实的
COMFY_URL="${COMFY_URL:-http://127.0.0.1:18188}"
MOCK=""
if [ -z "${COMFY_URL_IS_CUSTOM:-}" ] && [ "$COMFY_URL" = "http://127.0.0.1:18188" ]; then
  bun dev-tools/mock-standalone.mjs > /tmp/mock.log 2>&1 &
  MOCK=$!
  for i in $(seq 1 40); do curl -s -o /dev/null http://127.0.0.1:18188/system_stats && break; sleep 0.5; done
  echo "mock: $(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:18188/system_stats)" >> $LOG
else
  echo "target: $COMFY_URL -> $(curl -s -o /dev/null -w '%{http_code}' --max-time 5 "$COMFY_URL/system_stats" 2>/dev/null)" >> $LOG
fi

# 2) Toonflow 服务
bun build/server/index.js > /tmp/server5.log 2>&1 &
SRV=$!
for i in $(seq 1 40); do curl -s -o /dev/null $B/ && break; sleep 1; done
echo "toonflow: $(curl -s -o /dev/null -w '%{http_code}' $B/)" >> $LOG

# 3) 组装请求体
python3 - > /tmp/debugreq.json <<'PY'
import json, base64, zlib, struct, os

def png_solid(w, h, rgb):
    def chunk(t, d):
        c = 0xFFFFFFFF
        for b in d: c ^= b
        return None
    # 用 1x1 拉伸交给 ComfyUI 也无妨——这里只验证协议，故用极简 PNG
    raw = b""
    sig = b"\x89PNG\r\n\x1a\n"
    ihdr = struct.pack(">IIBBBBB", w, h, 8, 2, 0, 0, 0)
    def crc(b):
        c = 0xFFFFFFFF
        for x in b:
            c ^= x
            for _ in range(8): c = (c >> 1) ^ (0xEDB88320 & -(c & 1))
        return c ^ 0xFFFFFFFF
    def ch(t, d): return struct.pack(">I", len(d)) + t + d + struct.pack(">I", crc(t + d))
    rows = b""
    for y in range(h):
        rows += b"\x00" + bytes(rgb) * w
    co = zlib.compress(rows, 9)
    return sig + ch(b"IHDR", ihdr) + ch(b"IDAT", co) + ch(b"IEND", b"")

src = open('/tmp/Toonflow-app/packages/providers/src/media/comfyui.ts', encoding='utf8').read()
b64 = base64.b64encode(png_solid(64, 64, (240,240,240))).decode()
body = {
  "source": src,
  "config": {
    "baseUrl": os.environ.get("COMFY_URL", "http://127.0.0.1:18188"),
    "unet": "qwen_image_2.1_int8_convrot.safetensors",
    "clip": "qwen3vl_8b_int8_convrot.safetensors",
    "vae": "qwen_image_2.1_vae_bf16.safetensors",
    "shift": "3.1", "steps": "20", "cfg": "2.5",
    "username": "", "password": "",
  },
  "request": {
    "model": "qwen-image",
    "prompt": "a young woman in a 1920s Jiangnan tea field, cinematic",
    "ratio": "2:3",
    "images": [{"type": "base64", "data": b64, "mimeType": "image/png", "name": "ref.png"}],
  },
}
print(json.dumps(body))
PY

# 4) 调用 debug/run（NDJSON 流）
curl -s --max-time 90 -N -X POST "$B/api/providers/debug/run" \
  -H 'Content-Type: application/json' -H 'Origin: http://127.0.0.1:3000' \
  --data-binary @/tmp/debugreq.json > /tmp/debugout.ndjson
echo "### ndjson lines: $(wc -l < /tmp/debugout.ndjson)" >> $LOG
echo "### event types:" >> $LOG
python3 -c "
import json
types={}
for line in open('/tmp/debugout.ndjson'):
    line=line.strip()
    if not line: continue
    try: e=json.loads(line)
    except: types['<unparsable>']=types.get('<unparsable>',0)+1; continue
    t=e.get('type','?'); types[t]=types.get(t,0)+1
for k,v in types.items(): print('  ',k,v)
" >> $LOG

echo "### 请求轨迹（Toonflow 记下的对 ComfyUI 的调用）" >> $LOG
COMFY_URL="$COMFY_URL" python3 -c "
import json, os
CFG=os.environ.get('COMFY_URL','http://127.0.0.1:18188')
for line in open('/tmp/debugout.ndjson'):
    line=line.strip()
    if not line: continue
    try: e=json.loads(line)
    except: continue
    if e.get('type')=='log':
        l=e['log']
        st=l.get('state') or l.get('status') or ''
        print('   #%s %s %s [%s]' % (l.get('id'), l.get('method'), l.get('url','').replace(CFG,''), st))
" >> $LOG

echo "### 最终结果" >> $LOG
python3 -c "
import json
last=None
for line in open('/tmp/debugout.ndjson'):
    line=line.strip()
    if not line: continue
    try: e=json.loads(line)
    except: continue
    if e.get('type') in ('done','result','error','fail'): last=e
print('   ', json.dumps(last,ensure_ascii=False)[:600] if last else '(no terminal event)')
" >> $LOG

echo "### mock 实际收到的请求" >> $LOG
python3 -c "
import json
seen=json.load(open('/tmp/mock-seen.json')) if False else None
" 2>/dev/null
grep -o 'prompt_id[^,}]*' /tmp/debugout.ndjson | head -3 >> $LOG

kill $SRV 2>/dev/null; [ -n "$MOCK" ] && kill $MOCK 2>/dev/null; pkill -f mock-standalone 2>/dev/null; sleep 1; echo DONE >> $LOG
cat $LOG
