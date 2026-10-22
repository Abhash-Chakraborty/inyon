---
title: Companion apps
description: Pair an app like Legato with your hub so it can show your sessions, answer an agent's question and send it text, and nothing more.
nav: Companion apps
---

From 0.20 a companion app can pair with your hub. Legato, a speech-to-text app for Windows, is the first: it shows your sessions, answers an agent's question and sends a dictated instruction to a session. A companion gets four permissions and the hub refuses everything else, so it can't open a terminal, read files or change settings.

The first half of this page is for pairing one. The second half is the contract, version 1, with the exact requests and answers, for anyone writing a companion.

## Pair a companion app

1. In Inyon, open **Settings › Paired devices** and press **Pair a companion app**. If you signed in more than 10 minutes ago, Inyon asks for the password again first.
2. Type the six-character code and the hub's address into the companion app. In Legato that's **Settings › Connections › Inyon**.
3. The sheet says when the app is paired and lists what it may do.

The code works once, for 5 minutes, and the sheet makes a new one when it runs out. **New code** ends the old one straight away.

On the hub's computer you can make a code without a browser:

```sh
inyon hub companion-code
# Companion code: K7M-2QX
# Type it into the companion app (Legato: Settings > Connections > Inyon) with this hub's address, http://100.97.188.112:4777. It works once, for 5 minutes.
```

A hub that listens only on `127.0.0.1`, behind a proxy or `tailscale serve`, doesn't know its outside address, so the command then says to use the address you open the hub at. With `--json` it prints `code`, `expiresAt`, `url` and `message`.

## What a companion can do

| Permission | What it gives the app |
|---|---|
| Overview | every session with its state and machine, live changes, and alerts |
| Chats | the screen and the details of a session it watches |
| Answer | an answer to an agent's question, once, for the question it saw |
| Send | plain text typed into a session; the hub says whether it arrived |

Interrupting, keys, the terminal, uploads, files, model and mode switches, past conversations and every setting are refused, on every route and every WebSocket message. The check is on the hub, so a companion that misbehaves gets the same refusal as one that doesn't. Text that starts with `/` or `!` is refused too, so a companion can't run an agent's commands or a shell command through **Send**.

**Settings › Paired devices** lists each companion with its name, app, permissions, contract version, when it paired and when it was last seen. **What it can do** in its menu spells out the permissions. **Remove** ends it at once: its token stops working and its open connection closes. To use it again, pair it with a new code.

## The contract, version 1

Everything below is version 1. Changes within a version only add things: a new field, a new frame, a new `reason`. Ignore what you don't know.

### Every request

Every request after pairing carries the token and the contract version:

```http
Authorization: Bearer <token>
X-Inyon-Contract: 1
```

The claim carries `X-Inyon-Contract` too. It needs no token, and one sent along with it is ignored, so an app can pair again before it drops the old token. Without the header, or with a version the hub doesn't speak, the answer is `426`:

```json
{ "error": "Send the X-Inyon-Contract header. This hub supports companion contract 1.", "reason": "contract", "supported": [1] }
```

```json
{ "error": "This hub doesn't support companion contract 2. It supports 1.", "reason": "contract", "supported": [1] }
```

A token the hub doesn't know, or one that was removed, gets `401 {"error":"Not signed in"}`. Pair again.

Errors are JSON with an `error` written for people, which you can show as it is, and a `reason` to act on:

| `reason` | Means |
|---|---|
| `contract` | the `X-Inyon-Contract` header is missing or names a version the hub doesn't speak |
| `scope` | companions can't do this |
| `bad-code` | the pairing code is wrong, used or expired |
| `rate-limit` | too many wrong codes; wait a minute |
| `bad-request` | the request body is missing something; `error` says what |
| `bad-option` | the question has no option with that number |
| `already-answered` | the question was answered or is no longer on screen |
| `pane-gone` | the session isn't there any more |
| `offline` | the session's machine isn't reachable right now |
| `no-agent` | no agent runs in that session |
| `prompt-open` | the agent is asking a question; answer it first |
| `busy` | the agent's input box isn't there to type into right now |
| `not-landed` | the hub typed the text but couldn't confirm it arrived |

### Claim the code

```http
POST /api/companions/claim
X-Inyon-Contract: 1
Content-Type: application/json

{ "code": "k7m-2qx", "name": "Legato on abhash-laptop", "app": "Legato for Windows" }
```

The code may come in any case, with or without a space or dash. `name` is what Inyon lists, up to 60 characters; `app` is optional.

```json
{ "token": "Jb2y…43 characters", "hubId": "3f9c1a7e2b6d4c80", "scopes": ["overview", "chat", "answer", "send"], "contractVersion": 1 }
```

Keep the token somewhere safe; the hub keeps only its hash. A wrong, used or expired code gets `401`:

```json
{ "error": "That code is not right or has expired. Make a new one in Inyon.", "reason": "bad-code" }
```

Eight wrong codes in a minute from one address, or thirty from all of them, get `429` with `"reason": "rate-limit"` until the minute is up.

`GET /api/companions/me` says who you are, for checking a saved token:

```json
{ "id": "a1b2c3d4e5f6", "name": "Legato on abhash-laptop", "app": "Legato for Windows", "scopes": ["overview", "chat", "answer", "send"], "contractVersion": 1, "hub": { "id": "3f9c1a7e2b6d4c80", "name": "abhash-arm", "version": "0.20.0" } }
```

### The overview

`GET /api/overview` returns the data the app's overview is drawn from, `{ "hosts": HostState[] }`, with the `HostState` type in [packages/protocol](https://github.com/Abhash-Chakraborty/inyon/blob/main/packages/protocol/src/index.ts). Each machine has a `config` with only its `id`, `name` and `kind` (a companion never sees how the hub reaches a machine), a `status` (`online`, `connecting` or `error`) and its tmux `sessions`, each with `windows` and their `panes`. A pane running an agent has an `agent` with:

| Field | Holds |
|---|---|
| `kind` | `claude`, `codex`, `opencode`, `copilot`, `gemini` or `antigravity` |
| `state` | `idle`, `working`, `waiting` or `unknown` |
| `waitingFor` | a short line about the question, while `state` is `waiting` |
| `options` | the answers on offer, `[{ "n": 1, "label": "Yes" }, …]`, for a single-choice question |
| `activity` | the working line, such as `Undulating… (2s · thinking with high effort)` |

A pane is named by its machine's `config.id` and its tmux pane id, such as `box` and `%3`.

### The WebSocket

Open `/ws` with the same two headers. A client that can't set `X-Inyon-Contract` on the upgrade can add `?contract=1` to the URL instead; the token still goes in the `Authorization` header. A missing or unsupported version is refused with `426` and the same JSON as above.

A companion may send:

| Frame | Does |
|---|---|
| `{"t":"ping"}` | the hub answers `{"t":"pong"}` |
| `{"t":"sub.overview"}` | an `overview` frame now and after every change |
| `{"t":"sub.chat","host":"box","pane":"%3"}` | `chat.info` and `chat.screen` for that pane now and on every change |
| `{"t":"unsub.chat","host":"box","pane":"%3"}` | stops them |

Anything else closes the socket with code `4403` and a reason naming the frame, such as `Not for companion apps: term.open`. When you're removed in Inyon, the socket closes with `4001` and `Companion removed`.

It receives `overview`, `chat.info`, `chat.screen`, `notify` and `pong`, and never the chat history, live text, drafts or terminal data. `chat.info` is `{ "t": "chat.info", "key": "box:%3", "info": ChatInfo }` with the conversation's agent, model, mode, recent sends and `title`. The title is the name you gave the conversation, else the agent's own title for it, else the terminal's title, which Claude Code sets to the task and tmux otherwise sets to the machine's name. The tmux session's name is `name` in the overview's `sessions`. Alerts look like this, with `kind` one of `waiting`, `done`, `offline` and `online`:

```json
{ "t": "notify", "host": "box", "pane": "%3", "kind": "waiting", "title": "Claude needs you", "body": "Bash: rm -rf build", "agent": "claude" }
```

### A question and its key

While an agent asks something, `chat.screen` carries the question as `screen.prompt`, and for companions the hub adds the question's `key`:

```json
{
  "t": "chat.screen",
  "key": "box:%3",
  "screen": {
    "working": false,
    "inputVisible": true,
    "mode": "manual",
    "width": 100,
    "prompt": {
      "body": ["Bash command", "rm -rf build", "Do you want to proceed?"],
      "options": [
        { "n": 1, "label": "Yes", "selected": true },
        { "n": 2, "label": "Yes, and don't ask again for rm commands in this project", "selected": false },
        { "n": 3, "label": "No", "selected": false }
      ],
      "multi": false,
      "footer": "Esc to cancel · Tab to amend",
      "key": "Bashcommandrm-rfbuildDoyouwanttoproceed?1.Yes2.Yes,anddon'taskagainforrmcommandsinthisproject3.No"
    }
  }
}
```

Treat the key as an opaque string and send it back as it came. Answer with the option's `n` and the key, so a late tap never lands on the next question. In the path a pane id goes without its `%`, so `%3` is `3`:

```http
POST /api/hosts/box/panes/3/answer

{ "option": 1, "key": "Bashcommandrm-rfbuildDoyouwanttoproceed?1.Yes2.Yes,anddon'taskagainforrmcommandsinthisproject3.No" }
```

| Status | Body | When |
|---|---|---|
| 200 | `{"ok":true}` | the agent took the answer |
| 409 | `"reason": "already-answered"` | that question was answered (in the app, on a phone, in the terminal) or is gone |
| 409 | `"reason": "pane-gone"` or `"offline"` | the session or its machine isn't there |
| 400 | `"reason": "bad-option"` | the question has no option with that number |
| 400 | `"reason": "bad-request"` | no `key`, or an `option` that isn't a number |

`text` is optional, for an option that takes typed text.

### Send text

```http
POST /api/hosts/box/panes/3/send

{ "text": "Run the tests again", "requestId": "legato-7f3a" }
```

`requestId` is optional, letters, digits, `-` and `_`, up to 128 characters: a retry with the same one is never typed twice, and gets the first one's answer. The hub answers once it knows whether the text landed:

| Status | Body | When |
|---|---|---|
| 200 | `{"ok":true,"state":"delivered"}` | the agent recorded it |
| 200 | `{"ok":true,"state":"queued"}` | the agent is busy and queued it for after this turn |
| 200 | `{"ok":true,"state":"sent"}` | typed and submitted; the agent hasn't written it down where Inyon can read it yet |
| 409 | `"reason": "prompt-open"` | the agent is asking a question; answer it first |
| 409 | `"reason": "busy"` | the agent's input box isn't there to type into right now |
| 409 | `"reason": "not-landed"` | the hub typed it but couldn't confirm it arrived; check before sending again |
| 409 | `"reason": "no-agent"` | no agent runs in that pane |
| 409 | `"reason": "pane-gone"` or `"offline"` | the session or its machine isn't there |
| 403 | `"reason": "scope"` | the text starts with `/` or `!`: commands aren't for companions |
| 400 | `"reason": "bad-request"` | empty text, or a `requestId` with other characters |

A send shows in the session's list of sends in Inyon, whether it landed or not.

### What's refused

Every other route answers `403`:

```json
{ "error": "Companion apps can't use this", "reason": "scope" }
```

A companion token never opens `/node`, the `/v/` pages, or the `/api/local` routes of the `inyon` command on the hub's computer.
