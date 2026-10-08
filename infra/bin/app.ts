#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { AgentStack } from '../lib/agent-stack';
import { BootstrapStack } from '../lib/bootstrap-stack';
import { REGION, STAGES, Stage } from '../lib/config';

const app = new cdk.App();
const env = { account: process.env.CDK_DEFAULT_ACCOUNT, region: REGION };

new BootstrapStack(app, 'AgentCoreEvalCicd-Bootstrap', {
  env,
  githubRepo: app.node.tryGetContext('githubRepo') ?? 'shinnosukeyakumo/agentcore-eval-cicd',
});

// imageTag を渡したときだけ環境スタックを合成する（Bootstrap 単独デプロイ時は不要なため）
const imageTag: string | undefined = app.node.tryGetContext('imageTag');
if (imageTag) {
  for (const stage of STAGES) {
    new AgentStack(app, `AgentCoreEvalCicd-${stage}`, { env, stage: stage as Stage, imageTag });
  }
}

cdk.Tags.of(app).add('project', 'agentcore-eval-cicd');
