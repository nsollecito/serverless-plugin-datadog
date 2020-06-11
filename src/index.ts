/*
 * Unless explicitly stated otherwise all files in this repository are licensed
 * under the Apache License Version 2.0.
 *
 * This product includes software developed at Datadog (https://www.datadoghq.com/).
 * Copyright 2019 Datadog, Inc.
 */

import * as Serverless from "serverless";
import * as layers from "./layers.json";

import { getConfig, setEnvConfiguration, forceExcludeDepsFromWebpack } from "./env";
import { applyLayers, findHandlers, FunctionInfo, RuntimeType } from "./layer";
import { enableTracing } from "./tracing";
import { redirectHandlers } from "./wrapper";
import { hasWebpackPlugin } from "./util";
import { TracingMode } from "./templates/common";
import { addCloudWatchForwarderSubscriptions } from "./forwarder";
import { FunctionDefinition } from "serverless";

// Separate interface since DefinitelyTyped currently doesn't include tags or env
export interface ExtendedFunctionDefinition extends FunctionDefinition {
  tags?: { [key: string]: string };
  environment?: { [key: string]: string };
}

enum TagKeys {
  Service = "service",
  Env = "env",
}

module.exports = class ServerlessPlugin {
  public hooks = {
    "after:datadog:clean:init": this.afterPackageFunction.bind(this),
    "after:datadog:generate:init": this.beforePackageFunction.bind(this),
    "after:deploy:function:packageFunction": this.afterPackageFunction.bind(this),
    "after:invoke:local:invoke": this.afterPackageFunction.bind(this),
    "after:package:createDeploymentArtifacts": this.afterPackageFunction.bind(this),
    "after:package:initialize": this.beforePackageFunction.bind(this),
    "before:deploy:function:packageFunction": this.beforePackageFunction.bind(this),
    "before:invoke:local:invoke": this.beforePackageFunction.bind(this),
    "before:offline:start:init": this.beforePackageFunction.bind(this),
    "before:step-functions-offline:start": this.beforePackageFunction.bind(this),
  };

  public commands = {
    datadog: {
      commands: {
        clean: {
          lifecycleEvents: ["init"],
          usage: "Cleans up wrapper handler functions for DataDog, not necessary in most cases",
        },
        generate: {
          lifecycleEvents: ["init"],
          usage: "Generates wrapper handler functions for DataDog, not necessary in most cases",
        },
      },
      lifecycleEvents: ["clean", "generate"],
      usage: "Automatically instruments your lambdas with DataDog",
    },
  };
  constructor(private serverless: Serverless, _: Serverless.Options) {}

  private async beforePackageFunction() {
    this.serverless.cli.log("Auto instrumenting functions with Datadog");
    const config = getConfig(this.serverless.service);
    setEnvConfiguration(config, this.serverless.service);

    const handlers = this.getHandlers(config.nodeModuleType);
    if (config.addLayers) {
      this.serverless.cli.log("Adding Lambda Layers to functions");
      this.debugLogHandlers(handlers);
      applyLayers(this.serverless.service.provider.region, handlers, layers);
      if (hasWebpackPlugin(this.serverless.service)) {
        forceExcludeDepsFromWebpack(this.serverless.service);
      }
    } else {
      this.serverless.cli.log("Skipping adding Lambda Layers, make sure you are packaging them yourself");
    }

    let tracingMode = TracingMode.NONE;
    if (config.enableXrayTracing && config.enableDDTracing) {
      tracingMode = TracingMode.HYBRID;
    } else if (config.enableDDTracing) {
      tracingMode = TracingMode.DD_TRACE;
    } else if (config.enableXrayTracing) {
      tracingMode = TracingMode.XRAY;
    }
    enableTracing(this.serverless.service, tracingMode);
  }
  private async afterPackageFunction() {
    const config = getConfig(this.serverless.service);
    if (config.forwarder) {
      const aws = this.serverless.getProvider("aws");
      const errors = await addCloudWatchForwarderSubscriptions(this.serverless.service, aws, config.forwarder);
      for (const error of errors) {
        this.serverless.cli.log(error);
      }
    }

    if (config.enableTags) {
      this.serverless.cli.log("Adding service and environment tags to functions");
      this.addServiceAndEnvTags();
    }

    const handlers = this.getHandlers(config.nodeModuleType);
    redirectHandlers(this.serverless.service, handlers, config.addLayers);
  }

  private debugLogHandlers(handlers: FunctionInfo[]) {
    for (const handler of handlers) {
      if (handler.type === RuntimeType.UNSUPPORTED) {
        if (handler.runtime === undefined) {
          this.serverless.cli.log(`Unable to determine runtime for function ${handler.name}`);
        } else {
          this.serverless.cli.log(
            `Unable to add Lambda Layers to function ${handler.name} with runtime ${handler.runtime}`,
          );
        }
      }
    }
  }

  private addServiceAndEnvTags() {
    this.serverless.service.getAllFunctions().forEach((functionName) => {
      const functionDefintion: ExtendedFunctionDefinition = this.serverless.service.getFunction(functionName);

      if (!functionDefintion.tags) {
        functionDefintion.tags = {};
      }

      // Service tag
      if (!functionDefintion.tags[TagKeys.Service]) {
        functionDefintion.tags[TagKeys.Service] = this.serverless.service.getServiceName();
      }

      // Environment tag
      if (!functionDefintion.tags[TagKeys.Env]) {
        functionDefintion.tags[TagKeys.Env] = this.serverless.getProvider("aws").getStage();
      }
    });
  }

  private getHandlers(nodeModuleType: "es6" | "node" | "typescript" | undefined) {
    const defaultRuntime = this.serverless.service.provider.runtime;
    let defaultNodeRuntime: RuntimeType.NODE | RuntimeType.NODE_ES6 | RuntimeType.NODE_TS | undefined;
    switch (nodeModuleType) {
      case "es6":
        defaultNodeRuntime = RuntimeType.NODE_ES6;
        break;
      case "typescript":
        defaultNodeRuntime = RuntimeType.NODE_TS;
        break;
      case "node":
        defaultNodeRuntime = RuntimeType.NODE;
        break;
    }
    return findHandlers(this.serverless.service, defaultRuntime, defaultNodeRuntime);
  }
};
