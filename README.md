# elm-watch

> `elm make` in watch mode. Fast and reliable.

`elm-watch make` is basically like `elm make`.

`elm-watch hot` recompiles whenever your Elm files change and reloads the compiled JS in the browser.

## Installation

```
npm install --save-dev elm-watch
```

## Getting started

Create a file called `elm-watch.json`:

```json
{
  "targets": {
    "Main": {
      "inputs": ["src/Main.elm"],
      "output": "build/main.js"
    }
  }
}
```

Then run:

```
npx elm-watch hot
```

To build for production:

```
npx elm-watch make --optimize
```
