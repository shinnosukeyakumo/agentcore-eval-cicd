import * as cdk from 'aws-cdk-lib';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import * as iam from 'aws-cdk-lib/aws-iam';
import { Construct } from 'constructs';
import { RepoStage, Stage, repositoryName, roleName, runtimeName } from './config';

interface BootstrapProps extends cdk.StackProps {
  /**
   * OIDC トークンの sub の接頭辞。GitHub の新しいリポジトリは ID 入りの形式
   * （repo:owner@ownerId/repo@repoId）が既定。gh api repos/<owner>/<repo>/actions/oidc/customization/sub で確認できる
   */
  readonly githubSubPrefix: string;
}

export interface DevBootstrapStackProps extends BootstrapProps {
  /** stg アカウントの ID。dev の ECR を stg のデプロイ用ロールに読ませるために使う */
  readonly stgAccount: string;
}

export interface StgBootstrapStackProps extends BootstrapProps {
  /** dev アカウントの ID。dev の ECR からイメージをコピーするために使う */
  readonly devAccount: string;
}

/** 両アカウントで共通の部品（OIDC プロバイダ、ECR、ロールの信頼関係、よく使う権限） */
class Common {
  readonly provider: iam.OidcProviderNative;

  constructor(
    private readonly stack: cdk.Stack,
    private readonly subPrefix: string,
  ) {
    this.provider = new iam.OidcProviderNative(stack, 'GitHubOidc', {
      url: 'https://token.actions.githubusercontent.com',
      clientIds: ['sts.amazonaws.com'],
    });
  }

  repository(stage: RepoStage): ecr.Repository {
    return new ecr.Repository(this.stack, `AgentRepo-${stage}`, {
      repositoryName: repositoryName(stage),
      // 同じタグで中身を差し替えられないようにする（評価済みイメージの同一性を守る）
      imageTagMutability: ecr.TagMutability.IMMUTABLE,
      imageScanOnPush: true,
      encryption: ecr.RepositoryEncryption.AES_256,
      lifecycleRules: [{ maxImageCount: 30 }],
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });
  }

  role(id: string, purpose: Parameters<typeof roleName>[0], subSuffix: string): iam.Role {
    return new iam.Role(this.stack, id, {
      roleName: roleName(purpose),
      assumedBy: new iam.WebIdentityPrincipal(this.provider.oidcProviderArn, {
        StringEquals: {
          'token.actions.githubusercontent.com:aud': 'sts.amazonaws.com',
          'token.actions.githubusercontent.com:sub': `${this.subPrefix}:${subSuffix}`,
        },
      }),
      maxSessionDuration: cdk.Duration.hours(1),
    });
  }

  runtimeArn(stage: Stage): string {
    // ランタイム本体とその endpoint（.../runtime-endpoint/DEFAULT）の両方に一致させる
    return `arn:aws:bedrock-agentcore:${this.stack.region}:${this.stack.account}:runtime/${runtimeName(stage)}-*`;
  }

  /** cdk deploy は CDK bootstrap が作ったロールを引き受けて実行する */
  get cdkRoles(): iam.PolicyStatement {
    const { account, region } = this.stack;
    return new iam.PolicyStatement({
      actions: ['sts:AssumeRole'],
      resources: [`arn:aws:iam::${account}:role/cdk-hnb659fds-*-${account}-${region}`],
    });
  }

  get ecrLogin(): iam.PolicyStatement {
    return new iam.PolicyStatement({ actions: ['ecr:GetAuthorizationToken'], resources: ['*'] });
  }

  /** 評価スクリプトは Runtime を名前で探す。List 系はリソース指定ができない */
  get listRuntimes(): iam.PolicyStatement {
    return new iam.PolicyStatement({ actions: ['bedrock-agentcore:ListAgentRuntimes'], resources: ['*'] });
  }

  invokeRuntime(stage: Stage): iam.PolicyStatement {
    return new iam.PolicyStatement({
      actions: ['bedrock-agentcore:InvokeAgentRuntime', 'bedrock-agentcore:GetAgentRuntime'],
      resources: [this.runtimeArn(stage)],
    });
  }
}

/** dev のイメージを読むのに要る ECR の操作（コピー元としての読み取り） */
const ECR_READ_ACTIONS = [
  'ecr:BatchGetImage',
  'ecr:GetDownloadUrlForLayer',
  'ecr:BatchCheckLayerAvailability',
  'ecr:DescribeImages',
];

/**
 * dev アカウントの土台。手元から一度だけデプロイする（stg アカウントの土台より後に）。
 * OIDC プロバイダ、dev の ECR、dev デプロイ用ロール、評価用ロールを作る。
 */
export class DevBootstrapStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: DevBootstrapStackProps) {
    super(scope, id, props);
    const c = new Common(this, props.githubSubPrefix);
    const repo = c.repository('dev');

    // stg アカウントのデプロイ用ロールに、dev の ECR からの読み取りを許す。
    // 相手側の IAM ポリシーと、こちらのリポジトリポリシーの両方で許可して初めて通る
    repo.addToResourcePolicy(
      new iam.PolicyStatement({
        sid: 'AllowStgDeployRoleToCopy',
        principals: [new iam.ArnPrincipal(`arn:aws:iam::${props.stgAccount}:role/${roleName('stg-deploy')}`)],
        actions: ECR_READ_ACTIONS,
      }),
    );

    // ② dev へのマージ後: ビルドして dev へデプロイ
    const devDeploy = c.role('DevDeployRole', 'dev-deploy', 'environment:dev');
    devDeploy.addToPolicy(c.cdkRoles);
    devDeploy.addToPolicy(c.ecrLogin);
    repo.grantPullPush(devDeploy);
    repo.grant(devDeploy, 'ecr:DescribeImages');
    devDeploy.addToPolicy(c.listRuntimes);
    devDeploy.addToPolicy(c.invokeRuntime('dev'));

    // ③ release/* → stg の PR: rc Runtime をリリース候補のイメージに差し替えて評価する。
    // cdk deploy は使わず UpdateAgentRuntime で rc のイメージだけを替えるので、CDK のロールは渡さない。
    // このロールは stg アカウントに一切触れられない（アカウントの境界で守られる）
    const evalRole = c.role('EvalRole', 'eval', 'pull_request');
    evalRole.addToPolicy(c.listRuntimes);
    evalRole.addToPolicy(c.invokeRuntime('rc'));
    evalRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ['bedrock-agentcore:UpdateAgentRuntime'],
        resources: [c.runtimeArn('rc')],
      }),
    );
    evalRole.addToPolicy(
      // UpdateAgentRuntime は実行ロールの指定を必須とするため、rc の実行ロールだけを渡せるようにする
      new iam.PolicyStatement({
        actions: ['iam:PassRole'],
        resources: [`arn:aws:iam::${this.account}:role/AgentCoreEvalCicd-rc-*`],
        conditions: { StringEquals: { 'iam:PassedToService': 'bedrock-agentcore.amazonaws.com' } },
      }),
    );
    // リリース候補のイメージが dev の ECR にあるかを確かめる
    repo.grant(evalRole, 'ecr:DescribeImages');
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
          `arn:aws:logs:${this.region}:${this.account}:log-group:/aws/bedrock-agentcore/runtimes/${runtimeName('rc')}-*`,
        ],
      }),
    );
    evalRole.addToPolicy(
      // GetQueryResults / StopQuery はリソース指定ができない
      new iam.PolicyStatement({ actions: ['logs:GetQueryResults', 'logs:StopQuery'], resources: ['*'] }),
    );

    new cdk.CfnOutput(this, 'DevDeployRoleArn', { value: devDeploy.roleArn });
    new cdk.CfnOutput(this, 'EvalRoleArn', { value: evalRole.roleArn });
  }
}

/**
 * stg アカウントの土台。手元から一度だけデプロイする（dev アカウントの土台より先に）。
 * OIDC プロバイダ、stg の ECR、stg デプロイ用ロールを作る。
 */
export class StgBootstrapStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: StgBootstrapStackProps) {
    super(scope, id, props);
    const c = new Common(this, props.githubSubPrefix);
    const repo = c.repository('stg');

    // ④ 手動の stg デプロイ: dev の ECR から stg の ECR へコピーしてデプロイ
    const stgDeploy = c.role('StgDeployRole', 'stg-deploy', 'environment:stg');
    stgDeploy.addToPolicy(c.cdkRoles);
    stgDeploy.addToPolicy(c.ecrLogin);
    stgDeploy.addToPolicy(
      // 別アカウントの ECR を読むには、こちらの IAM ポリシーと dev 側のリポジトリポリシーの両方が要る
      new iam.PolicyStatement({
        actions: ECR_READ_ACTIONS,
        resources: [`arn:aws:ecr:${this.region}:${props.devAccount}:repository/${repositoryName('dev')}`],
      }),
    );
    repo.grantPullPush(stgDeploy);
    repo.grant(stgDeploy, 'ecr:DescribeImages');
    stgDeploy.addToPolicy(c.listRuntimes);
    stgDeploy.addToPolicy(c.invokeRuntime('stg'));

    new cdk.CfnOutput(this, 'StgDeployRoleArn', { value: stgDeploy.roleArn });
  }
}
