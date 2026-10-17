#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { AgentStack } from '../lib/agent-stack';
import { DevBootstrapStack, StgBootstrapStack } from '../lib/bootstrap-stack';
import { REGION, STAGES, Stage } from '../lib/config';

const app = new cdk.App();
// 環境スタックは、そのとき使っている認証情報のアカウントにデプロイする
// （deploy-dev は dev アカウント、deploy-stg は stg アカウントのロールで動く）
const env = { account: process.env.CDK_DEFAULT_ACCOUNT, region: REGION };

// 土台のスタックは、両方のアカウント ID を渡したときだけ合成する。
// 公開リポジトリなのでアカウント ID はコードに書かない。手元から一度だけデプロイする:
//   npx cdk deploy AgentCoreEvalCicd-StgBootstrap --profile stg -c devAccount=... -c stgAccount=...
//   npx cdk deploy AgentCoreEvalCicd-Bootstrap -c devAccount=... -c stgAccount=...
const devAccount: string | undefined = app.node.tryGetContext('devAccount');
const stgAccount: string | undefined = app.node.tryGetContext('stgAccount');
const githubSubPrefix: string =
  app.node.tryGetContext('githubSubPrefix') ?? 'repo:shinnosukeyakumo@95732356/agentcore-eval-cicd@1410313181';
if (devAccount && stgAccount) {
  new DevBootstrapStack(app, 'AgentCoreEvalCicd-Bootstrap', {
    env: { account: devAccount, region: REGION },
    githubSubPrefix,
    stgAccount,
  });
  new StgBootstrapStack(app, 'AgentCoreEvalCicd-StgBootstrap', {
    env: { account: stgAccount, region: REGION },
    githubSubPrefix,
    devAccount,
  });
}

// imageTag を渡したときだけ環境スタックを合成する
const imageTag: string | undefined = app.node.tryGetContext('imageTag');
if (imageTag) {
  for (const stage of STAGES) {
    new AgentStack(app, `AgentCoreEvalCicd-${stage}`, { env, stage: stage as Stage, imageTag });
  }
}

cdk.Tags.of(app).add('project', 'agentcore-eval-cicd');
