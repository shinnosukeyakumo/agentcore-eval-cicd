"""AgentCore Runtime 上のエージェントを評価し、閾値で合否を返す。

使い方:
  python eval/run_eval.py --runtime-name michikusa_dev --expected-image-tag <tag>
  python eval/run_eval.py --runtime-name michikusa_stg --smoke

流れ:
  1. Runtime を名前で探し、READY か・期待したイメージで動いているかを確かめる
  2. データセットの問いを 1 問 1 セッションで投げる（trials 回くり返す）
  3. スパンが CloudWatch に届くのを待ち、AgentCore Evaluations で採点する
  4. 評価器ごとの平均を閾値と比べ、下回れば終了コード 1
"""

import argparse
import json
import os
import sys
import time
import uuid
from collections import defaultdict
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
from pathlib import Path
from statistics import mean

import boto3
from bedrock_agentcore.evaluation import EvaluationClient, ReferenceInputs
from botocore.exceptions import ClientError

HERE = Path(__file__).parent
REGION = os.environ.get("AWS_REGION", "ap-northeast-1")
# スパンの取り込み途中に Evaluate が返すエラー。揃うまで待てば解消する
INGESTION_PENDING_ERRORS = ("no span documents", "no spans to evaluate")
TRAJECTORY_EVALUATORS = {
    "Builtin.TrajectoryInOrderMatch",
    "Builtin.TrajectoryExactOrderMatch",
    "Builtin.TrajectoryAnyOrderMatch",
}


@dataclass
class Run:
    case: dict
    trial: int
    session_id: str
    answer: str = ""
    error: str = ""
    results: list[dict] = field(default_factory=list)


def find_runtime(control, name: str) -> dict:
    for page in control.get_paginator("list_agent_runtimes").paginate():
        for rt in page["agentRuntimes"]:
            if rt["agentRuntimeName"] == name:
                return control.get_agent_runtime(agentRuntimeId=rt["agentRuntimeId"])
    sys.exit(f"Runtime {name} が見つからない")


def wait_ready(control, runtime: dict, timeout: int = 600) -> dict:
    deadline = time.time() + timeout
    while runtime["status"] != "READY":
        if runtime["status"].endswith("FAILED") or time.time() > deadline:
            sys.exit(f"Runtime の状態が {runtime['status']} のまま")
        time.sleep(10)
        runtime = control.get_agent_runtime(agentRuntimeId=runtime["agentRuntimeId"])
    return runtime


def invoke(data, runtime_arn: str, run: Run) -> Run:
    for attempt in range(5):
        try:
            resp = data.invoke_agent_runtime(
                agentRuntimeArn=runtime_arn,
                qualifier="DEFAULT",
                runtimeSessionId=run.session_id,
                payload=json.dumps({"prompt": run.case["prompt"]}).encode(),
            )
            run.answer = json.loads(resp["response"].read())["result"]
            return run
        except ClientError as e:
            # 起動直後は 424 / Throttling が返ることがある
            run.error = str(e)
            time.sleep(10 * (attempt + 1))
    return run


def score(client: EvaluationClient, runtime_id: str, run: Run, evaluators: list[str]) -> Run:
    ref = ReferenceInputs(
        expected_response=run.case.get("expected_response"),
        expected_trajectory=run.case.get("expected_trajectory"),
    )
    if not run.case.get("expected_trajectory"):
        evaluators = [e for e in evaluators if e not in TRAJECTORY_EVALUATORS]
    try:
        run.results = client.run(
            evaluator_ids=evaluators,
            session_id=run.session_id,
            agent_id=runtime_id,
            reference_inputs=ref,
        )
    except ClientError as e:
        # ログイベントやスパンの一部が先に CloudWatch に届くことがある。その間は未完了として待つ
        if not any(m in str(e) for m in INGESTION_PENDING_ERRORS):
            raise
        run.results = []
    return run


def is_complete(run: Run, evaluators: list[str]) -> bool:
    """スパンの取り込みが途中だと一部の評価器しか結果を返さないため、揃うまで待つ。"""
    got = {r["evaluatorId"] for r in run.results if r.get("value") is not None}
    needed = set(evaluators)
    if not run.case.get("expected_trajectory"):
        needed -= TRAJECTORY_EVALUATORS
    # ツールを呼ばない問いでは TOOL_CALL 評価器の対象がない
    if not run.case.get("expected_trajectory"):
        needed -= {"Builtin.ToolSelectionAccuracy", "Builtin.ToolParameterAccuracy"}
    return needed <= got


def write_report(runs: list[Run], thresholds: dict, averages: dict, passed: bool, header: str) -> str:
    lines = [f"## {header}", ""]
    lines += ["| 評価器 | 平均 | 閾値 | 件数 | 判定 |", "|---|---:|---:|---:|---|"]
    for name, th in thresholds.items():
        vals = averages.get(name)
        if vals is None:
            lines.append(f"| {name} | - | {th} | 0 | ⚠️ 結果なし |")
            continue
        avg, n = vals
        lines.append(f"| {name} | {avg:.2f} | {th} | {n} | {'✅' if avg >= th else '❌'} |")
    lines += ["", f"**総合判定: {'✅ 合格' if passed else '❌ 不合格'}**", ""]

    lines += ["<details><summary>問いごとの結果</summary>", ""]
    lines += ["| 問い | 試行 | " + " | ".join(n.removeprefix("Builtin.") for n in thresholds) + " |"]
    lines += ["|---|---:|" + "---:|" * len(thresholds)]
    for run in runs:
        by_eval = defaultdict(list)
        for r in run.results:
            if r.get("value") is not None:
                by_eval[r["evaluatorId"]].append(r["value"])
        cells = [f"{mean(by_eval[n]):.2f}" if by_eval[n] else "-" for n in thresholds]
        lines.append(f"| {run.case['id']} | {run.trial} | " + " | ".join(cells) + " |")
    lines += ["", "</details>", ""]
    return "\n".join(lines)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--runtime-name", required=True)
    ap.add_argument("--expected-image-tag", help="Runtime がこのタグのイメージで動いていなければ失敗させる")
    ap.add_argument("--wait-image-seconds", type=int, default=0, help="タグが一致するまで待つ最大秒数")
    ap.add_argument("--smoke", action="store_true", help="1 問だけ投げて応答を確かめる（採点しない）")
    ap.add_argument("--trials", type=int)
    ap.add_argument("--out", default="eval/results")
    args = ap.parse_args()

    config = json.loads((HERE / "config.json").read_text())
    dataset = json.loads((HERE / "dataset.json").read_text())
    thresholds: dict[str, float] = config["thresholds"]
    evaluators = list(thresholds)
    trials = args.trials or config["trials"]

    control = boto3.client("bedrock-agentcore-control", region_name=REGION)
    data = boto3.client("bedrock-agentcore", region_name=REGION)

    deadline = time.time() + args.wait_image_seconds
    while True:
        runtime = wait_ready(control, find_runtime(control, args.runtime_name))
        image_uri = runtime["agentRuntimeArtifact"]["containerConfiguration"]["containerUri"]
        image_tag = image_uri.rsplit(":", 1)[-1]
        print(f"Runtime: {args.runtime_name} / version {runtime['agentRuntimeVersion']} / image tag {image_tag}")
        if not args.expected_image_tag or image_tag == args.expected_image_tag:
            break
        if time.time() > deadline:
            sys.exit(
                f"❌ Runtime のイメージタグ {image_tag} が期待値 {args.expected_image_tag} と一致しない。"
                " デプロイが終わっていない可能性がある。デプロイ完了後に再実行せよ。"
            )
        print(f"期待するタグ {args.expected_image_tag} のデプロイを待つ...")
        time.sleep(30)

    if args.smoke:
        run = invoke(data, runtime["agentRuntimeArn"], Run(dataset[0], 1, str(uuid.uuid4())))
        print(f"Q: {run.case['prompt']}\nA: {run.answer or run.error}")
        sys.exit(0 if run.answer else 1)

    runs = [Run(case, t, str(uuid.uuid4())) for t in range(1, trials + 1) for case in dataset]
    print(f"{len(dataset)} 問 × {trials} 回 = {len(runs)} セッションを実行する")
    with ThreadPoolExecutor(config["concurrency"]) as pool:
        runs = list(pool.map(lambda r: invoke(data, runtime["agentRuntimeArn"], r), runs))
    failed_invokes = [r for r in runs if not r.answer]
    for r in failed_invokes:
        print(f"⚠️ 呼び出し失敗 {r.case['id']}#{r.trial}: {r.error}")

    # スパンが CloudWatch に届くまで待つ（資料により 30 秒〜数分）
    print("スパンの取り込みを待つ...")
    time.sleep(60)
    client = EvaluationClient(region_name=REGION)
    pending = [r for r in runs if r.answer]
    deadline = time.time() + 600
    while pending and time.time() < deadline:
        with ThreadPoolExecutor(config["concurrency"]) as pool:
            scored = list(pool.map(lambda r: score(client, runtime["agentRuntimeId"], r, evaluators), pending))
        pending = [r for r in scored if not is_complete(r, evaluators)]
        if pending:
            print(f"未完了 {len(pending)} 件。30 秒後に再試行")
            time.sleep(30)

    values: dict[str, list[float]] = defaultdict(list)
    for run in runs:
        for r in run.results:
            if r.get("value") is not None:
                values[r["evaluatorId"]].append(r["value"])
    averages = {name: (mean(v), len(v)) for name, v in values.items()}
    passed = (
        not failed_invokes
        and not pending
        and all(name in averages and averages[name][0] >= th for name, th in thresholds.items())
    )

    report = write_report(runs, thresholds, averages, passed, f"エージェント評価: {args.runtime_name} ({image_tag})")
    print(report)
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    (out / "report.md").write_text(report)
    (out / "raw.json").write_text(
        json.dumps(
            [
                {
                    "id": r.case["id"],
                    "trial": r.trial,
                    "session_id": r.session_id,
                    "answer": r.answer,
                    "results": [
                        {k: x.get(k) for k in ("evaluatorId", "value", "label", "explanation")} for x in r.results
                    ],
                }
                for r in runs
            ],
            ensure_ascii=False,
            indent=2,
        )
    )
    if summary := os.environ.get("GITHUB_STEP_SUMMARY"):
        with open(summary, "a") as f:
            f.write(report)
    sys.exit(0 if passed else 1)


if __name__ == "__main__":
    main()
