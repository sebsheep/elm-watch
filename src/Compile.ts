import * as ElmMakeError from "./ElmMakeError";
import { join } from "./helpers";
import { Logger } from "./Logger";
import { isNonEmptyArray } from "./NonEmptyArray";
import * as SpawnElm from "./SpawnElm";
import { State } from "./State";
import { OutputPath, outputPathToString } from "./types";

export async function run(logger: Logger, state: State): Promise<number> {
  await Promise.all(
    Array.from(state.elmJsons).flatMap(([elmJsonPath, outputs]) =>
      Array.from(outputs, ([outputPath, outputState]) =>
        SpawnElm.make({
          elmJsonPath,
          mode: outputState.mode,
          inputs: outputState.inputs,
          output: outputPath,
        }).then((result) => {
          outputState.status = result;
        })
      )
    )
  );

  const summary = summarize(state);

  logger.log(
    join(
      [
        ...summary.messages,
        ...summary.compileErrors,
        ...printOutputPaths("Succeeded:", summary.succeeded),
        ...printOutputPaths("Failed:", summary.failed),
      ],
      "\n\n\n"
    )
  );

  return isNonEmptyArray(summary.failed) ? 1 : 0;
}

type Summary = {
  succeeded: Array<OutputPath>;
  failed: Array<OutputPath>;
  messages: Array<string>;
  compileErrors: Set<string>;
};

function summarize(state: State): Summary {
  const summary: Summary = {
    succeeded: [],
    failed: [],
    messages: [],
    compileErrors: new Set(),
  };

  for (const elmJsonError of state.elmJsonsErrors) {
    summary.failed.push(elmJsonError.outputPath);
    summary.messages.push("TODO");
  }

  for (const [_elmJsonPath, outputs] of state.elmJsons) {
    for (const [outputPath, outputState] of outputs) {
      switch (outputState.status.tag) {
        case "NotWrittenToDisk":
          break;

        case "Success":
          summary.succeeded.push(outputPath);
          break;

        case "ElmNotFoundError":
          summary.failed.push(outputPath);
          summary.messages.push("TODO");
          break;

        case "OtherSpawnError":
          summary.failed.push(outputPath);
          summary.messages.push("TODO");
          break;

        case "UnexpectedOutput":
          summary.failed.push(outputPath);
          summary.messages.push("TODO");
          break;

        case "JsonParseError":
          summary.failed.push(outputPath);
          summary.messages.push("TODO");
          break;

        case "DecodeError":
          summary.failed.push(outputPath);
          summary.messages.push("TODO");
          break;

        case "ElmMakeError":
          summary.failed.push(outputPath);

          switch (outputState.status.error.tag) {
            case "GeneralError":
              summary.messages.push("TODO");
              break;

            case "CompileErrors":
              for (const error of outputState.status.error.errors) {
                for (const problem of error.problems) {
                  summary.compileErrors.add(
                    ElmMakeError.renderProblem(error.path, problem)
                  );
                }
              }
              break;
          }
          break;
      }
    }
  }

  return summary;
}

function printOutputPaths(
  label: string,
  paths: Array<OutputPath>
): Array<string> {
  return isNonEmptyArray(paths)
    ? [label, ...paths.map(outputPathToString)]
    : [];
}