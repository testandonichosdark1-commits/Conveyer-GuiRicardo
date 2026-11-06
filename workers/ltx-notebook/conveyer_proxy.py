"""Token-checking proxy between the public tunnel and the notebook's ComfyUI.

ComfyUI has no authentication and listens on 127.0.0.1 only. This proxy is the one
thing the Cloudflare tunnel exposes: every request needs `Authorization: Bearer <token>`,
and only the six routes Conveyer's animateLtxScene uses are forwarded — no /api,
no custom-node routes, no websocket, no file browsing.

Runs inside the notebook (embedded into conveyer_ltx_notebook.ipynb by build_notebook.py).
Uses aiohttp, which ComfyUI already installs.

Env: CONVEYER_TOKEN (required), COMFY_URL, PROXY_PORT, MODELS_DIR, MODELS_JSON,
CONVEYER_PROFILE ("full" = LTX 22B, "lite" = LTX-Video 2B for a 16 GB T4).
"""
import hmac
import json
import os
import re

from aiohttp import ClientSession, ClientTimeout, web

TOKEN = os.environ["CONVEYER_TOKEN"]
COMFY = os.environ.get("COMFY_URL", "http://127.0.0.1:8188").rstrip("/")
PORT = int(os.environ.get("PROXY_PORT", "8189"))
MODELS_DIR = os.environ.get("MODELS_DIR", "ComfyUI/models")
MODELS_JSON = os.environ.get("MODELS_JSON", "models.json")
PROFILE = "lite" if os.environ.get("CONVEYER_PROFILE") == "lite" else "full"
VERIFIED_MARKER = ".conveyer-sha256-ok"

PROMPT_ID = re.compile(r"^[a-zA-Z0-9_-]{1,100}$")
MAX_UPLOAD = 25 * 1024 * 1024
MAX_PROMPT = 2 * 1024 * 1024


def authorized(request: web.Request) -> bool:
    header = request.headers.get("Authorization", "")
    return header.startswith("Bearer ") and hmac.compare_digest(header[7:].encode(), TOKEN.encode())


def missing_models() -> list:
    with open(MODELS_JSON) as fh:
        files = json.load(fh)["files"]
    missing = []
    for item in files:
        target = os.path.join(MODELS_DIR, item["path"])
        marker = target + VERIFIED_MARKER
        if not os.path.isfile(target) or os.path.getsize(target) != item["bytes"] or not os.path.isfile(marker):
            missing.append(item["path"])
    return missing


async def health(request: web.Request, session: ClientSession) -> web.Response:
    body = {"ok": True, "comfy": False, "models_ready": False, "gpu": "", "vram_gb": 0,
            "sparse_attention": False, "missing_models": [], "profile": PROFILE}
    try:
        async with session.get(f"{COMFY}/system_stats", timeout=ClientTimeout(total=5)) as resp:
            stats = await resp.json()
        device = (stats.get("devices") or [{}])[0]
        body["comfy"] = True
        body["gpu"] = str(device.get("name", ""))[:120]
        body["vram_gb"] = round(float(device.get("vram_total", 0)) / 1024 ** 3, 1)
        async with session.get(f"{COMFY}/object_info/BlockSparseAttention", timeout=ClientTimeout(total=10)) as resp:
            body["sparse_attention"] = resp.status == 200 and "BlockSparseAttention" in (await resp.json())
    except Exception:
        pass
    try:
        body["missing_models"] = missing_models()
        body["models_ready"] = not body["missing_models"]
    except Exception:
        body["missing_models"] = ["models.json"]
    return web.json_response(body)


async def forward(request: web.Request, session: ClientSession, route: str, max_body: int = 0) -> web.StreamResponse:
    data = None
    headers = {}
    if request.method == "POST":
        if request.content_length is not None and request.content_length > max_body:
            return web.json_response({"error": "body too large"}, status=413)
        # read(n) returns one chunk, not n bytes — loop to EOF, capped.
        chunks, size = [], 0
        async for chunk in request.content.iter_chunked(1 << 16):
            size += len(chunk)
            if size > max_body:
                return web.json_response({"error": "body too large"}, status=413)
            chunks.append(chunk)
        data = b"".join(chunks)
        if request.headers.get("Content-Type"):
            headers["Content-Type"] = request.headers["Content-Type"]
    url = f"{COMFY}{route}"
    async with session.request(request.method, url, data=data, headers=headers, params=request.query,
                               timeout=ClientTimeout(total=600), allow_redirects=False) as upstream:
        response = web.StreamResponse(status=upstream.status)
        response.content_type = upstream.content_type
        await response.prepare(request)
        async for chunk in upstream.content.iter_chunked(1 << 16):
            await response.write(chunk)
        await response.write_eof()
        return response


def make_app() -> web.Application:
    app = web.Application(client_max_size=MAX_UPLOAD + 1024)

    async def startup(app_: web.Application):
        app_["session"] = ClientSession()

    async def cleanup(app_: web.Application):
        await app_["session"].close()

    app.on_startup.append(startup)
    app.on_cleanup.append(cleanup)

    @web.middleware
    async def require_token(request: web.Request, handler):
        if not authorized(request):
            return web.json_response({"error": "unauthorized"}, status=401)
        return await handler(request)

    app.middlewares.append(require_token)

    def s(request):
        return request.app["session"]

    async def history(request):
        prompt_id = request.match_info["prompt_id"]
        if not PROMPT_ID.match(prompt_id):
            return web.json_response({"error": "bad id"}, status=400)
        return await forward(request, s(request), f"/history/{prompt_id}")

    app.router.add_get("/conveyer/health", lambda r: health(r, s(r)))
    app.router.add_post("/upload/image", lambda r: forward(r, s(r), "/upload/image", MAX_UPLOAD))
    app.router.add_get("/queue", lambda r: forward(r, s(r), "/queue"))
    app.router.add_post("/prompt", lambda r: forward(r, s(r), "/prompt", MAX_PROMPT))
    app.router.add_get("/history/{prompt_id}", history)
    app.router.add_get("/view", lambda r: forward(r, s(r), "/view"))
    return app


if __name__ == "__main__":
    web.run_app(make_app(), host="127.0.0.1", port=PORT, print=None)
