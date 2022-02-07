const path = require('path');
const ec2 = require('aws-cdk-lib/aws-ec2');
const ecs = require('aws-cdk-lib/aws-ecs');
const elbv2 = require('aws-cdk-lib/aws-elasticloadbalancingv2');

const { Construct } = require('constructs');
const { Duration } = require('aws-cdk-lib');
const { DockerImageAsset } = require('aws-cdk-lib/aws-ecr-assets');

const CONTAINER_NAME = 'myContainer';

class NLBUDPFargateConstruct extends Construct {
  constructor(scope, id, props = {}) {
    super(scope, id);

    const dockerImageAsset = new DockerImageAsset(this, 'ContainerImage', {
      directory: path.join(__dirname, '../resources', 'app')
    });

    const vpc = new ec2.Vpc(this, 'VPC', {
      maxAzs: 2
    });

    const nlb = new elbv2.NetworkLoadBalancer(this, 'NLB', {
      vpc: vpc,
      internetFacing: true,
      natGateways: 2
    });

    const targetGroup = new elbv2.NetworkTargetGroup(this, 'NLBTargetGroup', {
      targetGroupName: 'tgRadius',
      vpc: vpc,
      port: 1812,
      protocol: elbv2.Protocol.UDP,
      targetType: elbv2.TargetType.IP,
      healthCheck: {
        protocol: 'HTTP',
        port: '80',
        interval: Duration.seconds(10),
        healthyThresholdCount: 2,
        unhealthyThresholdCount: 2
      },
      deregistrationDelay: Duration.seconds(10)
    });
    targetGroup.setAttribute('deregistration_delay.connection_termination.enabled','true');

    const listener = nlb.addListener('NLBListener', {
      port: 1812,
      protocol: elbv2.Protocol.UDP,
      defaultTargetGroups: [ targetGroup ]
    });

    const taskDefinition = new ecs.FargateTaskDefinition(this, 'RadiusTaskDef',{
      serviceName: CONTAINER_NAME,
      cpu: 256,
      memoryMiB: 512,
      healthCheckGracePeriod: Duration.seconds(0)
    });

    const container = taskDefinition.addContainer(CONTAINER_NAME, {
      containerName: CONTAINER_NAME,
      logging: new ecs.AwsLogDriver({streamPrefix: CONTAINER_NAME}),
      protocol: ecs.Protocol.UDP,
      image: ecs.ContainerImage.fromDockerImageAsset(dockerImageAsset),
      portMappings: [
        { hostPort: 1812, containerPort: 1812, protocol: ecs.Protocol.UDP }, // radius
        { hostPort: 80, containerPort: 80, protocol: ecs.Protocol.TCP } // nlb healthCheck
      ]
    });

    const fargateCluster = new ecs.Cluster(this, 'ECSCluster', {
      clusterName: 'mfa-cluster',
      vpc: vpc,
      enableFargateCapacityProviders: true
    });

    const fargateService = new ecs.FargateService(this, 'FargateService', {
      serviceName: 'radius-svc',
      taskDefinition: taskDefinition,
      cluster: fargateCluster,
      minHealthyPercent: 0
    });

    fargateService.node.addDependency(nlb);

    fargateService.connections.allowFrom(
      ec2.Peer.ipv4('0.0.0.0/0'),
      ec2.Port.udp(1812),
      "VPC Radius"
    );

    fargateService.connections.allowFrom(
      ec2.Peer.ipv4(vpc.vpcCidrBlock),
      ec2.Port.tcp(80),
      "NLB Healthcheck"
    );

    let cfnService = fargateService.node.defaultChild;
    cfnService.loadBalancers = [{
      containerPort: 1812,
      containerName: CONTAINER_NAME,
      targetGroupArn: targetGroup.targetGroupArn
    }];
  }
}

module.exports = { NLBUDPFargateConstruct }
