import { repr } from "tiny-decoders";
import { MessagePort, parentPort } from "worker_threads";

import { unknownErrorToString } from "./Helpers";
import { isNonEmptyArray } from "./NonEmptyArray";
import { absolutePathFromString } from "./PathHelpers";
import type {
  ElmWatchNodeArgs,
  MessageFromWorker,
  MessageToWorker,
  PostprocessResult,
  UnknownValueAsString,
} from "./Postprocess";
import type { ElmWatchNodeScriptPath } from "./Types";

// Many errors are typed to always have `stdout` and `stderr`. They are captured
// from the worker in `Postprocess.ts`, not here, though. By including this
// empty stdio we can still use the same type. A bit weird, but it works.
const emptyStdio = {
  stdout: "",
  stderr: "",
};

type PortWrapper = {
  postMessage: (message: MessageFromWorker) => void;
  on: MessagePort["on"];
};

function main(port: PortWrapper): void {
  port.on("messageerror", (error) => {
    throw error;
  });

  port.on("message", (message: MessageToWorker) => {
    switch (message.tag) {
      case "StartPostprocess":
        elmWatchNode(message.args).then(
          (result) => {
            port.postMessage({
              tag: "PostprocessDone",
              result: { tag: "Resolve", value: result },
            });
          },
          (error: unknown) => {
            port.postMessage({
              tag: "PostprocessDone",
              result: { tag: "Reject", error },
            });
          }
        );
        break;
    }
  });
}

async function elmWatchNode({
  cwd,
  userArgs,
  extraArgs,
  code,
}: ElmWatchNodeArgs): Promise<PostprocessResult> {
  if (!isNonEmptyArray(userArgs)) {
    return { tag: "ElmWatchNodeMissingScript" };
  }

  const scriptPath: ElmWatchNodeScriptPath = {
    tag: "ElmWatchNodeScriptPath",
    theElmWatchNodeScriptPath: absolutePathFromString(cwd, userArgs[0]),
  };

  let imported;
  try {
    imported = (await import(
      scriptPath.theElmWatchNodeScriptPath.absolutePath
    )) as Record<string, unknown>;
  } catch (unknownError) {
    return {
      tag: "ElmWatchNodeImportError",
      scriptPath,
      error: unknownValueAsString(unknownError, importErrorToString),
      ...emptyStdio,
    };
  }

  if (typeof imported.default !== "function") {
    return {
      tag: "ElmWatchNodeDefaultExportNotFunction",
      scriptPath,
      imported: unknownValueAsString(
        // To/from entries is needed. Otherwise `repr` prints `"Module"`.
        Object.fromEntries(Object.entries(imported)),
        (value) => repr(value, { maxObjectChildren: 10 })
      ),
      typeofDefault: typeof imported.default,
      ...emptyStdio,
    };
  }

  const args = [code, ...userArgs.slice(1), ...extraArgs];

  let returnValue: unknown;
  try {
    returnValue = (await imported.default(args)) as unknown;
  } catch (unknownError) {
    return {
      tag: "ElmWatchNodeRunError",
      scriptPath,
      args,
      error: unknownValueAsString(unknownError, unknownErrorToString),
      ...emptyStdio,
    };
  }

  if (typeof returnValue !== "string") {
    return {
      tag: "ElmWatchNodeBadReturnValue",
      scriptPath,
      args,
      returnValue: unknownValueAsString(returnValue, repr),
      ...emptyStdio,
    };
  }

  return { tag: "Success", code: Buffer.from(returnValue) };
}

function unknownValueAsString(
  value: unknown,
  toString: (value: unknown) => string
): UnknownValueAsString {
  return {
    tag: "UnknownValueAsString",
    value: toString(value),
  };
}

function importErrorToString(error: unknown): string {
  const code: unknown = (error as { code: unknown } | undefined)?.code;
  // `import()` is used for real (since it supports both CJS and MJS).
  // In Jest tests it seems to be impossible to use `import()` so we have to
  // support `require()` too.
  return code === "ERR_MODULE_NOT_FOUND" || // `import()`
    code === "MODULE_NOT_FOUND" // `require()`
    ? (error as { message: string }).message
    : unknownErrorToString(error);
}

if (parentPort === null) {
  throw new Error("PostprocessWorker.ts: worker_threads.parentPort is null!");
}

main(parentPort);
