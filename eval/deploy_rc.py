"""rc Runtime（リリース候補の評価専用）のイメージだけを差し替える。

使い方:
  python eval/deploy_rc.py --image-tag <agent/ のツリーハッシュ>

ビルドはしない。dev へのマージ時にビルド済みのイメージを dev の ECR から参照させる。
cdk deploy を使わないのは、評価用ロールに CDK の強いロールを渡さないため。
UpdateAgentRuntime は設定一式を受け取るので、イメージ以外は現在の値をそのまま渡す。
"""

import argparse
import os
import sys
import time

import boto3
from botocore.exceptions import ClientError

REGION = os.environ.get("AWS_REGION", "ap-northeast-1")
RUNTIME_NAME = "michikusa_rc"
SOURCE_REPO = "agentcore-eval-cicd/agent-dev"

# GetAgentRuntime の応答のうち、UpdateAgentRuntime にそのまま渡せる設定
CARRY_OVER = (
    "roleArn",
    "networkConfiguration",
    "description",
    "authorizerConfiguration",
    "requestHeaderConfiguration",
    "protocolConfiguration",
    "lifecycleConfiguration",
    "metadataConfiguration",
    "environmentVariables",
)


def image_exists(ecr, tag: str, wait_seconds: int) -> bool:
    """dev へのデプロイ直後に release を切った場合に備え、push を待つ。"""
    deadline = time.time() + wait_seconds
    while True:
        try:
            ecr.describe_images(repositoryName=SOURCE_REPO, imageIds=[{"imageTag": tag}])
            return True
        except ClientError as e:
            if e.response["Error"]["Code"] != "ImageNotFoundException":
                raise
        if time.time() > deadline:
            return False
        print(f"dev の ECR にタグ {tag} がまだない。30 秒後に再確認")
        time.sleep(30)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--image-tag", required=True)
    ap.add_argument("--wait-image-seconds", type=int, default=0)
    args = ap.parse_args()

    ecr = boto3.client("ecr", region_name=REGION)
    control = boto3.client("bedrock-agentcore-control", region_name=REGION)

    if not image_exists(ecr, args.image_tag, args.wait_image_seconds):
        sys.exit(
            f"❌ dev の ECR にタグ {args.image_tag} がない。"
            " release ブランチが dev 以外から切られたか、dev へのデプロイが終わっていない。"
        )

    runtime_id = next(
        rt["agentRuntimeId"]
        for page in control.get_paginator("list_agent_runtimes").paginate()
        for rt in page["agentRuntimes"]
        if rt["agentRuntimeName"] == RUNTIME_NAME
    )
    current = control.get_agent_runtime(agentRuntimeId=runtime_id)
    uri = current["agentRuntimeArtifact"]["containerConfiguration"]["containerUri"]
    new_uri = f"{uri.rsplit(':', 1)[0]}:{args.image_tag}"
    if uri == new_uri and current["status"] == "READY":
        print(f"rc は既に {args.image_tag} で動いている")
        return

    print(f"rc を差し替える: {uri.rsplit(':', 1)[-1]} → {args.image_tag}")
    control.update_agent_runtime(
        agentRuntimeId=runtime_id,
        agentRuntimeArtifact={"containerConfiguration": {"containerUri": new_uri}},
        **{k: current[k] for k in CARRY_OVER if current.get(k) is not None},
    )
    deadline = time.time() + 600
    while (status := control.get_agent_runtime(agentRuntimeId=runtime_id)["status"]) != "READY":
        if status.endswith("FAILED") or time.time() > deadline:
            sys.exit(f"❌ rc の更新が {status} で止まった")
        time.sleep(10)
    print("rc の差し替え完了")


if __name__ == "__main__":
    main()
