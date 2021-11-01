import * as path from "path";
import { Worker } from "worker_threads";

import { Env, toError } from "./Helpers";
import { NonEmptyArray } from "./NonEmptyArray";
import { absoluteDirname } from "./PathHelpers";
import { Command, ExitReason, spawnKillable, SpawnResult } from "./Spawn";
import {
  AbsolutePath,
  CompilationMode,
  ElmWatchJsonPath,
  ElmWatchNodeScriptPath,
  OutputPath,
  RunMode,
} from "./Types";

export const ELM_WATCH_NODE = "elm-watch-node";

export type Postprocess =
  | {
      tag: "NoPostprocess";
    }
  | {
      tag: "Postprocess";
      postprocessArray: NonEmptyArray<string>;
    };

export type PostprocessResult<Code = Buffer> =
  | PostprocessError
  | {
      tag: "Success";
      code: Code;
    };

export type PostprocessError =
  | {
      tag: "CommandNotFoundError";
      command: Command;
    }
  | {
      tag: "ElmWatchNodeBadReturnValue";
      scriptPath: ElmWatchNodeScriptPath;
      args: Array<string>;
      returnValue: UnknownValueAsString;
      stdout: string;
      stderr: string;
    }
  | {
      tag: "ElmWatchNodeDefaultExportNotFunction";
      scriptPath: ElmWatchNodeScriptPath;
      imported: UnknownValueAsString;
      typeofDefault: string;
      stdout: string;
      stderr: string;
    }
  | {
      tag: "ElmWatchNodeImportError";
      scriptPath: ElmWatchNodeScriptPath;
      error: UnknownValueAsString;
      stdout: string;
      stderr: string;
    }
  | {
      tag: "ElmWatchNodeMissingScript";
    }
  | {
      tag: "ElmWatchNodeRunError";
      scriptPath: ElmWatchNodeScriptPath;
      args: Array<string>;
      error: UnknownValueAsString;
      stdout: string;
      stderr: string;
    }
  | {
      tag: "OtherSpawnError";
      error: Error;
      command: Command;
    }
  | {
      tag: "PostprocessNonZeroExit";
      exitReason: ExitReason;
      stdout: string;
      stderr: string;
      command: Command;
    }
  | {
      tag: "PostprocessStdinWriteError";
      error: Error;
      command: Command;
    };

// It’s not possible to send any value between workers and the main thread. We
// just show unknown values (such as caught errors and return values) in error
// messages, so we can seralize them in the worker instead. This type helps
// making sure we remember to do that correctly.
export type UnknownValueAsString = {
  tag: "UnknownValueAsString";
  value: string;
};

export function runPostprocess({
  env,
  elmWatchJsonPath,
  compilationMode,
  runMode,
  outputPath: output,
  postprocessArray,
  code,
  postprocessWorkerPool,
}: {
  env: Env;
  elmWatchJsonPath: ElmWatchJsonPath;
  compilationMode: CompilationMode;
  runMode: RunMode;
  outputPath: OutputPath;
  postprocessArray: NonEmptyArray<string>;
  postprocessWorkerPool: PostprocessWorkerPool;
  code: Buffer | string;
}): { promise: Promise<PostprocessResult>; kill: () => Promise<void> } {
  const commandName = postprocessArray[0];
  const userArgs = postprocessArray.slice(1);
  const extraArgs = [output.targetName, compilationMode, runMode];
  const cwd = absoluteDirname(elmWatchJsonPath.theElmWatchJsonPath);

  if (commandName === ELM_WATCH_NODE) {
    const worker = postprocessWorkerPool.getOrCreateAvailableWorker();
    return {
      promise: worker.postprocess({
        cwd,
        userArgs,
        extraArgs,
        code: code.toString("utf8"),
      }),
      kill: () => worker.terminate(),
    };
  }

  const command: Command = {
    command: commandName,
    args: [...userArgs, ...extraArgs],
    options: { cwd, env },
    stdin: code,
  };

  const { promise, kill } = spawnKillable(command);

  const handleSpawnResult = (spawnResult: SpawnResult): PostprocessResult => {
    switch (spawnResult.tag) {
      case "CommandNotFoundError":
      case "OtherSpawnError":
        return spawnResult;

      case "StdinWriteError":
        return {
          tag: "PostprocessStdinWriteError",
          error: spawnResult.error,
          command: spawnResult.command,
        };

      case "Exit": {
        const { exitReason } = spawnResult;

        if (!(exitReason.tag === "ExitCode" && exitReason.exitCode === 0)) {
          const stdout = spawnResult.stdout.toString("utf8");
          const stderr = spawnResult.stderr.toString("utf8");
          return {
            tag: "PostprocessNonZeroExit",
            exitReason,
            stdout,
            stderr,
            command,
          };
        }

        return { tag: "Success", code: spawnResult.stdout };
      }
    }
  };

  return {
    promise: promise.then(handleSpawnResult),
    kill: () => {
      kill();
      return Promise.resolve();
    },
  };
}

// Keeps track of several `PostprocessWorker`s. Note: `Compile.getOutputActions`
// makes sure that at the most N things (not just workers) are running at the
// same time.
export class PostprocessWorkerPool {
  private workers = new Set<PostprocessWorker>();

  private calculateMax: () => number = () => Infinity;

  constructor(private onUnexpectedError: (error: Error) => void) {}

  setCalculateMax(calculateMax: () => number): void {
    this.calculateMax = calculateMax;
  }

  getOrCreateAvailableWorker(): PostprocessWorker {
    const existingWorker = Array.from(this.workers).find((worker) =>
      worker.isIdle()
    );
    if (existingWorker === undefined) {
      const newWorker = new PostprocessWorker(
        this.onUnexpectedError,
        () => {
          this.limit().catch(this.onUnexpectedError);
        },
        (worker) => {
          this.workers.delete(worker);
        }
      );
      this.workers.add(newWorker);
      return newWorker;
    } else {
      return existingWorker;
    }
  }

  async limit(): Promise<void> {
    const idle = Array.from(this.workers).filter((worker) => worker.isIdle());
    const toKill = this.workers.size - this.calculateMax();
    if (toKill > 0) {
      await Promise.all(
        idle.slice(-toKill).map((worker) => worker.terminate())
      );
    }
  }

  async terminate(): Promise<void> {
    await Promise.all(
      Array.from(this.workers).map((worker) => worker.terminate())
    );
  }
}

export type ElmWatchNodeArgs = {
  cwd: AbsolutePath;
  userArgs: Array<string>;
  extraArgs: Array<string>;
  code: string;
};

type PostprocessWorkerStatus =
  | {
      tag: "Busy";
      resolve: (result: PostprocessResult) => void;
      reject: (error: Error) => void;
    }
  | {
      tag: "Idle";
    }
  | {
      tag: "Terminated";
    };

export type MessageToWorker = {
  tag: "StartPostprocess";
  args: ElmWatchNodeArgs;
};

export type MessageFromWorker = {
  tag: "PostprocessDone";
  result:
    | { tag: "Reject"; error: unknown }
    | { tag: "Resolve"; value: PostprocessResult<string> };
};

export const WORKER_TERMINATED = new Error(
  "`PostprocessWorker` has a `terminate` method. That was called! This error is supposed to be caught."
);

class PostprocessWorker {
  private worker = new Worker(path.join(__dirname, "PostprocessWorker"), {
    stdout: true,
    stderr: true,
  });

  private status: PostprocessWorkerStatus = { tag: "Idle" };

  constructor(
    private onUnexpectedError: (error: Error) => void,
    private onIdle: (worker: PostprocessWorker) => void,
    private onTerminated: (worker: PostprocessWorker) => void
  ) {
    const stdout: Array<Buffer> = [];
    const stderr: Array<Buffer> = [];

    this.worker.stdout.on("data", (chunk: Buffer) => {
      stdout.push(chunk);
    });

    this.worker.stderr.on("data", (chunk: Buffer) => {
      stderr.push(chunk);
    });

    // istanbul ignore next
    this.worker.on("error", (error) => {
      if (this.status.tag !== "Terminated") {
        this.status = { tag: "Terminated" };
        this.onTerminated(this);
        this.onUnexpectedError(error);
      }
    });

    // istanbul ignore next
    this.worker.on("messageerror", (error) => {
      if (this.status.tag !== "Terminated") {
        this.status = { tag: "Terminated" };
        this.onTerminated(this);
        this.onUnexpectedError(error);
      }
    });

    this.worker.on("exit", (exitCode) => {
      // istanbul ignore if
      if (this.status.tag !== "Terminated") {
        this.status = { tag: "Terminated" };
        this.onTerminated(this);
        this.onUnexpectedError(
          new Error(
            `PostprocessWorker unexpectedly exited, with exit code ${exitCode}.`
          )
        );
      }
    });

    this.worker.on("message", (message: MessageFromWorker) => {
      switch (message.tag) {
        case "PostprocessDone":
          switch (this.status.tag) {
            // istanbul ignore next
            case "Idle":
              this.terminate().catch(this.onUnexpectedError);
              this.onUnexpectedError(
                new Error(
                  `PostprocessWorker received a ${JSON.stringify(
                    message.tag
                  )} message from the worker. This should only happen when "Busy" but the status is "Idle".`
                )
              );
              break;

            case "Busy":
              switch (message.result.tag) {
                case "Resolve": {
                  const result = message.result.value;
                  this.status.resolve(
                    result.tag === "Success"
                      ? { ...result, code: Buffer.from(result.code) }
                      : "stdout" in result
                      ? {
                          ...result,
                          stdout: Buffer.concat(stdout).toString("utf8"),
                          stderr: Buffer.concat(stderr).toString("utf8"),
                        }
                      : result
                  );
                  break;
                }

                // istanbul ignore next
                case "Reject":
                  this.status.reject(toError(message.result.error));
                  break;
              }
              this.status = { tag: "Idle" };
              this.onIdle(this);
              break;

            // istanbul ignore next
            case "Terminated":
              break;
          }

          stdout.length = 0;
          stderr.length = 0;
      }
    });
  }

  private postMessage(message: MessageToWorker): void {
    this.worker.postMessage(message);
  }

  isIdle(): boolean {
    return this.status.tag === "Idle";
  }

  async postprocess(args: ElmWatchNodeArgs): Promise<PostprocessResult> {
    switch (this.status.tag) {
      case "Idle":
        return new Promise((resolve, reject) => {
          this.status = { tag: "Busy", resolve, reject };
          this.postMessage({ tag: "StartPostprocess", args });
        });

      // istanbul ignore next
      case "Busy":
      // istanbul ignore next
      case "Terminated":
        throw new Error(
          `Cannot call PostprocessWorker#postprocess because \`this.status === ${JSON.stringify(
            this.status
          )}\` instead of the expected ${JSON.stringify(this.status)}.`
        );
    }
  }

  async terminate(): Promise<void> {
    switch (this.status.tag) {
      case "Idle":
        this.status = { tag: "Terminated" };
        this.onTerminated(this);
        await this.worker.terminate();
        break;

      case "Busy": {
        const { reject } = this.status;
        this.status = { tag: "Terminated" };
        this.onTerminated(this);
        await this.worker.terminate();
        reject(WORKER_TERMINATED);
        break;
      }

      case "Terminated":
        // Do nothing.
        break;
    }
  }
}
