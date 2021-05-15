# elm-watch

> `elm make` in watch mode.

`elm-watch make` is basically like `elm make`.

`elm-watch hot` recompiles whenever your Elm files change and reloads the compiled JS in the browser.

## Installation

```
npm install --save-dev elm-watch
```

## Getting started

Create a file called `elm-tooling.json`:

```json
{
  "x-elm-watch": {
    "outputs": {
      "build/main.js": {
        "inputs": ["src/Main.elm"]
      }
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
