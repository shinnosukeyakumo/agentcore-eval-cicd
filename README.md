<div align="center">

# agentcore-eval-cicd

**AgentCore Evaluations で採点し、合格したエージェントだけを stg に上げる CI/CD**

[![deploy-dev](https://github.com/shinnosukeyakumo/agentcore-eval-cicd/actions/workflows/deploy-dev.yml/badge.svg?branch=dev)](https://github.com/shinnosukeyakumo/agentcore-eval-cicd/actions/workflows/deploy-dev.yml)

![Amazon Bedrock AgentCore](https://img.shields.io/badge/Amazon_Bedrock-AgentCore-01A88D?logo=amazonwebservices&logoColor=white)
![Strands Agents](https://img.shields.io/badge/Strands-Agents-232F3E)
![AWS CDK](https://img.shields.io/badge/AWS_CDK-TypeScript-3178C6?logo=typescript&logoColor=white)
![GitHub Actions](https://img.shields.io/badge/GitHub_Actions-OIDC-2088FF?logo=githubactions&logoColor=white)
![Python](https://img.shields.io/badge/Python-3.13-3776AB?logo=python&logoColor=white)

<img src="docs/images/architecture.drawio.png" alt="コンテナイメージが dev の ECR から dev・rc・stg の各 Runtime へ流れる構成" width="860">

</div>

---

## 何をするリポジトリか

AgentCore Runtime 上のエージェントを dev → stg へ上げるときに、AgentCore Evaluations で採点して、点が足りなければ stg へマージできないようにします。

- **LLM 評価はリリース PR だけで回す**。feature → dev の PR ではテストしか走らないので、PR が増えても評価の回数は増えません
- **イメージは一度だけビルドする**。dev へのマージ時に作ったイメージを、評価用の rc Runtime と stg にそのまま運びます
- **stg への適用は手動**。評価に通ったものを、いつ適用するかは人が決めます

## 流れ

```mermaid
flowchart LR
  F([feature/*]) -- "PR: テスト" --> D([dev])
  D -- "自動デプロイ" --> DR[[dev Runtime]]
  D -- "切り出す" --> R([release/*])
  R -- "PR: rc で評価" --> S([stg])
  S -- "手動デプロイ" --> SR[[stg Runtime]]
```

| 契機 | ワークフロー | やること | AWS ロール |
|---|---|---|---|
| feature → dev の PR | [`ci.yml`](.github/workflows/ci.yml) | lint・pytest・`cdk synth`・`docker build` | なし |
| dev への push | [`deploy-dev.yml`](.github/workflows/deploy-dev.yml) | テスト → ECR へ push → dev Runtime を更新 | dev-deploy |
| release/* → stg の PR | [`eval-gate.yml`](.github/workflows/eval-gate.yml) | rc Runtime のイメージを差し替えて評価。不合格ならマージ不可 | eval |
| 手動（stg ブランチ） | [`deploy-stg.yml`](.github/workflows/deploy-stg.yml) | dev の ECR から stg の ECR へ digest ごとコピー → stg Runtime を更新 | stg-deploy |

GitHub Actions から AWS へは OIDC で入り、ロールは用途ごとに分けています。評価用のロールは、rc Runtime のイメージ差し替えと採点しかできません。

### イメージの目印

ECR のタグは `agent/` フォルダのツリーハッシュです。

```bash
git rev-parse HEAD:agent
```

release ブランチを切ったり stg にマージしたりするとコミット SHA は変わりますが、`agent/` の中身が同じならツリーハッシュは同じです。ECR はタグの上書きを禁止（IMMUTABLE）しているので、同じタグが別のイメージを指すこともありません。

## 判定

評価用の問いは 8 問です。ツールを呼んで答える問いが 7 問、範囲外の問いが 1 問で、すべて正解を用意しています。各 3 回、計 24 セッションを流して採点します。

| 評価器 | 見ているもの | 判定方式 |
|---|---|---|
| `Builtin.GoalSuccessRate` | ユーザーの目的を果たせたか | LLM |
| `Builtin.Correctness` | 正解と核心が一致するか | LLM |
| `Builtin.ToolSelectionAccuracy` | ツールの選び方 | LLM |
| `Builtin.ToolParameterAccuracy` | ツールに渡した引数 | LLM |
| `Builtin.TrajectoryInOrderMatch` | 期待した順にツールを呼んだか | プログラム |

合否は次の 3 つで決めます（[`eval/config.json`](eval/config.json)）。

1. 評価器ごとの平均がすべて 0.8 以上
2. 重要な問い（`critical`）は、1 試行でも Correctness が 1.0 未満なら不合格
3. スパンが揃わず採点できなかったものは、不合格とは別に「採点不能」として扱う

2 は、平均だけだと 1 問の誤答が埋もれるために足したものです。下は送料の問いだけを壊したときの結果で、Correctness の平均は 0.88 と閾値を超えていますが、重要な問いの最低ラインで不合格になっています。

<p align="center">
  <img src="docs/images/v1-fail-comment.png" alt="Correctness の平均は 0.88 だが、送料の問いが 3 試行とも 0 点で不合格になった評価コメント" width="560">
</p>

## 検証結果

実際の流れ（feature → dev → release → stg）で、わざと劣化させた変更を流して確かめました。

| # | 試したこと | 結果 | 所要（評価） |
|---|---|---|---:|
| V1 | 送料の問いを 1 問だけ壊す | ❌ 不合格（重要な問いで止まった） | 4分57秒 |
| V2 | 正常なリリース → 手動で stg | ✅ 合格。dev と stg の ECR で digest が一致 | 4分52秒 |
| V3 | リリース PR を開いたまま dev にマージ | ✅ 評価は走り直さない | - |
| V4 | dev から stg へ直接 PR | ✅ 評価の前に失敗してマージ不可 | - |
| V5 | 送料ツールを外す | ❌ 不合格 | 13分18秒 |
| V6 | 正常なリリース | ✅ 合格。rc の差し替えは 11 秒 | 4分22秒 |

細かい経緯と数字は [docs/verify-results.md](docs/verify-results.md) にあります。

<details>
<summary><b>途中で見つけた落とし穴</b></summary>

| 落とし穴 | 対処 |
|---|---|
| ブランチ保護の必須チェックは、`if:` で skipped になったジョブを合格扱いする | ジョブに `if:` を付けず、最初のステップで条件外を `exit 1` にする |
| スパンが届く前に Evaluate を呼ぶと `ValidationException`（`no span documents` / `no spans to evaluate`）になる | 取り込み待ちとして再試行し、揃わなければ採点不能にする |
| ツールを 1 回も呼ばないセッションでは、ツール系の評価器が結果を返さない | 完了待ちの条件からツール系を外す |
| `GoalSuccessRate` は、範囲外の問いへの正しい拒否を 0 点にし、誤った送料案内を満点にした | 範囲外の問いは対象から外す |
| UpdateAgentRuntime の直後は status が READY のまま返ることがある | version が上がって READY になるまで待つ |
| 新しい GitHub リポジトリは OIDC の `sub` が `repo:owner@<id>/repo@<id>:...` の形式 | 信頼ポリシーをこの形式で書く |

</details>

## 構成

```
.
├── agent/            Strands エージェントと Dockerfile（arm64）
├── infra/            CDK（TypeScript）
│   └── lib/
│       ├── bootstrap-stack.ts   OIDC プロバイダ・ECR・GitHub Actions 用ロール
│       └── agent-stack.ts       dev / rc / stg の AgentCore Runtime
├── eval/
│   ├── dataset.json  評価用の問いと正解
│   ├── config.json   閾値・重要な問いの最低ライン
│   ├── run_eval.py   呼び出し → 取り込み待ち → 採点 → 判定
│   └── deploy_rc.py  rc Runtime のイメージ差し替え
├── tests/            ツールの単体テスト
└── .github/workflows/
```

| 項目 | 内容 |
|---|---|
| リージョン | 東京（ap-northeast-1） |
| モデル | `jp.anthropic.claude-haiku-4-5-20251001-v1:0` |
| 評価 | AgentCore Evaluations（on-demand、`bedrock-agentcore` 1.24.1 の `EvaluationClient`） |
| アカウント | 1 アカウントで dev / stg を分けて再現（実運用ではアカウントを分ける想定） |

## セットアップ

<details>
<summary><b>手順を開く</b></summary>

### 前提

- CloudWatch Transaction Search が有効（AgentCore Evaluations の前提）
- `cdk bootstrap` 済み（ap-northeast-1）

### 1. Bootstrap スタック（手元から 1 回だけ）

```bash
cd infra
npm ci
npx cdk deploy AgentCoreEvalCicd-Bootstrap \
  -c githubSubPrefix=$(gh api repos/<owner>/<repo>/actions/oidc/customization/sub --jq .sub_claim_prefix)
```

OIDC プロバイダ、ECR 2 つ、ロール 3 つができます。出力されたロール ARN を控えてください。

### 2. GitHub の設定

- ブランチ `dev`（既定）と `stg` を作る
- Environments に `dev` と `stg` を作る（`stg` に承認者を付けると手動デプロイの前に承認を挟める）
- Repository secrets を登録する

| secret | 値 |
|---|---|
| `AWS_DEV_DEPLOY_ROLE_ARN` | DevDeployRoleArn |
| `AWS_EVAL_ROLE_ARN` | EvalRoleArn |
| `AWS_STG_DEPLOY_ROLE_ARN` | StgDeployRoleArn |

- ブランチ保護：`stg` で `evaluate` を、`dev` で `python` / `cdk` / `docker` を必須チェックにする

### 3. 最初のデプロイ

dev に push すると `deploy-dev.yml` が動き、dev Runtime ができます。

rc Runtime は、dev の ECR にイメージができた後に手元から 1 回だけ作ります。以降のイメージ差し替えは eval-gate が行います。

```bash
cd infra
npx cdk deploy AgentCoreEvalCicd-rc -c imageTag=$(git rev-parse HEAD:agent)
```

### 4. リリース

```bash
git switch dev && git pull
git push origin HEAD:refs/heads/release/$(date +%Y%m%d)
gh pr create --base stg --head release/$(date +%Y%m%d)
```

評価に通ったらマージし、Actions 画面で `deploy-stg` を stg ブランチで実行します。

### 手元での実行

```bash
uv sync --group dev --group eval
uv run pytest
uv run python eval/run_eval.py --runtime-name michikusa_rc --trials 1
```

</details>

## 参考

- [Automated agent evaluation with Amazon Bedrock AgentCore and GitHub Actions](https://aws.amazon.com/blogs/machine-learning/automated-agent-evaluation-with-amazon-bedrock-agentcore-and-github-actions/)
- [Deploy AI agents on Amazon Bedrock AgentCore using GitHub Actions](https://aws.amazon.com/blogs/machine-learning/deploy-ai-agents-on-amazon-bedrock-agentcore-using-github-actions/)
