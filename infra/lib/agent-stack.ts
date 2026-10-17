import * as cdk from 'aws-cdk-lib';
import * as agentcore from 'aws-cdk-lib/aws-bedrockagentcore';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import * as iam from 'aws-cdk-lib/aws-iam';
import { Construct } from 'constructs';
import { FOUNDATION_MODEL, INFERENCE_REGIONS, MODEL_ID, Stage, repoStageOf, repositoryName, runtimeName } from './config';

export interface AgentStackProps extends cdk.StackProps {
  readonly stage: Stage;
  /** ECR のイメージタグ（agent/ フォルダのツリーハッシュ） */
  readonly imageTag: string;
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
      new agentcore.OnlineEvaluationConfig(this, 'OnlineEvaluation', {
        onlineEvaluationConfigName: `${runtimeName(props.stage)}_online`,
        description: 'stg の会話を継続的に採点する',
        dataSource: agentcore.DataSourceConfig.fromAgentRuntimeEndpoint(runtime),
        evaluators: [
          agentcore.EvaluatorSelector.builtin(agentcore.BuiltinEvaluator.CORRECTNESS),
          agentcore.EvaluatorSelector.builtin(agentcore.BuiltinEvaluator.FAITHFULNESS),
          agentcore.EvaluatorSelector.builtin(agentcore.BuiltinEvaluator.TOOL_SELECTION_ACCURACY),
          agentcore.EvaluatorSelector.builtin(agentcore.BuiltinEvaluator.REFUSAL),
        ],
        // 検証のため全件を採点する。実運用では会話量と費用に合わせて下げる
        samplingPercentage: 100,
        sessionTimeout: cdk.Duration.minutes(2),
      });
    }

    new cdk.CfnOutput(this, 'RuntimeArn', { value: runtime.agentRuntimeArn });
    new cdk.CfnOutput(this, 'RuntimeId', { value: runtime.agentRuntimeId });
    new cdk.CfnOutput(this, 'ImageTag', { value: props.imageTag });
  }
}
