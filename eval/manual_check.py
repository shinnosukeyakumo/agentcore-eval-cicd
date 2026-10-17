"""人が手で確かめた場合の所要時間を測る。

評価ゲートと同じ 8 問を 1 問ずつエージェントに投げ、回答と正解を並べて表示する。
確かめる人が「合っているか」を y / n で答え、問いごとの所要時間と合計を記録する。

使い方:
  uv run python eval/manual_check.py --runtime-name michikusa_rc
"""

import argparse
import json
import os
import time
import uuid
from pathlib import Path

import boto3

HERE = Path(__file__).parent
REGION = os.environ.get("AWS_REGION", "ap-northeast-1")


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--runtime-name", required=True)
    ap.add_argument("--out", default="eval/results/manual-check.json")
    args = ap.parse_args()

    control = boto3.client("bedrock-agentcore-control", region_name=REGION)
    data = boto3.client("bedrock-agentcore", region_name=REGION)
    arn = next(
        rt["agentRuntimeArn"]
        for page in control.get_paginator("list_agent_runtimes").paginate()
        for rt in page["agentRuntimes"]
        if rt["agentRuntimeName"] == args.runtime_name
    )
    dataset = json.loads((HERE / "dataset.json").read_text())

    print(f"{len(dataset)} 問を順に投げます。回答を正解と見比べて、合っていれば y、違えば n を入力してください。\n")
    records = []
    started = time.time()
    for i, case in enumerate(dataset, start=1):
        t0 = time.time()
        resp = data.invoke_agent_runtime(
            agentRuntimeArn=arn,
            qualifier="DEFAULT",
            runtimeSessionId=str(uuid.uuid4()),
            payload=json.dumps({"prompt": case["prompt"]}).encode(),
        )
        answer = json.loads(resp["response"].read())["result"]
        t_answer = time.time()
        print(f"[{i}/{len(dataset)}] 問い: {case['prompt']}\n")
        print(f"回答:\n{answer}\n")
        print(f"正解: {case['expected_response']}\n")
        verdict = ""
        while verdict not in ("y", "n"):
            verdict = input("合っている？ (y/n): ").strip().lower()
        t_done = time.time()
        records.append(
            {
                "id": case["id"],
                "ok": verdict == "y",
                "agent_seconds": round(t_answer - t0, 1),
                "human_seconds": round(t_done - t_answer, 1),
            }
        )
        print("-" * 40)

    total = time.time() - started
    human = sum(r["human_seconds"] for r in records)
    agent = sum(r["agent_seconds"] for r in records)
    print(f"\n合計 {total:.0f} 秒（エージェントの応答 {agent:.0f} 秒、人が確かめた時間 {human:.0f} 秒）")
    print(f"合っていると判断した問い: {sum(r['ok'] for r in records)} / {len(records)}")
    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps({"total_seconds": round(total, 1), "records": records}, ensure_ascii=False, indent=2))
    print(f"記録: {out}")


if __name__ == "__main__":
    main()
