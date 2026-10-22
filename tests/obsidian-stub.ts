export interface StubResponse {
  status: number;
  text: string;
}

export interface StubRequest {
  url: string;
  method?: string;
  headers?: Record<string, string>;
  body?: string;
}

/** Tests swap this to answer requestUrl calls */
export const stub = {
  requests: [] as StubRequest[],
  respond: (_req: StubRequest): StubResponse => ({ status: 200, text: "{}" }),
};

export function requestUrl(req: StubRequest): Promise<StubResponse> {
  stub.requests.push(req);
  return Promise.resolve(stub.respond(req));
}
