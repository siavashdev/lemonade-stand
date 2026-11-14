# Lemonade Stand , User Guide

Lemonade Stand is a desktop agent that runs a local model (served by `lemond`)
and lets it call **tools** provided by **MCP servers**. You stock those tools
from the **Pantry** (the Market), then just talk to the agent in plain English and
it decides when to reach for a tool. Before any tool runs, you'll see an
**approval card** (Allow once / Always allow / Deny) unless you've turned
approvals off. To skip the cards entirely, open the **Permissions** menu in the
footer and choose **Allow all** (⚠): every tool and sub-tool then runs without
asking. **Manual permissions** is the default; the choice is remembered between
conversations and restarts.

This guide lists every tool that ships in the Pantry, how to enable it, and
copy‑paste example prompts you can use to test each one.

> **Tip:** After enabling a server in the Pantry (or editing
> `config/servers.json`), restart the app so the agent picks up the new tools.
> Then ask *"What tools do you have?"* to confirm they loaded.

---

## How to enable a tool

1. Open the **Pantry** in the app.
2. Pick a server from the Market and click to stock it.
3. If it asks for a **path** (a folder or a file), choose one.
4. Restart if prompted.

Under the hood this adds an entry to `config/servers.json`. You can also
hand‑edit that file. **Only enable servers you trust**, their tools run with
this app's privileges.

---

### 1. Lemonade Gateway 🍋 (`lemonade`)

Your local `lemond`'s own tools, exposed as agent tools: chat, "omni"
multimodal, image generation, audio transcription, and model listing. No install
needed , just point the entry's `url` at your server's `/mcp` endpoint and enable
it.

**Tools:** `lemonade_list_models`, `lemonade_chat`, `lemonade_omni`,
`lemonade_generate_image`, `lemonade_transcribe_audio`

**Try these prompts:**

- "Use the Lemonade tools to **list the models** my server has available."
- "Ask `lemonade_chat` to write a two‑line poem about lemonade, then show me the reply."
- "**Generate an image** of a sunny lemonade stand on a beach and save it."
- "**Transcribe** the audio file `C:\temp\lemonade-stand\note.wav` for me."
- "Use `lemonade_omni` to describe what's in `C:\temp\lemonade-stand\photo.png`."

> Note: the `/mcp` gateway is HTTP‑only and non‑streaming. TTS (spoken replies)
> and embeddings are **not** gateway tools, the app calls those REST endpoints
> directly.

---

### 2. Filesystem 📁 (`filesystem`)

Read and write files under a single root folder you choose. Great for letting the
agent work with local documents and code.

**Tools:** `read_file`, `read_multiple_files`, `write_file`, `edit_file`,
`create_directory`, `list_directory`, `directory_tree`, `move_file`,
`search_files`, `get_file_info`, `list_allowed_directories`

**Try these prompts:**

- "**List the files** in my allowed folder."
- "Create a file called `hello.txt` that says *Fresh lemonade, 50 cents*."
- "**Read** `hello.txt` back to me."
- "Make a folder called `notes` and put a `todo.md` inside it with three bullet points."
- "**Search** my folder for any file containing the word *recipe*."
- "Show me a **directory tree** of my allowed folder."
- "Append a line to `hello.txt` that says *Now with extra pulp!*"

---

### 3. Web Fetch 🌐 (`fetch`)

Fetches a URL and converts the page to clean markdown so the model can read it.
Requires `uvx` (from the [uv](https://github.com/astral-sh/uv) toolchain) on your
PATH.

**Tools:** `fetch`

**Try these prompts:**

- "**Fetch** https://example.com and summarize the page in two sentences."
- "Grab the content of https://modelcontextprotocol.io and tell me what MCP is."
- "Read https://news.ycombinator.com and list the top 3 headlines."
- "Fetch the Lemonade project page at https://github.com/lemonade-sdk/lemonade and tell me what it does."

---

### 4. Git 🔀 (`git`)

Inspect and operate on a local Git repository , status, diffs, log, and commits.
Requires `uvx`. When enabling, pick the **repository folder**.

**Tools:** `git_status`, `git_diff_unstaged`, `git_diff_staged`, `git_diff`,
`git_log`, `git_show`, `git_add`, `git_commit`, `git_reset`, `git_create_branch`,
`git_checkout`, and more.

**Try these prompts:**

- "What's the **git status** of my repo?"
- "Show me the **last 5 commits** with their messages."
- "**Diff** my unstaged changes and summarize what changed."
- "What files are currently modified but not staged?"
- "Show me the details of the most recent commit."

> The commit/reset/checkout tools change your repo. The approval card lets you
> review each action before it runs , deny anything you're unsure about.

---

### 5. Memory 🧠 (`memory`)

A persistent knowledge‑graph memory the agent can write to and recall across
turns (and across restarts). Good for remembering facts about you or a project.
Requires `npx`.

**Tools:** `create_entities`, `create_relations`, `add_observations`,
`delete_entities`, `read_graph`, `search_nodes`, `open_nodes`

**Try these prompts:**

- "**Remember** that my favorite lemonade recipe uses 4 lemons, 1 cup sugar, and a pinch of salt."
- "Remember that my lemonade stand is named *The Sour Spot* and opens on Saturdays."
- "What do you **remember** about my lemonade recipe?"
- "Search your memory for anything about *The Sour Spot*."
- "Show me everything in your memory graph."

*(Restart the app, then ask again to confirm the memory persisted.)*

---

### 6. Time ⏰ (`time`)

Current time plus timezone conversions. Requires `uvx`.

**Tools:** `get_current_time`, `convert_time`

**Try these prompts:**

- "What **time** is it right now in New York?"
- "What's the current time in Tokyo?"
- "If it's **3 PM in London**, what time is it in Los Angeles?"
- "Convert 9:00 AM Sydney time to UTC."

---

### 7. SQLite 🗃️ (`sqlite`)

Query and modify a local SQLite database file. When enabling, pick the **`.db`
file**. Requires `uvx`.

**Tools:** `read_query`, `write_query`, `create_table`, `list_tables`,
`describe_table`, `append_insight`

**Try these prompts:**

- "**Create a table** called `sales` with columns id, item, and price."
- "Insert a few rows into `sales`: lemonade $2, cookie $1, iced tea $3."
- "**List the tables** in my database."
- "Describe the `sales` table's columns."
- "**Query** the total revenue from the `sales` table."
- "Show me the three most expensive items in `sales`."

---

### 8. Word Documents 📄 (`word`)

Turns Markdown the agent writes into a Word (`.docx`) document: headings, lists,
tables, links, and code blocks. It only **creates** documents; it can't edit an
existing one or add comments or tracked changes. No Word install, and no Node or
`uvx` on your PATH, is needed.

**Tools:** `convert_markdown_to_word`

The tool saves to whatever absolute `.docx` path the agent picks, and it won't
replace an existing file unless you ask it to. Tell the agent where to save, for
example a folder the **Filesystem** server can access.

**Try these prompts:**

- "Write a one-page lemonade stand menu and **save it as a Word document** at `C:\temp\lemonade-stand\menu.docx`."
- "Make a Word document with a table of this week's sales: Mon $20, Tue $35, Wed $28. Save it as `sales.docx` in my allowed folder."
- "**Overwrite** `menu.docx` with a new version that adds an iced tea section."

---

### 9. Playwright Browser 🎭 (`playwright`)

Lets the agent drive a real browser: open pages, click, type, read a page
snapshot, and take screenshots. The server is bundled, so no Node or `uvx` on
your PATH is needed, but it drives a browser that must already be on your
machine. The app doesn't ship one.

**Settings** (on the Pantry card; change them any time and click **Apply settings**):

- **Browser**: *Google Chrome*, *Microsoft Edge* (the default on Windows, where
  it's built in), or *Playwright Chromium*. Chrome and Edge use the copy you
  already have. Playwright Chromium needs a one-time download: run
  `npx @playwright/mcp install-browser chrome-for-testing` in a terminal.
- **Private session**: on by default. The browser keeps its profile in memory only,
  like an incognito window, so cookies and sign-ins are gone when the tool
  restarts, and it never touches your own browser's profile. Untick it only if
  you want logins to persist between sessions.
- **Run headless**: off by default, so a visible window opens and you can watch
  the agent work. Tick it to hide the window.

If the chosen browser isn't found, the tool returns an error that says what to
install, and the agent will relay it.

**Tools:** `browser_navigate`, `browser_snapshot`, `browser_click`,
`browser_type`, `browser_take_screenshot`, `browser_tabs`, `browser_close`, and more.

**Try these prompts:**

- "**Open** https://example.com in the browser and tell me what the page says."
- "Go to https://news.ycombinator.com and list the top 3 headlines."
- "Take a **screenshot** of https://modelcontextprotocol.io."
- "Search for *lemonade recipe* on https://duckduckgo.com and summarize the first result."

> The browser acts with this app's privileges and can reach any site you can.
> Review each approval card. The private session limits what carries over
> between sessions, but anything you sign in to during one is still reachable by
> the agent until the tool restarts.

---

## Pitchers
(scheduled tasks) run prompts fresh on a timer or when the app opens
  - **On-open trigger**: runs once each app launch
  - **Daily trigger**: runs at a local HH:MM each day (with automatic catch-up on launch if the time was missed while the app was closed)
  - **Weekly trigger**: runs at a local HH:MM on the weekdays you pick (e.g. Mondays, or Mon-Fri), with the same catch-up on launch
  - **Monthly trigger**: runs at a local HH:MM on a chosen day of the month (a day past the end of a short month runs on its last day), with the same catch-up on launch
  - **Interval trigger**: repeats every 15 minutes to 24 hours while the app is open (no catch-up for runs missed while it was closed)
  - **Per-task tool whitelist**: only explicitly-allowed MCP tools can auto-run during a pour; everything else is denied so scheduled tasks can't be steered into unintended actions
  - **Bounded retry**: if a local model flakily fails to call its tools, a pour retries once
  - **Dual output**: serve poured results to the **Napkin** panel (rich artifacts) or save as a **conversation** in history
  - **Desktop notifications** when results are ready and the window isn't focused
  - **Managed from a new Pitchers panel**: create, edit, enable/disable, manually "Pour now", and see last-run status + errors
  - **Create from chat**: just ask the agent to schedule, automate, or repeat a task (e.g. "every morning at 8, fetch example.com and summarize the headlines"). It drafts a Pitcher, pre-selects the tools it needs, and opens a pre-filled editor for you to review the trigger and tools and save. Nothing is scheduled until you confirm, and you can add or remove any pre-selected tool first
  - **Graceful serialization**: pours never collide with interactive chat turns; they queue and run when the user isn't typing

## Quick test checklist

| Tool | One‑line test prompt | Needs a path? |
|------|----------------------|---------------|
| Lemonade Gateway | "List the models my server has." | No (needs `/mcp` URL) |
| Filesystem | "List the files in my allowed folder." | Folder |
| Web Fetch | "Fetch example.com and summarize it." | No |
| Git | "What's the git status of my repo?" | Repo folder |
| Memory | "Remember my recipe uses 4 lemons." | No |
| Time | "What time is it in Tokyo?" | No |
| SQLite | "List the tables in my database." | `.db` file |
| Word Documents | "Save a short menu as `menu.docx` in my allowed folder." | No (tell it where to save) |
| Playwright Browser | "Open example.com and tell me what it says." | No (needs Chrome, Edge, or Playwright Chromium) |

---

## Troubleshooting

- **"I don't have that tool."** The server isn't enabled, or the app wasn't
  restarted after enabling it. Check `config/servers.json` and restart.
- **A tool never runs.** You may have denied its approval card, or a
  session‑scoped *Always allow* was cleared on restart. Try again and choose
  *Allow once*.
- **`npx` / `uvx` errors.** Node's `npx` ships with Node.js; `uvx` comes from
  [uv](https://github.com/astral-sh/uv). Make sure the relevant one is installed
  and on your PATH, then restart the app.
- **Nothing happens / server won't start.** The first run of an `npx`/`uvx`
  server downloads it, which can take a moment. Check the app's logs for errors
  (see *Viewing logs* below).
- **An Omni model says it isn't downloaded (or is missing components).** An
  Omni model is a bundle of several models, and every one of them has to be on
  the Lemonade server before it can chat. Open **Models** and download it; the
  status bar shows the progress, and you can try again when it finishes.
- **"This request needs about N tokens but the model is running with only a
  4,096-token context."** The server loaded the model with a small context
  window. Raise it from the context button in the status bar, or start a new
  session.
- **Confirm what's loaded.** Ask the agent *"What tools do you have?"* at any
  time.

### Viewing logs

Click the hamburger button (☰) next to **Lemonade Stand** in the top bar:

- **Lemonade Server logs** is the Lemonade server's own live log: model loads,
  downloads, and any error it hit while answering.
- **Lemonade Stand logs** is what this app has been doing: tool connections,
  agent errors, and the window's console.

In either one you can search, filter by level, pause scrolling with **Follow**,
and **Copy** the lines shown to paste into a bug report.

### Watching resource usage and inference speed

The **Monitoring pill** at the left of the status bar always shows the model's
state at a glance: a dot that pulses green while it's working (grey when idle),
the live speed in tokens per second with a small graph, and CPU. Click it, or
pick **Monitoring** in the hamburger menu (☰), to see what the Lemonade server is
doing right now, without relying on fan noise or the log stream:

- **Inference** shows whether the model is generating (and how many requests),
  the live generation speed in tokens per second, the last request's speed and
  time to first token, and totals. A graph of the live speed covers the last
  three minutes.
- **System** graphs CPU, memory, GPU, GPU memory and NPU usage. A card says
  *n/a* when the server or your hardware doesn't report that number.
- **Recent requests** lists each request that finishes, with its speed, time to
  first token and token counts.

The server's own timings are used whenever it logs them, so for most Omni
requests the speed and token counts are exact. Figures marked **~** are the
fallback: estimates made by Lemonade Stand from the text the model streams back
(roughly four characters per token, ignoring the audio and images Omni sends
inline), with the speed worked out over the whole request, including any time
spent running tools. Treat those as a guide, not a benchmark. Note that **Last
prompt** counts the prompt tokens the model actually had to process, so it can
be small when most of the prompt was already cached.

**Keep the chat in view:** the Monitoring window covers the app, so move it into
its own window. Either click the pop-out button (the arrow in its top-right
corner), or drag its title bar toward the edge of the app: once it hangs well
over the edge, a banner says "Release to open Monitoring in its own window", and
letting go opens it as a separate window where you dropped it. (A window can't
draw outside itself, so the drag works by passing the edge rather than leaving
the screen.) Place that window beside, or outside, the main one
and you can chat and watch the graphs at the same time. It follows the app's
light/dark theme, keeps the graphs you already had, and closes with the app.
Clicking **Monitoring** again brings it forward.

While a request is running, the generation-speed graph is shaded, so you can see
work in progress even when no speed is available yet. An Omni model sends its
whole reply at once, so there is no speed to show while it works: the **Live
speed** reading appears for a few seconds when each model call finishes, and the
call's speed stays under **Last request**.

It updates once a second while the app window is visible. Server figures need a Lemonade server
that provides the `/stats` and `/system-stats` endpoints; on an older one, those
cards show *n/a* (the app's own estimates still work).

