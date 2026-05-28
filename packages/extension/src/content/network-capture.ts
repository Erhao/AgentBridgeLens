interface NetworkEntry {
  url: string;
  method: string;
  status: number;
  statusText: string;
  type: string;
  duration: number;
  timestamp: number;
  requestHeaders?: Record<string, string>;
  responseHeaders?: Record<string, string>;
  size?: number;
}

const MAX_ENTRIES = 200;
const requests: NetworkEntry[] = [];

const originalFetch = window.fetch.bind(window);
const OriginalXHR = window.XMLHttpRequest;

export function startCapture() {
  window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const method = init?.method || "GET";
    const start = Date.now();

    try {
      const response = await originalFetch(input, init);
      const entry: NetworkEntry = {
        url,
        method,
        status: response.status,
        statusText: response.statusText,
        type: "fetch",
        duration: Date.now() - start,
        timestamp: start,
      };
      pushEntry(entry);
      return response;
    } catch (err) {
      pushEntry({
        url,
        method,
        status: 0,
        statusText: "Network Error",
        type: "fetch",
        duration: Date.now() - start,
        timestamp: start,
      });
      throw err;
    }
  };

  const XHRProxy = class extends OriginalXHR {
    private _url = "";
    private _method = "GET";
    private _start = 0;

    open(method: string, url: string | URL, ...args: unknown[]) {
      this._method = method;
      this._url = url.toString();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return (super.open as any)(method, url, ...args);
    }

    send(body?: Document | XMLHttpRequestBodyInit | null) {
      this._start = Date.now();
      this.addEventListener("loadend", () => {
        pushEntry({
          url: this._url,
          method: this._method,
          status: this.status,
          statusText: this.statusText,
          type: "xhr",
          duration: Date.now() - this._start,
          timestamp: this._start,
        });
      });
      return super.send(body);
    }
  };
  window.XMLHttpRequest = XHRProxy as unknown as typeof XMLHttpRequest;
}

function pushEntry(entry: NetworkEntry) {
  requests.push(entry);
  if (requests.length > MAX_ENTRIES) requests.shift();
}

export function getNetworkRequests(
  urlPattern?: string,
  status?: number
): NetworkEntry[] {
  let filtered = requests;
  if (urlPattern) {
    filtered = filtered.filter((r) => r.url.includes(urlPattern));
  }
  if (status !== undefined) {
    filtered = filtered.filter((r) => r.status === status);
  }
  return filtered;
}
