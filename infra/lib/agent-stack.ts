import * as cdk from 'aws-cdk-lib';
import * as agentcore from 'aws-cdk-lib/aws-bedrockagentcore';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import * as iam from 'aws-cdk-lib/aws-iam';
import { Construct } from 'constructs';
import { FOUNDATION_MODEL, INFERENCE_REGIONS, MODEL_ID, Stage, repositoryName, runtimeName } from './config';

export interface AgentStackProps extends cdk.StackProps {
  readonly stage: Stage;
  /** ECR のイメージタグ（agent/ フォルダのツリーハッシュ） */
  readonly imageTag: string;
}

export class AgentStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: AgentStackProps) {
    super(scope, id, props);

    const repository = ecr.Repository.fromRepositoryName(this, 'Repo', repositoryName(props.stage));

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

    new cdk.CfnOutput(this, 'RuntimeArn', { value: runtime.agentRuntimeArn });
    new cdk.CfnOutput(this, 'RuntimeId', { value: runtime.agentRuntimeId });
    new cdk.CfnOutput(this, 'ImageTag', { value: props.imageTag });
  }
}
