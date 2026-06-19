import { compute } from "computesdk";

import { createArkerComputeProvider, type ArkerComputeProviderConfig } from "./arker-provider.js";

type ComputeFactory = (config: {
  providers: unknown[];
  providerStrategy: "priority";
  fallbackOnError: true;
}) => ReturnType<typeof compute>;

let computeFactory: ComputeFactory = compute as ComputeFactory;

export type CompatSdk = ReturnType<typeof compute>;

export interface CreateCompatSdkOptions {
  arker?: ArkerComputeProviderConfig;
  fallbackProvider: unknown;
}

export function createCompatSdk(options: CreateCompatSdkOptions): CompatSdk {
  return computeFactory({
    providers: [
      createArkerComputeProvider(options.arker),
      options.fallbackProvider,
    ],
    providerStrategy: "priority",
    fallbackOnError: true,
  });
}

export function setCompatComputeFactoryForTests(factory?: ComputeFactory): void {
  computeFactory = factory ?? (compute as ComputeFactory);
}
