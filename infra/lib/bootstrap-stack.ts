import * as cdk from 'aws-cdk-lib';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import * as iam from 'aws-cdk-lib/aws-iam';
import { Construct } from 'constructs';
import { PREFIX, Stage, repositoryName, runtimeName } from './config';

export interface BootstrapStackProps extends cdk.StackProps {
  /**
   * OIDC トークンの sub の接頭辞。GitHub の新しいリポジトリは ID 入りの形式
   * （repo:owner@ownerId/repo@repoId）が既定。gh api repos/<owner>/<repo>/actions/oidc/customization/sub で確認できる
   */
  readonly githubSubPrefix: string;
}

/**
 * 一度だけ手元からデプロイする土台。
 * GitHub OIDC プロバイダ、環境別の ECR、GitHub Actions が引き受けるロール 3 つを作る。
 */
export class BootstrapStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: BootstrapStackProps) {
    super(scope, id, props);

    const provider = new iam.OidcProviderNative(this, 'GitHubOidc', {
      url: 'https://token.actions.githubusercontent.com',
      clientIds: ['sts.amazonaws.com'],
    });

    const repos = {} as Record<Stage, ecr.Repository>;
    for (const stage of ['dev', 'stg'] as const) {
      repos[stage] = new ecr.Repository(this, `AgentRepo-${stage}`, {
        repositoryName: repositoryName(stage),
        // 同じタグで中身を差し替えられないようにする（評価済みイメージの同一性を守る）
        imageTagMutability: ecr.TagMutability.IMMUTABLE,
        imageScanOnPush: true,
        encryption: ecr.RepositoryEncryption.AES_256,
        lifecycleRules: [{ maxImageCount: 30 }],
        removalPolicy: cdk.RemovalPolicy.RETAIN,
      });
    }

    const githubPrincipal = (sub: string) =>
      new iam.WebIdentityPrincipal(provider.oidcProviderArn, {
        StringEquals: {
          'token.actions.githubusercontent.com:aud': 'sts.amazonaws.com',
          'token.actions.githubusercontent.com:sub': sub,
        },
      });

    const subPrefix = props.githubSubPrefix;
    const runtimeArn = (stage: Stage) =>
      // ランタイム本体とその endpoint（.../runtime-endpoint/DEFAULT）の両方に一致させる
      `arn:aws:bedrock-agentcore:${this.region}:${this.account}:runtime/${runtimeName(stage)}-*`;

    // cdk deploy は CDK bootstrap が作ったロールを引き受けて実行する
    const cdkRoles = new iam.PolicyStatement({
      actions: ['sts:AssumeRole'],
      resources: [`arn:aws:iam::${this.account}:role/cdk-hnb659fds-*-${this.account}-${this.region}`],
    });
    const ecrLogin = new iam.PolicyStatement({ actions: ['ecr:GetAuthorizationToken'], resources: ['*'] });
    const invokeRuntime = (stage: Stage) =>
      new iam.PolicyStatement({
        actions: ['bedrock-agentcore:InvokeAgentRuntime', 'bedrock-agentcore:GetAgentRuntime'],
        resources: [runtimeArn(stage)],
      });
    // 評価スクリプトは Runtime を名前で探す。List 系はリソース指定ができない
    const listRuntimes = new iam.PolicyStatement({
      actions: ['bedrock-agentcore:ListAgentRuntimes'],
      resources: ['*'],
    });

    // ② dev へのマージ後: ビルドして dev へデプロイ
    const devDeploy = new iam.Role(this, 'DevDeployRole', {
      roleName: `${PREFIX}-gha-dev-deploy`,
      assumedBy: githubPrincipal(`${subPrefix}:environment:dev`),
      maxSessionDuration: cdk.Duration.hours(1),
    });
    devDeploy.addToPolicy(cdkRoles);
    devDeploy.addToPolicy(ecrLogin);
    repos.dev.grantPullPush(devDeploy);
    repos.dev.grant(devDeploy, 'ecr:DescribeImages');
    devDeploy.addToPolicy(listRuntimes);
    devDeploy.addToPolicy(invokeRuntime('dev'));

    // ③ dev→stg の PR: dev Runtime を呼び出して評価する。デプロイ権限は持たせない
    const evalRole = new iam.Role(this, 'EvalRole', {
      roleName: `${PREFIX}-gha-eval`,
      assumedBy: githubPrincipal(`${subPrefix}:pull_request`),
      maxSessionDuration: cdk.Duration.hours(1),
    });
    evalRole.addToPolicy(listRuntimes);
    evalRole.addToPolicy(invokeRuntime('dev'));
    evalRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ['bedrock-agentcore:Evaluate', 'bedrock-agentcore:GetEvaluator'],
        // 組み込み評価器でも IAM 上はリージョン・アカウント付きの ARN で認可される
        // （API が返す evaluatorArn は arn:aws:bedrock-agentcore:::evaluator/Builtin.* だが、それでは許可されない）
        resources: [`arn:aws:bedrock-agentcore:${this.region}:${this.account}:evaluator/Builtin.*`],
      }),
    );
    evalRole.addToPolicy(
      new iam.PolicyStatement({
        // 評価 SDK は aws/spans と Runtime のロググループに Logs Insights クエリを投げる
        actions: ['logs:StartQuery'],
        resources: [
          `arn:aws:logs:${this.region}:${this.account}:log-group:aws/spans:*`,
          `arn:aws:logs:${this.region}:${this.account}:log-group:/aws/bedrock-agentcore/runtimes/${runtimeName('dev')}-*`,
        ],
      }),
    );
    evalRole.addToPolicy(
      // GetQueryResults / StopQuery はリソース指定ができない
      new iam.PolicyStatement({ actions: ['logs:GetQueryResults', 'logs:StopQuery'], resources: ['*'] }),
    );

    // ④ 手動の stg デプロイ: dev の ECR から stg の ECR へコピーしてデプロイ
    const stgDeploy = new iam.Role(this, 'StgDeployRole', {
      roleName: `${PREFIX}-gha-stg-deploy`,
      assumedBy: githubPrincipal(`${subPrefix}:environment:stg`),
      maxSessionDuration: cdk.Duration.hours(1),
    });
    stgDeploy.addToPolicy(cdkRoles);
    stgDeploy.addToPolicy(ecrLogin);
    repos.dev.grantPull(stgDeploy);
    repos.dev.grant(stgDeploy, 'ecr:DescribeImages');
    repos.stg.grantPullPush(stgDeploy);
    repos.stg.grant(stgDeploy, 'ecr:DescribeImages');
    stgDeploy.addToPolicy(listRuntimes);
    stgDeploy.addToPolicy(invokeRuntime('stg'));

    new cdk.CfnOutput(this, 'DevDeployRoleArn', { value: devDeploy.roleArn });
    new cdk.CfnOutput(this, 'EvalRoleArn', { value: evalRole.roleArn });
    new cdk.CfnOutput(this, 'StgDeployRoleArn', { value: stgDeploy.roleArn });
  }
}
