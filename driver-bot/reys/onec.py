"""Читання 1С через посередника (той самий, що в конекторах): JSON-RPC, тільки читання."""
import json
import os

import aiohttp

URL = os.environ.get("REYS_1C_URL") or os.environ.get("PK_MCP_URL") or ""
ZERO = "00000000-0000-0000-0000-000000000000"


class OneCError(Exception):
    pass


def configured() -> bool:
    return bool(URL)


async def call(tool: str, **args):
    """Викликає інструмент посередника, повертає розібраний JSON (список рядків)."""
    if not URL:
        raise OneCError("адресу 1С не задано (REYS_1C_URL)")
    body = {"jsonrpc": "2.0", "id": 1, "method": "tools/call",
            "params": {"name": tool, "arguments": {k: v for k, v in args.items() if v is not None}}}
    try:
        timeout = aiohttp.ClientTimeout(total=60)
        async with aiohttp.ClientSession(timeout=timeout) as s:
            async with s.post(URL, json=body) as r:
                if r.status != 200:
                    raise OneCError(f"посередник 1С відповів HTTP {r.status}")
                data = await r.json(content_type=None)
    except (aiohttp.ClientError, TimeoutError) as e:
        raise OneCError(f"немає зв'язку з 1С: {e}") from e
    if data.get("error"):
        raise OneCError(data["error"].get("message", "помилка посередника"))
    res = data.get("result") or {}
    text = "".join(c.get("text", "") for c in res.get("content", []) if c.get("type") == "text")
    if res.get("isError"):
        raise OneCError(text[:300] or "помилка 1С")
    return parse_rows(text)


def parse_rows(text: str):
    """Відповідь посередника: рядок «Рядків: N», далі JSON. Обрізану відповідь не приймаємо."""
    if "[обрізано]" in text or "Відповідь завелика" in text:
        raise OneCError("відповідь 1С завелика — звузити запит")
    i = text.find("[")
    if i < 0:
        return []
    try:
        return json.loads(text[i:text.rfind("]") + 1])
    except ValueError as e:
        raise OneCError(f"не вдалося розібрати відповідь 1С: {e}") from e


def guid_filter(field: str, keys) -> str:
    return " or ".join(f"{field} eq guid'{k}'" for k in keys)


def chunks(seq, n=30):
    seq = list(seq)
    for i in range(0, len(seq), n):
        yield seq[i:i + n]


async def by_keys(obj: str, keys, select: str, field: str = "Ref_Key", extra: str = ""):
    """Читає записи за списком ключів порціями, щоб адреса запиту не була задовгою."""
    out = []
    for part in chunks(sorted(set(k for k in keys if k and k != ZERO))):
        flt = f"({guid_filter(field, part)})" + (f" and {extra}" if extra else "")
        out += await call("query", object=obj, filter=flt, select=select, top=1000)
    return out
