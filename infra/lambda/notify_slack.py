"""CloudWatch アラームの通知を、AgentCore Gateway 経由で Slack に送る。

Gateway は IAM 認証なので、リクエストに SigV4 で署名する。
Slack のトークンはこの関数には渡らない（Gateway が Identity から取り出して付ける）。
"""

import json
import os
import urllib.request

import boto3
from botocore.auth import SigV4Auth
from botocore.awsrequest import AWSRequest

GATEWAY_URL = os.environ["GATEWAY_URL"]
SLACK_CHANNEL = os.environ["SLACK_CHANNEL"]
TOOL_NAME = os.environ["TOOL_NAME"]
REGION = os.environ["AWS_REGION"]


def format_alarm(alarm: dict) -> str:
    state = alarm.get("NewStateValue")
    head = ":rotating_light: 品質が閾値を下回った" if state == "ALARM" else ":white_check_mark: 品質が閾値まで戻った"
    trigger = alarm.get("Trigger", {})
    return "\n".join([
        f"{head}（{alarm.get('AlarmName')}）",
        f"評価器: {trigger.get('MetricName')}",
        f"閾値: {trigger.get('Threshold')}",
        f"理由: {alarm.get('NewStateReason')}",
    ])


def call_tool(arguments: dict) -> dict:
    body = json.dumps({
        "jsonrpc": "2.0",
        "id": 1,
        "method": "tools/call",
        "params": {"name": TOOL_NAME, "arguments": arguments},
    })
    req = AWSRequest(method="POST", url=GATEWAY_URL, data=body, headers={
        "Content-Type": "application/json",
        "Accept": "application/json, text/event-stream",
    })
    SigV4Auth(boto3.Session().get_credentials(), "bedrock-agentcore", REGION).add_auth(req)
    http = urllib.request.Request(GATEWAY_URL, data=body.encode(), headers=dict(req.headers), method="POST")
    with urllib.request.urlopen(http, timeout=20) as res:
        return json.loads(res.read())


def handler(event, context):
    for record in event.get("Records", []):
        alarm = json.loads(record["Sns"]["Message"])
        result = call_tool({"channel": SLACK_CHANNEL, "text": format_alarm(alarm)})
        print(json.dumps(result, ensure_ascii=False))
        # Slack が ok: false を返しても Gateway は isError: false で返す。自分で中身を見て失敗にする
        slack = json.loads(result["result"]["content"][0]["text"])
        if not slack.get("ok"):
            raise RuntimeError(f"Slack への投稿に失敗: {slack.get('error')}")
