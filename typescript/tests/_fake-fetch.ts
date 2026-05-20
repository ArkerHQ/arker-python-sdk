import assert from "node:assert/strict";

import { Arker } from "../src/index.js";

export type FetchCall = {
  url: string;
  method: string;
  body?: string;
  headers: Record<string, string>;
};

export type FetchScript = {
  predicate: (method: string, url: string) => boolean;
  response: Response;
};

export class FakeFetch {
  readonly calls: FetchCall[] = [];
  private readonly script: FetchScript[] = [];

  addJson(predicate: FetchScript["predicate"], status: number, body: unknown): void {
    this.script.push({
      predicate,
      response: new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      }),
    });
  }

  fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const method = init?.method ?? "GET";
    const body = typeof init?.body === "string" ? init.body : undefined;
    const headers: Record<string, string> = {};
    for (const [key, value] of Object.entries((init?.headers ?? {}) as Record<string, string>)) {
      headers[key.toLowerCase()] = value;
    }
    this.calls.push({ url, method, body, headers });

    const index = this.script.findIndex((entry) => entry.predicate(method, url));
    assert.notEqual(index, -1, `no scripted response for ${method} ${url}`);
    return this.script.splice(index, 1)[0]!.response;
  };
}

export function client(fetch: FakeFetch): Arker {
  return new Arker({
    apiKey: "ark_live_test",
    baseUrl: "https://test.invalid/api/",
    fetch: fetch.fetch,
    retry: false,
  });
}

export function regionClient(fetch: FakeFetch): Arker {
  return new Arker({
    apiKey: "ark_live_test",
    region: "aws-us-west-2",
    fetch: fetch.fetch,
    retry: false,
  });
}

export function decode(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes);
}
