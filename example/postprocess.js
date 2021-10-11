import * as esbuild from "esbuild";
import * as path from "path";
import * as UglifyJS from "uglify-js";

export default function postprocess([code, outputPath, compilationMode]) {
  switch (compilationMode) {
    case "standard":
    case "debug":
      return code;

    case "optimize":
      return minify(code, {
        minimal: path.basename(outputPath) === "ApplicationMain.js",
      });

    default:
      throw new Error(
        `Unknown compilation mode: ${JSON.stringify(compilationMode)}`
      );
  }
}

const pureFuncs = [
  "F2",
  "F3",
  "F4",
  "F5",
  "F6",
  "F7",
  "F8",
  "F9",
  "A2",
  "A3",
  "A4",
  "A5",
  "A6",
  "A7",
  "A8",
  "A9",
];

// Source: https://discourse.elm-lang.org/t/what-i-ve-learned-about-minifying-elm-code/7632
function minify(code, { minimal }) {
  return minimal ? runUglifyJSAndEsbuild(code) : runEsbuild(code);
}

function runUglifyJSAndEsbuild(code) {
  const result = UglifyJS.minify(code, {
    compress: {
      ...Object.fromEntries(
        Object.entries(UglifyJS.default_options().compress).map(
          ([key, value]) => [key, value === true ? false : value]
        )
      ),
      pure_funcs: pureFuncs,
      pure_getters: true,
      strings: true,
      sequences: true,
      merge_vars: true,
      switches: true,
      dead_code: true,
      if_return: true,
      inline: true,
      join_vars: true,
      reduce_vars: true,
      conditionals: true,
      collapse_vars: true,
      unused: true,
    },
    mangle: false,
  });

  if (result.error !== undefined) {
    throw result.error;
  }

  return esbuild.transformSync(result.code, {
    minify: true,
    target: "es5",
  }).code;
}

function runEsbuild(code) {
  return esbuild.transformSync(removeIIFE(code), {
    minify: true,
    pure: pureFuncs,
    target: "es5",
    format: "iife",
  }).code;
}

function removeIIFE(code) {
  return `var scope = window;${code.slice(
    code.indexOf("{") + 1,
    code.lastIndexOf("}")
  )}`;
}
