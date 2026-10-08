"""架空の書店「みちくさ書房」の業務ロジック。

エージェントのツールから呼ばれる純粋関数だけを置く。
データは架空で、評価セットの正解はここから一意に決まる。
"""

from dataclasses import asdict, dataclass

FREE_SHIPPING_THRESHOLD = 3000
SHIPPING_FEE_STANDARD = 500
SHIPPING_FEE_REMOTE = 1200
REMOTE_PREFECTURES = {"北海道", "沖縄県"}

STORES = ("渋谷店", "梅田店", "札幌店")


@dataclass(frozen=True)
class Book:
    isbn: str
    title: str
    author: str
    price: int
    tags: tuple[str, ...]


CATALOG: tuple[Book, ...] = (
    Book("978-4-0000-0001-1", "はじめての夜空観察", "星野ひかり", 1980, ("天文", "入門")),
    Book("978-4-0000-0002-8", "望遠鏡のえらびかた", "星野ひかり", 2420, ("天文", "道具")),
    Book("978-4-0000-0003-5", "週末ではじめる家庭菜園", "畑中みのり", 1650, ("園芸", "入門")),
    Book("978-4-0000-0004-2", "ベランダで育てるハーブ", "畑中みのり", 1430, ("園芸", "ハーブ")),
    Book("978-4-0000-0005-9", "ひとりで学ぶPython", "林こうじ", 3080, ("プログラミング", "入門")),
    Book("978-4-0000-0006-6", "読みやすいコードの作法", "林こうじ", 2860, ("プログラミング",)),
)

# 店舗ごとの在庫数（ISBN -> {店舗: 冊数}）
STOCK: dict[str, dict[str, int]] = {
    "978-4-0000-0001-1": {"渋谷店": 3, "梅田店": 0, "札幌店": 1},
    "978-4-0000-0002-8": {"渋谷店": 0, "梅田店": 0, "札幌店": 0},
    "978-4-0000-0003-5": {"渋谷店": 5, "梅田店": 2, "札幌店": 0},
    "978-4-0000-0004-2": {"渋谷店": 0, "梅田店": 4, "札幌店": 2},
    "978-4-0000-0005-9": {"渋谷店": 1, "梅田店": 1, "札幌店": 0},
    "978-4-0000-0006-6": {"渋谷店": 0, "梅田店": 0, "札幌店": 6},
}


def search_books(keyword: str) -> list[dict]:
    """書名・著者名・タグのいずれかにキーワードを含む本を返す。"""
    keyword = keyword.strip()
    if not keyword:
        return []
    hits = [b for b in CATALOG if keyword in b.title or keyword in b.author or any(keyword in t for t in b.tags)]
    return [asdict(b) for b in hits]


def get_stock(isbn: str) -> dict:
    """ISBN の店舗別在庫を返す。存在しない ISBN は found=False。"""
    stock = STOCK.get(isbn.strip())
    if stock is None:
        return {"isbn": isbn, "found": False}
    return {"isbn": isbn, "found": True, "stock": dict(stock), "total": sum(stock.values())}


def calc_shipping(prefecture: str, subtotal: int) -> dict:
    """配送先の都道府県と商品小計（税込・円）から送料を計算する。

    小計が 3,000 円以上なら全国無料。それ未満は北海道・沖縄県が 1,200 円、
    それ以外は 500 円。
    """
    if subtotal < 0:
        raise ValueError("subtotal must be non-negative")
    if subtotal >= FREE_SHIPPING_THRESHOLD:
        fee = 0
    elif prefecture.strip() in REMOTE_PREFECTURES:
        fee = SHIPPING_FEE_REMOTE
    else:
        fee = SHIPPING_FEE_STANDARD
    return {"prefecture": prefecture, "subtotal": subtotal, "shipping_fee": fee, "total": subtotal + fee}
