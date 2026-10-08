"""みちくさ書房の問い合わせエージェント（Strands + AgentCore Runtime）。"""

import os

from bedrock_agentcore.runtime import BedrockAgentCoreApp
from strands import Agent, tool
from strands.models import BedrockModel

import bookstore

MODEL_ID = os.getenv("MODEL_ID", "jp.anthropic.claude-haiku-4-5-20251001-v1:0")

SYSTEM_PROMPT = """あなたは架空の書店「みちくさ書房」の問い合わせ窓口です。
- 在庫は店舗ごとに答えてください。店舗は渋谷店・梅田店・札幌店の3つです。
- 送料は calc_shipping の結果だけを使ってください。
- ツールで分からないことは「分かりかねます」と答えてください。
- 回答は日本語で、簡潔にまとめてください。"""


@tool
def search_books(keyword: str) -> list[dict]:
    """書名・著者名・ジャンル（タグ）のキーワードで本を検索する。

    Args:
        keyword: 検索キーワード（例: "天文", "畑中みのり", "Python"）
    """
    return bookstore.search_books(keyword)


@tool
def get_stock(isbn: str) -> dict:
    """ISBN を指定して店舗別の在庫数を調べる。

    Args:
        isbn: 本の ISBN（例: "978-4-0000-0001-1"）
    """
    return bookstore.get_stock(isbn)


@tool
def calc_shipping(prefecture: str, subtotal: int) -> dict:
    """配送先の都道府県と商品小計（円）から送料と合計金額を計算する。

    Args:
        prefecture: 配送先の都道府県名（例: "東京都", "北海道"）
        subtotal: 商品の小計（円）
    """
    return bookstore.calc_shipping(prefecture, subtotal)


model = BedrockModel(model_id=MODEL_ID, temperature=0)
app = BedrockAgentCoreApp()


@app.entrypoint
def invoke(payload: dict) -> dict:
    prompt = payload.get("prompt", "")
    agent = Agent(
        model=model,
        system_prompt=SYSTEM_PROMPT,
        tools=[search_books, get_stock, calc_shipping],
        callback_handler=None,
    )
    result = agent(prompt)
    return {"result": str(result)}


if __name__ == "__main__":
    app.run()
