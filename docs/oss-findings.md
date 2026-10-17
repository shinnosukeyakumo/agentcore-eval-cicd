# OSS の不具合候補メモ

本作業中に見つけたものを書き留める。起票は、隔離した環境での最小再現と最新版での再現を確かめてから行う。

## 2026-10-18 aws-cdk-lib `OnlineEvaluationConfig` の `executionStatus` の既定値

- 対象: `aws-cdk-lib` 2.272.0（`aws-bedrockagentcore` の `OnlineEvaluationConfig`）
- 再現: `executionStatus` を指定せずに `OnlineEvaluationConfig` を作ってデプロイする
- 実際: 作成された設定の `executionStatus` が `DISABLED`。合成されたテンプレートに `ExecutionStatus` が出力されず、CloudFormation 側の既定が使われている
- 期待: 型定義の説明（`types.d.ts` の `OnlineEvaluationBaseProps.executionStatus`）は `@default ExecutionStatus.ENABLED`
- 疑わしい箇所: `online-evaluation.js` で `executionStatus: props.executionStatus?.value` を渡しており、未指定時に `ENABLED` を補っていない
- 回避策: `executionStatus: agentcore.ExecutionStatus.ENABLED` を明示する
