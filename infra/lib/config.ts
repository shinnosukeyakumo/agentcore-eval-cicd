export const PREFIX = 'agentcore-eval-cicd';
export const REGION = 'ap-northeast-1';

export const STAGES = ['dev', 'stg'] as const;
export type Stage = (typeof STAGES)[number];

/** AgentCore Runtime 名は [a-zA-Z][a-zA-Z0-9_]{0,47}。ID は「名前-ランダム」になる */
export const runtimeName = (stage: Stage) => `michikusa_${stage}`;

/** 環境ごとの ECR リポジトリ。実案件では各アカウントの ECR に相当する */
export const repositoryName = (stage: Stage) => `${PREFIX}/agent-${stage}`;

export const MODEL_ID = 'jp.anthropic.claude-haiku-4-5-20251001-v1:0';
export const FOUNDATION_MODEL = 'anthropic.claude-haiku-4-5-20251001-v1:0';
/** jp. プロファイルの推論先（GetInferenceProfile で確認） */
export const INFERENCE_REGIONS = ['ap-northeast-1', 'ap-northeast-3'];
