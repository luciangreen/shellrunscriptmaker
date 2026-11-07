# shellrun

Turns a list of Terminal and Prolog commands into a script, then runs it step by step. Output shows live, and you get a notification when it succeeds or fails. You can interrupt a run, pause it, and type input to the running program. It's part of the [LucianOS suite](https://github.com/luciangreen/lucianos).

## Install

shellrun runs inside the LucianOS platform:

```sh
cd lucianos/apps
git clone https://github.com/luciangreen/shellrunscriptmaker
```

Start the platform (`npm start` in `lucianos`) and open http://localhost:4170/apps/shellrunscriptmaker/

`node` must be in `allowedCommands` in the platform's `config.json`. It is by default.

## Using it

- **Paste commands…** turns instructions you would type yourself into steps:
  - `cd folder` sets the folder for the steps after it.
  - `swipl --stack-limit=54G` starts a Prolog session. Each query ending in a full stop becomes part of a Prolog step, and `halt.` ends the session.
  - A comment line such as `% STOP HERE` becomes a **pause**. After the pause, the Prolog session starts again with the same files loaded.
  - Any other line becomes a Terminal step. `#` lines are comments.
- **+ Terminal / + Prolog / + Pause** add steps by hand. ↑ ↓ reorder them and ✕ deletes one.
- **Save** writes `<name>.shellrun.json` into the scripts folder (`LucianOS/shellrun` by default).
- **Run** runs the steps in order. At a pause, press **Continue** or **Stop**. **Interrupt** stops the current step. If you reopen the page during a run, it picks the run up again.
- On the LucianOS desktop, double-clicking a `.shellrun.json` icon opens it here and runs it. `/apps/shellrunscriptmaker/?open=path&run=1` does the same.
- **Export .sh** writes a bash version next to the script, which you can run in Terminal with `bash name.sh`.

Each Prolog step runs as one `swipl --stack-limit=… -g "…" -t halt` command, so nothing has to be typed at a `?-` prompt. Each query runs on its own, as at the prompt. If a query fails, you see a warning and the rest still run.

Tick **Interactive** on a Prolog step to type answers to the program, for example with `[auto,off]`.

## Safety

The runner follows the platform's rules:

- Only commands in `allowedCommands` can run, and never through a shell.
- Every folder must be inside the suite folder.
- Pipes and redirects are not supported. Use **Save output to** on a Prolog step to write its output to a file.

## Example

`examples/breasoning.shellrun.json` is the weekly breasoning run (25 million) from the private instructions, made with **Paste commands…**. It starts with a thesis check, because breasoning doesn't run for theses yet. Copy it into your scripts folder to use it.

## Script format

```json
{
  "name": "Breasoning",
  "stopOnFail": true,
  "tempDir": false,
  "steps": [
    { "type": "prolog", "cwd": "Dropbox/GitHub-private2/Text-to-Breasonings",
      "goals": ["['text_to_breasonings.pl']", "texttobr(u,\"file.txt\",u,u)"], "stackLimit": "54G" },
    { "type": "pause", "message": "Check the output, then continue" },
    { "type": "cmd", "cwd": "Dropbox/GitHub-private2/Algorithm-Writer-with-Lists", "cmd": "mv", "args": ["gl2a.txt", "../Text-to-Breasonings/file.txt"] }
  ]
}
```

With `"tempDir": true`, the run gets a temporary folder, available as `$LUCIANOS_TMP`, which is deleted when the run ends.

## Tests

```sh
npm test
```

The 13 tests cover the paste parser on the real breasoning instructions, the Prolog command line, validation and bash export. They also run the runner itself: steps in order, pauses, Stop, stop-on-failure, the allowlist and the folder rules.
