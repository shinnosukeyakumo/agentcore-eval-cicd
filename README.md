# agentcore-eval-cicd

Amazon Bedrock AgentCore Runtime 上のエージェントを、GitHub Actions で dev → stg に昇格させる検証用リポジトリ。
dev → stg の PR では AgentCore Evaluations で採点し、閾値を下回ればマージできないようにする。

参考にしたブログ:

- [Automated agent evaluation with Amazon Bedrock AgentCore and GitHub Actions](https://aws.amazon.com/blogs/machine-learning/automated-agent-evaluation-with-amazon-bedrock-agentcore-and-github-actions/)
- [Deploy AI agents on Amazon Bedrock AgentCore using GitHub Actions](https://aws.amazon.com/blogs/machine-learning/deploy-ai-agents-on-amazon-bedrock-agentcore-using-github-actions/)

ブログとの違いは 2 点ある。評価は PR ごとに使い捨ての Runtime を作らず、常設の dev Runtime に対して行う。また、評価に通ったイメージをビルドし直さず、そのまま stg に運ぶ。

## 流れ

```
feature/xxx
  │ ① PR → ci.yml（lint・テスト・cdk synth・docker build）
  ▼ マージ
 dev ─② push → deploy-dev.yml（自動）
  │     テスト → build → ECR(agent-dev) → dev Runtime 更新
  │ ③ PR → eval-gate.yml（自動）
  │     dev Runtime を評価。不合格ならマージ不可
  ▼ マージ
 stg
  │ ④ Actions 画面で Run workflow（手動）
  ▼
 deploy-stg.yml
   ECR(agent-dev) → ECR(agent-stg) へ digest ごとコピー → stg Runtime 更新
```

| workflow | 契機 | AWS ロール |
|---|---|---|
| `ci.yml` | feature → dev の PR | なし |
| `deploy-dev.yml` | dev への push | `agentcore-eval-cicd-gha-dev-deploy` |
| `eval-gate.yml` | dev → stg の PR | `agentcore-eval-cicd-gha-eval`（デプロイ権限なし） |
| `deploy-stg.yml` | 手動（stg ブランチ） | `agentcore-eval-cicd-gha-stg-deploy` |

### イメージの目印

ECR のタグには `git rev-parse HEAD:agent`（`agent/` フォルダのツリーハッシュ）を使う。
dev → stg の PR をマージするとコミット SHA は変わるが、`agent/` の中身が同じならツリーハッシュは変わらない。
そのため stg 側で同じタグを計算すれば、dev で評価したイメージを特定できる。
ECR はタグの上書きを禁止（IMMUTABLE）しているので、同じタグが別の中身を指すことはない。

### 1 アカウントでの再現

実案件では dev / stg / prd を別アカウントに分ける想定だ。この検証では 1 アカウントで次のように置き換えている。

| 実案件 | この検証 |
|---|---|
| アカウントごとの ECR | ECR リポジトリ `agent-dev` / `agent-stg` |
| アカウントごとの OIDC ロール | 用途別のロール 3 つ |
| dev アカウントの ECR リポジトリポリシーで stg の CI ロールに読み取りを許可 | stg デプロイ用ロールの IAM ポリシーで `agent-dev` の読み取りを許可 |

注意: 同じアカウントなので、dev デプロイ用ロールでも CDK bootstrap のロール経由で stg スタックを更新できてしまう。環境の分離は、アカウントを分けて初めて成立する。

## 構成

```
agent/      Strands エージェント（架空の書店「みちくさ書房」）と Dockerfile
infra/      CDK (TypeScript)。Bootstrap スタックと環境別の Agent スタック
eval/       評価データセット・閾値・評価スクリプト
tests/      ツールの単体テスト
docs/       検証計画
```

- リージョン: ap-northeast-1
- モデル: `jp.anthropic.claude-haiku-4-5-20251001-v1:0`（推論は東京・大阪に限られる）
- 評価器: GoalSuccessRate / Correctness / ToolSelectionAccuracy / ToolParameterAccuracy / TrajectoryInOrderMatch
- 判定: 8 問 × 3 回の評価器別の平均が、すべて 0.8 以上なら合格

## セットアップ

> 2026-10-08 に、この手順で Bootstrap から stg デプロイまで通しで確かめた。検証結果は [docs/verify-results.md](docs/verify-results.md)。

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

GitHub の新しいリポジトリでは、OIDC トークンの `sub` が `repo:owner@<ownerId>/repo@<repoId>:...` という ID 入りの形式になる。
`repo:owner/repo:...` で信頼ポリシーを書くと `Not authorized to perform sts:AssumeRoleWithWebIdentity` で失敗する。

GitHub の OIDC プロバイダ、ECR 2 つ、ロール 3 つができる。出力されたロール ARN を控える。

### 2. GitHub の設定

- ブランチ `dev`（既定）と `stg` を作る
- Environments に `dev` と `stg` を作る。`stg` に承認者を付けると、手動デプロイの前に承認を挟める
- Repository secrets に次を登録する

| secret | 値 |
|---|---|
| `AWS_DEV_DEPLOY_ROLE_ARN` | DevDeployRoleArn |
| `AWS_EVAL_ROLE_ARN` | EvalRoleArn |
| `AWS_STG_DEPLOY_ROLE_ARN` | StgDeployRoleArn |

- ブランチ保護: `stg` で `eval-gate / evaluate` を必須チェックにする。`dev` で `ci` の各ジョブを必須にする

### 3. 最初のデプロイ

dev に push すると `deploy-dev.yml` が動き、dev Runtime ができる。

## 手元での実行

```bash
uv sync --group dev --group eval
uv run pytest
uv run python eval/run_eval.py --runtime-name michikusa_dev --trials 1
```
