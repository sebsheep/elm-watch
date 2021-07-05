import * as WebSocket from "ws";

import * as Errors from "./Errors";
import { Port, PortChoice } from "./Port";

export type WebSocketServerMsg =
  | {
      tag: "WebSocketClosed";
      webSocket: WebSocket;
    }
  | {
      tag: "WebSocketConnected";
      webSocket: WebSocket;
      urlString: string;
    }
  | {
      tag: "WebSocketMessageReceived";
      webSocket: WebSocket;
      data: WebSocket.Data;
    };

type Options = {
  portChoice: PortChoice;
  rejectPromise: (error: Error) => void;
};

export class WebSocketServer {
  webSocketServer: WebSocket.Server;

  port: Port;

  dispatch: (msg: WebSocketServerMsg) => void;

  msgQueue: Array<WebSocketServerMsg> = [];

  constructor(options: Options) {
    const { webSocketServer, port } = this.init(options);
    this.webSocketServer = webSocketServer;
    this.port = port;
    this.dispatch = this.dispatchToQueue;
  }

  init({ portChoice, rejectPromise }: Options): {
    webSocketServer: WebSocket.Server;
    port: Port;
  } {
    const webSocketServer = new WebSocket.Server({
      // If `port` is 0, the operating system will assign an arbitrary unused port.
      port: portChoice.tag === "NoPort" ? 0 : portChoice.port.thePort,
    });
    const { port } = webSocketServer.address() as WebSocket.AddressInfo;

    webSocketServer.on("connection", (webSocket, request) => {
      this.dispatch({
        tag: "WebSocketConnected",
        webSocket,
        // `request.url` is always a string here, but the types says it can be undefined:
        // https://github.com/DefinitelyTyped/DefinitelyTyped/issues/15808
        urlString: request.url ?? "/",
      });

      webSocket.on("message", (data) => {
        this.dispatch({ tag: "WebSocketMessageReceived", webSocket, data });
      });

      webSocket.on("close", () => {
        this.dispatch({ tag: "WebSocketClosed", webSocket });
      });

      webSocket.on("error", rejectPromise);
    });

    webSocketServer.on("error", (error: Error & { code?: string }) => {
      if (error.code === "EADDRINUSE") {
        switch (portChoice.tag) {
          case "PersistedPort": {
            // The port we used last time is not available. Get a new one.
            webSocketServer.close();
            const next = this.init({
              portChoice: { tag: "NoPort" },
              rejectPromise,
            });
            this.webSocketServer = next.webSocketServer;
            this.port = next.port;
            return;
          }

          case "PortFromConfig":
            // “Abusing” fatal errors for a nice error is non-ideal, but people
            // generally won’t have a need to configure a certain port anyway.
            rejectPromise({
              name: "Error",
              message: Errors.portConflict(portChoice.port),
            });
            return;

          case "NoPort":
            rejectPromise(error);
            return;
        }
      } else {
        rejectPromise(error);
      }
    });

    return { webSocketServer, port: { tag: "Port", thePort: port } };
  }

  dispatchToQueue = (msg: WebSocketServerMsg): void => {
    this.msgQueue.push(msg);
  };

  setDispatch(dispatch: (msg: WebSocketServerMsg) => void): void {
    this.dispatch = dispatch;
    for (const msg of this.msgQueue) {
      dispatch(msg);
    }
  }

  unsetDispatch(): void {
    this.dispatch = this.dispatchToQueue;
  }

  async close(): Promise<void> {
    return new Promise((resolve, reject) => {
      // This terminates all connections and closes the server.
      this.webSocketServer.close((error) => {
        if (error === undefined) {
          resolve();
        } else {
          reject(error);
        }
      });
    });
  }
}