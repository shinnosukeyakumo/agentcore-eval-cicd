import * as cdk from 'aws-cdk-lib';
import * as agentcore from 'aws-cdk-lib/aws-bedrockagentcore';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import * as iam from 'aws-cdk-lib/aws-iam';
import { Construct } from 'constructs';
import { QualityAlert } from './quality-alert';
import { FOUNDATION_MODEL, INFERENCE_REGIONS, MODEL_ID, Stage, repoStageOf, repositoryName, runtimeName } from './config';

export interface AgentStackProps extends cdk.StackProps {
  readonly stage: Stage;
  /** ECR のイメージタグ（agent/ フォルダのツリーハッシュ） */
  readonly imageTag: string;
  /** 品質低下の通知先（Slack のチャンネル ID）。stg でだけ使う */
  readonly slackChannel?: string;
}

export class AgentStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: AgentStackProps) {
    super(scope, id, props);

    const repository = ecr.Repository.fromRepositoryName(
      this,
      'Repo',
      repositoryName(repoStageOf(props.stage)),
    );

    const runtime = new agentcore.Runtime(this, 'Runtime', {
      runtimeName: runtimeName(props.stage),
      description: `みちくさ書房 問い合わせエージェント (${props.stage})`,
      agentRuntimeArtifact: agentcore.AgentRuntimeArtifact.fromEcrRepository(repository, props.imageTag),
      environmentVariables: {
        MODEL_ID,
        AGENT_STAGE: props.stage,
      },
    });

    runtime.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['bedrock:InvokeModel', 'bedrock:InvokeModelWithResponseStream'],
        resources: [
          `arn:aws:bedrock:${this.region}:${this.account}:inference-profile/${MODEL_ID}`,
          ...INFERENCE_REGIONS.map((r) => `arn:aws:bedrock:${r}::foundation-model/${FOUNDATION_MODEL}`),
        ],
      }),
    );

    // stg（実運用では prd）は、リリース後の実際の会話をオンライン評価で採点し続ける。
    // 正解データは渡せないので、正解なしで使える評価器だけを選ぶ
    if (props.stage === 'stg') {
      // 組み込みの評価器は「ツールの出力と矛盾しないか」を見る。ツールが消えて「計算できません」と
      // 正直に答える劣化は正しい応答として通ってしまう（V5 で確認）。業務範囲の質問に答えを返せたかを別に見る
      // カスタム評価器のメトリクス名は評価器の名前そのもの（ID は付かない）
      const taskCompletionName = `${runtimeName(props.stage)}_task_completion`;
      const taskCompletion = new agentcore.Evaluator(this, 'TaskCompletionEvaluator', {
        evaluatorName: taskCompletionName,
        level: agentcore.EvaluationLevel.TRACE,
        description: '業務範囲（本・在庫・送料）の質問に、具体的な答えを返せたか',
        evaluatorConfig: agentcore.EvaluatorConfig.llmAsAJudge({
          instructions: [
            'あなたは書店「みちくさ書房」の問い合わせ窓口エージェントの応答を採点します。',
            'この窓口の業務範囲は、本の検索、店舗ごとの在庫、送料と合計金額の計算の 3 つです。',
            '業務範囲の質問には、ツールで確かめた具体的な答え（書名、在庫数、金額など）を返す必要があります。',
            '「計算できません」「ツールが使えません」「店舗にお問い合わせください」のように答えを返せなかった場合は、理由が正直でも不合格です。',
            '本が見つからない、在庫が 0 冊のように、ツールで確かめた結果をそのまま伝えた場合は合格です。',
            '業務範囲の外の質問（ポイントカード、営業時間など）に「分かりかねます」と答えた場合は合格です。',
            '',
            '会話: {context}',
            '採点する応答: {assistant_turn}',
          ].join('\n'),
          modelId: MODEL_ID,
          ratingScale: agentcore.EvaluatorRatingScale.numerical([
            { label: 'Answered', definition: '業務範囲の質問に具体的な答えを返した、または業務範囲の外の質問を適切に断った', value: 1 },
            { label: 'Not answered', definition: '業務範囲の質問なのに、具体的な答えを返せなかった', value: 0 },
          ]),
          inferenceConfig: { temperature: 0 },
        }),
      });

      const onlineEvaluation = new agentcore.OnlineEvaluationConfig(this, 'OnlineEvaluation', {
        onlineEvaluationConfigName: `${runtimeName(props.stage)}_online`,
        description: 'stg の会話を継続的に採点する',
        dataSource: agentcore.DataSourceConfig.fromAgentRuntimeEndpoint(runtime),
        evaluators: [
          agentcore.EvaluatorSelector.builtin(agentcore.BuiltinEvaluator.CORRECTNESS),
          agentcore.EvaluatorSelector.builtin(agentcore.BuiltinEvaluator.FAITHFULNESS),
          agentcore.EvaluatorSelector.builtin(agentcore.BuiltinEvaluator.TOOL_SELECTION_ACCURACY),
          agentcore.EvaluatorSelector.builtin(agentcore.BuiltinEvaluator.REFUSAL),
          agentcore.EvaluatorSelector.custom(taskCompletion),
        ],
        // 検証のため全件を採点する。実運用では会話量と費用に合わせて下げる
        samplingPercentage: 100,
        sessionTimeout: cdk.Duration.minutes(2),
        // 型定義の説明では既定が ENABLED だが、指定しないと CloudFormation の既定（DISABLED）になる（aws-cdk-lib 2.272.0）
        executionStatus: agentcore.ExecutionStatus.ENABLED,
      });

      // 通知先のチャンネル ID を渡したときだけ、点が下がったら Slack に通知する仕組みを足す
      if (props.slackChannel) {
        const alert = new QualityAlert(this, 'QualityAlert', {
          onlineEvaluation,
          serviceName: `${runtimeName(props.stage)}.DEFAULT`,
          slackChannel: props.slackChannel,
        });
        // 閾値はリリース前のゲート（eval/config.json）と揃える。Refusal は断ったときに 1 になる指標なので鳴らさない
        alert.addScoreAlarm('CorrectnessAlarm', 'Builtin.Correctness', 0.8);
        alert.addScoreAlarm('ToolSelectionAlarm', 'Builtin.ToolSelectionAccuracy', 0.8);
        alert.addScoreAlarm('TaskCompletionAlarm', taskCompletionName, 0.8);
      }
    }

    new cdk.CfnOutput(this, 'RuntimeArn', { value: runtime.agentRuntimeArn });
    new cdk.CfnOutput(this, 'RuntimeId', { value: runtime.agentRuntimeId });
    new cdk.CfnOutput(this, 'ImageTag', { value: props.imageTag });
  }
}
