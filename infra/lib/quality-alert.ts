import * as cdk from 'aws-cdk-lib';
import * as agentcore from 'aws-cdk-lib/aws-bedrockagentcore';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as actions from 'aws-cdk-lib/aws-cloudwatch-actions';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as subscriptions from 'aws-cdk-lib/aws-sns-subscriptions';
import { Construct } from 'constructs';
import * as fs from 'fs';
import * as path from 'path';
import { PREFIX } from './config';

/** Slack の chat.postMessage だけを Gateway のツールとして公開する */
const SLACK_SCHEMA = {
  openapi: '3.0.0',
  info: { title: 'Slack', version: '1.0.0' },
  servers: [{ url: 'https://slack.com/api' }],
  paths: {
    '/chat.postMessage': {
      post: {
        operationId: 'chat_postMessage',
        description: 'Slack のチャンネルにメッセージを投稿する',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['channel', 'text'],
                properties: {
                  channel: { type: 'string', description: 'チャンネル ID' },
                  text: { type: 'string', description: '本文' },
                },
              },
            },
          },
        },
        responses: { '200': { description: 'Slack の応答（ok と error を含む）' } },
      },
    },
  },
};

export interface QualityAlertProps {
  /** オンライン評価の設定。メトリクスのディメンションに使う */
  readonly onlineEvaluation: agentcore.OnlineEvaluationConfig;
  /** 採点対象のサービス名（`<ランタイム名>.DEFAULT`）。メトリクスのディメンションに使う */
  readonly serviceName: string;
  /** 通知先の Slack チャンネル ID */
  readonly slackChannel: string;
}

/**
 * オンライン評価の点が閾値を割ったら Slack に通知する。
 * アラーム → SNS → Lambda → AgentCore Gateway → Slack の順に流れる。
 * Slack のボットトークンは AgentCore Identity に置き、Gateway が送信時にヘッダーへ付ける
 */
export class QualityAlert extends Construct {
  readonly topic: sns.Topic;
  private readonly props: QualityAlertProps;

  constructor(scope: Construct, id: string, props: QualityAlertProps) {
    super(scope, id);
    this.props = props;

    // トークンの値は CloudFormation に載せない。シークレットは仮の値で作り、本物は CLI で入れる（README 参照）。
    // 後のデプロイで仮の値に戻らないよう、Identity には自前のシークレットを参照させる（EXTERNAL）
    // 名前は固定しない。消したあと同じ名前は削除待ちの間（最短 7 日）作り直せないため
    const tokenSecret = new secretsmanager.Secret(this, 'SlackTokenSecret', {
      description: 'Slack のボットトークン（キーは token）',
      generateSecretString: { secretStringTemplate: '{}', generateStringKey: 'token' },
    });
    const slackToken = new agentcore.ApiKeyCredentialProvider(this, 'SlackToken', {
      apiKeyCredentialProviderName: `${PREFIX}-slack`,
    });
    // L2 は EXTERNAL を受け取らないので L1 のプロパティを直接書く
    const cfnSlackToken = slackToken.node.defaultChild as agentcore.CfnApiKeyCredentialProvider;
    cfnSlackToken.addPropertyOverride('ApiKeySecretSource', 'EXTERNAL');
    cfnSlackToken.addPropertyOverride('ApiKeySecretConfig', { SecretId: tokenSecret.secretArn, JsonKey: 'token' });

    const gateway = new agentcore.Gateway(this, 'Gateway', {
      gatewayName: `${PREFIX}-notify`,
      description: '品質低下の通知を Slack に送る',
      authorizerConfiguration: agentcore.GatewayAuthorizer.usingAwsIam(),
    });
    gateway.addOpenApiTarget('Slack', {
      gatewayTargetName: 'slack',
      apiSchema: agentcore.ApiSchema.fromInline(JSON.stringify(SLACK_SCHEMA)),
      credentialProviderConfigurations: [
        agentcore.GatewayCredentialProvider.fromApiKeyIdentity(slackToken, {
          credentialLocation: agentcore.ApiKeyCredentialLocation.header({
            credentialParameterName: 'Authorization',
            credentialPrefix: 'Bearer',
          }),
        }),
      ],
    });
    // L2 が付ける読み取り権限は Identity 管理のシークレット（bedrock-agentcore-identity!*）向けだけ
    tokenSecret.grantRead(gateway.role);

    const notifier = new lambda.Function(this, 'Notifier', {
      runtime: lambda.Runtime.PYTHON_3_13,
      handler: 'index.handler',
      code: lambda.Code.fromInline(fs.readFileSync(path.join(__dirname, '../lambda/notify_slack.py'), 'utf8')),
      timeout: cdk.Duration.seconds(30),
      environment: {
        GATEWAY_URL: gateway.gatewayUrl!,
        SLACK_CHANNEL: props.slackChannel,
        TOOL_NAME: 'slack___chat_postMessage',
      },
    });
    gateway.grantInvoke(notifier);

    this.topic = new sns.Topic(this, 'Topic', { topicName: `${PREFIX}-quality-alert` });
    this.topic.addSubscription(new subscriptions.LambdaSubscription(notifier));
  }

  /**
   * 評価器の 1 時間の平均点が閾値を下回ったら鳴るアラームを足す。
   * オンライン評価は評価器名をメトリクス名にして Bedrock-AgentCore/Evaluations に点（0〜1）を出す
   */
  addScoreAlarm(id: string, evaluator: string, threshold: number) {
    const metric = new cloudwatch.Metric({
      namespace: 'Bedrock-AgentCore/Evaluations',
      metricName: evaluator,
      dimensionsMap: {
        onlineEvaluationConfigId: this.props.onlineEvaluation.onlineEvaluationConfigId,
        'service.name': this.props.serviceName,
      },
      statistic: cloudwatch.Stats.AVERAGE,
      period: cdk.Duration.hours(1),
    });
    const alarm = new cloudwatch.Alarm(this, id, {
      alarmName: `${PREFIX}-${evaluator}`,
      metric,
      threshold,
      comparisonOperator: cloudwatch.ComparisonOperator.LESS_THAN_THRESHOLD,
      evaluationPeriods: 1,
      // 会話が無い時間帯は採点も無い。データ無しを「異常」とみなさない
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });
    alarm.addAlarmAction(new actions.SnsAction(this.topic));
    alarm.addOkAction(new actions.SnsAction(this.topic));
    return alarm;
  }
}
