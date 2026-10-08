import pytest

import bookstore


def test_search_by_tag():
    titles = {b["title"] for b in bookstore.search_books("天文")}
    assert titles == {"はじめての夜空観察", "望遠鏡のえらびかた"}


def test_search_by_author():
    assert len(bookstore.search_books("畑中みのり")) == 2


def test_search_empty_keyword_returns_nothing():
    assert bookstore.search_books("  ") == []


def test_stock_found():
    r = bookstore.get_stock("978-4-0000-0004-2")
    assert r["found"] is True
    assert r["stock"] == {"渋谷店": 0, "梅田店": 4, "札幌店": 2}
    assert r["total"] == 6


def test_stock_not_found():
    assert bookstore.get_stock("978-4-9999-9999-9")["found"] is False


@pytest.mark.parametrize(
    ("prefecture", "subtotal", "fee"),
    [
        ("東京都", 2999, 500),
        ("東京都", 3000, 0),
        ("北海道", 1980, 1200),
        ("沖縄県", 2999, 1200),
        ("沖縄県", 3080, 0),
    ],
)
def test_shipping(prefecture, subtotal, fee):
    r = bookstore.calc_shipping(prefecture, subtotal)
    assert r["shipping_fee"] == fee
    assert r["total"] == subtotal + fee


def test_shipping_rejects_negative():
    with pytest.raises(ValueError):
        bookstore.calc_shipping("東京都", -1)
