#!/usr/bin/env python3
"""Перевірка «хвоста дня» на історії: скільки накладних він додав би по днях, якби тоді працював.

Запуск на сервері бота (там є зв'язок з 1С), з теки, де лежить reys/:
    REYS_OWN_SHOPS="частини назв своїх магазинів через кому" python3 tests/tail_history.py 2026-10-27 2026-11-26
Тільки читає 1С; у базу бота нічого не пише (працює на тимчасовій копії)."""
import asyncio
import os
import sys
import tempfile
from datetime import date

HOME = os.environ.get("REYS_HOME") or os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, HOME)

from reys import onec, store, tail  # noqa: E402


async def main(d1, d2):
    store.DB_PATH = os.path.join(tempfile.mkdtemp(prefix="reys-tail-"), "history.db")    # кеш назв путівок — не в бойовій базі
    store.init()
    tail.init()
    if not onec.configured():
        sys.exit("Немає адреси 1С (REYS_1C_URL або PK_MCP_URL)")
    if not os.environ.get("REYS_OWN_SHOPS"):
        print("Увага: REYS_OWN_SHOPS не задано — свої магазини потраплять у підрахунок\n")
    await tail.history(d1, d2)


if __name__ == "__main__":
    if len(sys.argv) != 3:
        sys.exit(__doc__)
    asyncio.run(main(date.fromisoformat(sys.argv[1]), date.fromisoformat(sys.argv[2])))
