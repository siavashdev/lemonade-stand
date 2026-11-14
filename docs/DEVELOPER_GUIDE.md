# Logs

Lemonade Stand has two log viewers, both under the hamburger button (☰) next to
the app name in the top bar. Each has a search box, a level filter, **Follow**
(keeps the newest line in view; scrolling up pauses it), **Copy** (copies the
lines currently shown) and **Clear** (empties the view, not the log itself).

## Lemonade Server logs

The live log of the Lemonade server the app is connected to: its retained
backlog first, then each new line as it is written.

- The main process opens the server's log WebSocket
  (`ws://<host>:<port>/logs/stream`) and relays it to the window
  ([`src/main/lemonade/logs.ts`](../src/main/lemonade/logs.ts)). The renderer's
  Content-Security-Policy only allows its own origin, so it can't connect itself.
- The address is derived from the connection's base URL: the `/api/v1` suffix is
  dropped and any reverse-proxy prefix is kept. The API key, if set, is sent as
  `?api_key=`.
- The stream is open only while the viewer is open. If the server goes away it
  reconnects with a growing delay (1 s up to 10 s) and asks for the full backlog
  again each time, because the server restarts its sequence numbers when it
  restarts. Changing the server in **Connection** moves the stream to the new one.

## Lemonade Stand logs

The app's own output: everything the main process writes with `console.log`,
`console.info`, `console.warn`, `console.error` and `console.debug`, plus the
window's own console (tagged `ui`). A leading `[tag]` in a message becomes its
tag column. The newest 5000 lines are kept in memory
([`src/main/logger.ts`](../src/main/logger.ts)); nothing is written to disk
unless you turn on the log file below.

## Log file (optional)

Writing a log file as well, for attaching to a bug report, is opt-in.
You change log level by either an environment variable like LOG_LEVEL=debug or
create a settings.json file within below folder if not exists:
C:\Users\<username>\AppData\Roaming\lemonade-stand\config\

Set the log level to debug like below:
```json
{ "logLevel": "debug" }
```

The log file will be placed in below folder:
C:\Users\<username>\AppData\Roaming\lemonade-stand\logs\

When it is on, the **Lemonade Stand logs** viewer shows the file's path with a
**Show file** button, and the file starts with everything logged before it was
opened.