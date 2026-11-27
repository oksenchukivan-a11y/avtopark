"""Перевірки правил рейсу. Усі клієнти й суми вигадані."""
from datetime import date

from reys import build, engine as e, ui
from reys.tags import delivery_date, driver_comment, tags_of

MON = date(2026, 11, 16)          # понеділок


def test_tags_variants_of_no_payment():
    for c in ("без оплати", "акція 10+3 б/о", "Б/0", "доставка в салон. залишити на каві. без оплати"):
        assert "BO" in tags_of(c), c
    assert "BO" not in tags_of("бо так треба") and "BO" not in tags_of("акція 10+5")


def test_tags_self_pickup_and_post():
    assert "SV" in tags_of("св") and "SV" in tags_of("знижка, св, забере через 20 хв")
    assert "SV" in tags_of("покласти св , на вівторок") and "SV" not in tags_of("свіжий товар")
    assert "NP" in tags_of("відправити новою поштою за наш рахунок") and "NP" in tags_of("нп 22")
    assert "NP" not in tags_of("напиши суму")
    assert {"DEBT", "RET"} <= tags_of("забрати борг, забрати на повернення масло")
    assert "CALL" in tags_of("набрати за 30 хвилин")
    assert "SV" not in tags_of("Аня, з св на доставку")              # передумали: везти водієм


def test_delivery_date_like_managers_write():
    assert delivery_date("провести сьогодні, доставка середу (18.11.26р)", MON) == date(2026, 11, 18)
    assert delivery_date("На 20.11 доставку", date(2026, 11, 17)) == date(2026, 11, 20)
    assert delivery_date("знижка на п'ятницю", date(2026, 11, 17)) == date(2026, 11, 20)
    assert delivery_date("Факт, на понеділок доставка", date(2026, 11, 17)) == date(2026, 11, 23)
    assert delivery_date("на вівторок", date(2026, 11, 20)) == date(2026, 11, 24)
    assert delivery_date("акція 1+1\nдоставка на завтра", date(2026, 11, 20)) == date(2026, 11, 23)  # пт → пн
    assert delivery_date("на середу, 25.11", date(2026, 11, 23)) == date(2026, 11, 25)


def test_delivery_date_ignores_times_and_promos():
    for c in ("буде до 15.00", "з 13.30", "акція 10+5", "-10% знижка", "по 34грн", "", "св, сьогодні забере до 16.00"):
        assert delivery_date(c, MON) is None, c


def test_name_and_number():
    assert build.split_name("Салон Приклад ( вул. Тестова 20 )") == ("Салон Приклад", "вул. Тестова 20")
    assert build.split_name("Студія") == ("Студія", "")
    assert build.split_name("Майстер (ТЦ Зразок цоколь") == ("Майстер", "ТЦ Зразок цоколь")
    assert build.short_no("ОСПК0000687") == "687" and build.short_no("ОСПК0001012") == "1012"


def run():
    return build.demo_run(MON)


def stop(r, name):
    return next(s for s in r["stops"] if s["name"] == name)


def test_demo_classification():
    r = run()
    assert [s["name"] for s in e.route(r)] == ["Салон А", "Салон Б", "Студія В", "Барбершоп Г", "Салон Д"]
    assert stop(r, "Майстер Е")["where"] == "skip" and stop(r, "Салон Є")["where"] == "skip"
    assert stop(r, "Салон Є")["inv"][0]["deliver"] == "2026-11-20"
    assert stop(r, "Перукарня Ж")["where"] == "debt"


def test_due_and_free():
    r = run()
    assert e.due(stop(r, "Салон А")) == 1501.0
    b = stop(r, "Салон Б")
    assert (e.today_due(b), e.debt_due(b), e.due(b)) == (500.0, 3600.0, 4100.0)
    v = stop(r, "Студія В")
    assert e.free(v) and e.due(v) == 0


def test_allocate_round_sum_oldest_first():
    b = stop(run(), "Салон Б")
    alloc, extra = e.allocate(b, 2500)
    assert [(a["no"], a["paid"]) for a in alloc] == [("1101", 2000.0), ("1158", 500.0), ("1207", 0.0)]
    assert extra == 0
    _, extra = e.allocate(b, 5000)
    assert extra == 900.0


def test_pay_variants_and_totals():
    r = run()
    e.pay_all(stop(r, "Салон А"), 1)
    e.pay_amount(stop(r, "Салон Б"), 1, 2500)
    e.mark_given(stop(r, "Студія В"), 1)
    e.mark_none(stop(r, "Барбершоп Г"), 1, "mgr")
    d = stop(r, "Салон Д")
    e.pay_today(d, 1)
    assert stop(r, "Салон А")["status"]["kind"] == "paid"
    assert stop(r, "Салон Б")["status"]["kind"] == "part" and stop(r, "Салон Б")["status"]["cash"] == 2500
    assert d["status"]["cash"] == 2007.01 and d["status"]["kind"] == "part"
    r["expenses"].append({"kind": "Нова пошта", "sum": 683.5})
    t = e.totals(r)
    assert t["cash"] == round(1501 + 2500 + 2007.01, 2) and t["hand"] == round(t["cash"] - 683.5, 2)
    assert t["unpaid"] == round(1600 + 1620 + 950, 2) and t["left"] == 0
    assert t["why"] == {"частково": 1, "домовилась з менеджером": 1, "тільки сьогоднішнє": 1}


def test_overpay_is_not_recorded():
    a = stop(run(), "Салон А")
    e.pay_amount(a, 1, 1510)                    # дали 1 510 замість 1 501
    assert a["status"]["cash"] == 1501.0 and a["status"]["kind"] == "paid"


def test_problem_reduces_due():
    g = stop(run(), "Барбершоп Г")
    cut = e.add_problem(g, g["inv"][0]["ref"], "miss", "Окисник", 1, 240.0)
    assert cut == 240.0 and e.due(g) == 1380.0 and g["probs"][0]["inv"] == "1211"


def test_closed_stop_returns_goods():
    r = run()
    a = stop(r, "Салон А")
    e.mark_none(a, 1, "closed", left=False)
    assert a["status"]["kind"] == "back" and e.totals(r)["back"] == 1 and e.totals(r)["unpaid"] == 0


def test_money_format():
    assert e.money(1501) == "1 501 ₴" and e.money(2007.01) == "2 007,01 ₴" and e.money(0) == "0 ₴"


def test_screens_have_expected_buttons():
    r = run()
    text, rows = ui.screen_list(r)
    labels = [b[0] for row in rows for b in row]
    assert "Лишилось <b>5</b> з 5 точок" in text and any("Борги поруч (1)" in x for x in labels)
    assert any("Не їдуть (2)" in x for x in labels) and not any("Майстер Е" in x for x in labels)
    b = stop(r, "Салон Б")
    text, rows = ui.screen_card(b, 1)
    labels = [x[0] for row in rows for x in row]
    assert "Борг 3 600 ₴" in text and "№ 1101 від 04.11 · 2 000 ₴" in text and "<blockquote>" in text
    assert labels[:3] == ["💵 Забрав усе — 4 100 ₴", "💵 Тільки сьогоднішнє — 500 ₴", "💵 Інша сума або окремі накладні"]
    v = stop(r, "Студія В")
    labels = [x[0] for row in ui.screen_card(v, 2)[1] for x in row]
    assert "✅ Віддав товар" in labels and not any("Забрав усе" in x for x in labels)
    assert "касу здати не можна" in ui.screen_close(r)[0]
    for row in rows:                                    # Telegram: дані кнопки до 64 байт
        for _, data in row:
            assert len(data.encode()) <= 64


def test_callback_data_fits_telegram_limit():
    r = run()
    g = stop(r, "Барбершоп Г")
    items = [(0, n, "Позиція " + "я" * 40, 12, 100.0) for n in range(1, 31)]
    for scr in (ui.screen_items(g, 12, "refuse", items, 2), ui.screen_qty(g, 12, "refuse", 0, 30, "x", 12),
                ui.screen_part(g, 12), ui.screen_debtors(r), ui.screen_reasons(g, 12)):
        for row in scr[1]:
            for label, data in row:
                assert len(data.encode()) <= 64 and label


def test_driver_sees_only_delivery_part_of_comment():
    assert driver_comment("15%") == "" and driver_comment("акція 10+5") == "" and driver_comment("Акція Нуб, факт") == ""
    assert driver_comment("знижка , подзвонити за 15 хвилин") == "подзвонити за 15 хвилин"
    assert driver_comment("акція 10+5.доставка в салон. підкласти сошетки") == "доставка в салон"
    assert driver_comment("3+1, скинь фото накладної пліз, на долорес, подарунок якщо є, без оплати") == "на долорес, без оплати"
    # рішення власника 27.11: прохання до складу («додай, доклади, вклади») водієві не показуємо
    assert driver_comment("додай 2 шампуні, доклади рукавички, набрати за 10 хв") == "набрати за 10 хв"
    assert driver_comment("Вкласти каталог. Доставка після 14:00; покласти чек") == "Доставка після 14:00"
    assert driver_comment("якщо закрито, зателефонувати 0959263936") == "якщо закрито, зателефонувати 0959263936"


def test_no_phone_like_runs_of_digits_in_card():
    import re
    r = run()
    for i, s in enumerate(r["stops"]):
        text = re.sub(r"<[^>]+>", "", ui.screen_card(s, i, "Точка 1 з 5")[0])
        assert not re.search(r"\d{3,}\s[—-]\s\d", text), text      # «1251 — 2 061» Telegram підсвічує як телефон
