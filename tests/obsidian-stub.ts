export interface StubResponse {
  status: number;
  text: string;
  arrayBuffer?: ArrayBuffer;
  headers?: Record<string, string>;
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

export function requestUrl(req: StubRequest): Promise<Required<StubResponse>> {
  stub.requests.push(req);
  const r = stub.respond(req);
  return Promise.resolve({ arrayBuffer: new ArrayBuffer(0), headers: {}, ...r });
}

export const moment = () => ({ format: () => "2026-10-23 10-00" });
export const normalizePath = (p: string) => p;
