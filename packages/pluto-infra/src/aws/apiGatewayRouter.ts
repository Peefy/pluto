import { assert } from "console";
import * as aws from "@pulumi/aws";
import * as pulumi from "@pulumi/pulumi";
import { Resource, ResourceInfra } from "@plutolang/base";
import { RouterInfra, RouterInfraOptions } from "@plutolang/pluto";
import { Api, Route } from "@pulumi/aws/apigatewayv2";
import { Lambda } from "./lambda";

export class ApiGatewayRouter
  extends pulumi.ComponentResource
  implements RouterInfra, ResourceInfra
{
  readonly name: string;

  apiGateway: Api;
  routes: Route[];
  url: pulumi.Output<string> = pulumi.interpolate`unkonwn`;

  constructor(name: string, opts?: RouterInfraOptions) {
    super("pluto:router:aws/ApiGateway", name, opts);
    this.name = name;

    this.apiGateway = new aws.apigatewayv2.Api(
      `${name}-apigateway`,
      {
        protocolType: "HTTP",
      },
      { parent: this }
    );

    this.routes = [];
  }

  /**
   *
   * @param path The URL path to handle
   * @param fn
   */
  public get(path: string, fn: Resource): void {
    if (!(fn instanceof Lambda)) throw new Error("Fn is not a subclass of LambdaDef.");
    const lambda = fn as Lambda;

    this.addHandler("GET", path, lambda);
  }

  public post(path: string, fn: Resource): void {
    if (!(fn instanceof Lambda)) throw new Error("Fn is not a subclass of LambdaDef.");
    const lambda = fn as Lambda;

    this.addHandler("POST", path, lambda);
  }

  public put(path: string, fn: Resource): void {
    if (!(fn instanceof Lambda)) throw new Error("Fn is not a subclass of LambdaDef.");
    const lambda = fn as Lambda;

    this.addHandler("PUT", path, lambda);
  }

  public delete(path: string, fn: Resource): void {
    if (!(fn instanceof Lambda)) throw new Error("Fn is not a subclass of LambdaDef.");
    const lambda = fn as Lambda;

    this.addHandler("DELETE", path, lambda);
  }

  private addHandler(op: string, path: string, fn: Lambda) {
    assert(
      ["GET", "POST", "PUT", "DELETE"].indexOf(op.toUpperCase()) != -1,
      `${op} method not allowed`
    );
    const resourceNamePrefix = `${fn.name}-${path.replace("/", "_")}-${op}`;

    // 创建一个集成
    const integration = new aws.apigatewayv2.Integration(
      `${resourceNamePrefix}-apiIntegration`,
      {
        apiId: this.apiGateway.id,
        integrationType: "AWS_PROXY",
        integrationMethod: "POST",
        integrationUri: fn.lambda.invokeArn,
      },
      { parent: this }
    );

    // 创建一个路由
    const route = new aws.apigatewayv2.Route(
      `${resourceNamePrefix}-apiRoute`,
      {
        apiId: this.apiGateway.id,
        routeKey: `${op.toUpperCase()} ${path}`,
        target: pulumi.interpolate`integrations/${integration.id}`,
        authorizationType: "NONE",
      },
      { parent: this }
    );
    this.routes.push(route);

    // 创建一个 HTTP 触发器
    new aws.lambda.Permission(
      `${resourceNamePrefix}-httpTrigger`,
      {
        action: "lambda:InvokeFunction",
        function: fn.lambda.name,
        principal: "apigateway.amazonaws.com",
        sourceArn: pulumi.interpolate`${this.apiGateway.executionArn}/*`,
      },
      { parent: this }
    );
  }

  public getPermission(op: string, resource?: ResourceInfra) {
    op;
    resource;
    throw new Error("Method not implemented.");
  }

  public postProcess() {
    const deployment = new aws.apigatewayv2.Deployment(
      `${this.name}-deployment`,
      {
        apiId: this.apiGateway.id,
      },
      { dependsOn: this.routes, parent: this }
    );

    const stage = new aws.apigatewayv2.Stage(
      `${this.name}-stage`,
      {
        apiId: this.apiGateway.id,
        deploymentId: deployment.id,
        name: "dev",
      },
      { parent: this }
    );
    this.url = stage.invokeUrl;
  }
}
