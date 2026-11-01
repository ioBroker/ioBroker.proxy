import type { IncomingMessage, ServerResponse } from 'node:http';
import type { RequestHandler } from 'http-proxy-middleware';

/** A request as delivered by the express app of the web adapter (mount path already stripped from `url`) */
export interface ProxyRequest extends IncomingMessage {
    url: string;
    method: string;
}

/** The part of the express response that the extension uses */
export interface ProxyResponse extends ServerResponse {
    status(code: number): ProxyResponse;
    send(body?: unknown): ProxyResponse;
    set(field: string, value: string | number | readonly string[]): ProxyResponse;
    contentType(type: string): ProxyResponse;
}

export type NextFunction = (err?: unknown) => void;

/** The part of the express app of web that the extension uses */
export interface WebApp {
    use(path: string, handler: (req: ProxyRequest, res: ProxyResponse, next: NextFunction) => void): unknown;
}

/** A request that is currently processed by http-proxy-middleware */
export interface PendingRequest {
    req: ProxyRequest;
    res: ProxyResponse;
    ts: number;
}

/** A rule from the configuration together with its runtime state */
export interface ProxyRule {
    regex: string;
    url: string;
    timeout: number;
    parallelRequests: number;
    /** Requests in progress (http-proxy-middleware only) */
    request?: PendingRequest[];
    /** Time of the last error. Requests are rejected for `errorTimeout` ms after an error */
    lastError?: number;
    lastErrorText?: string;
    /** Status code sent while the rule is blocked after an error (simple proxy only) */
    lastStatusCode?: number;
    handler?: RequestHandler;
}
