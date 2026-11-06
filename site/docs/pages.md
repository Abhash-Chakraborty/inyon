---
title: Blueprints
description: Open the plans and mockups your agents build in the app, grouped by the tmux session that made them, each one sandboxed away from your sign-in.
---

From 0.20 a site an agent makes, such as a [Blueprint](skills.md#blueprint) plan with its mockups and progress board, opens inside Inyon under **Blueprints**. You don't run a server or copy a link around: the agent adds the folder once, and the page is in the app on every device you use.

From 0.25 this part of the app is called **Blueprints** (it was **Pages**), and the command is `inyon blueprints`. `inyon pages` still works as another name for it, and so do the app's old `/pages/…` addresses.

## How a page gets there

An agent with the Blueprint skill does this on its own when it finishes a site. It runs one command, and you can run the same command for any folder with an `index.html` in it:

```sh
inyon blueprints add ./private/plans/my-plan --name "My plan"
```

It answers with where the page sits in the app, under the tmux session you ran it in (or the project's folder outside tmux):

```
"My plan" is in Inyon: Blueprints > custom-tmux on abhash-arm
Open it in the app at /blueprints/local/my-plan
```

`inyon blueprints` lists the pages on a computer and `inyon blueprints rm <slug>` takes one off the list. Adding the same folder again is safe and keeps its place. The folder stays where it is, and the app shows its files as they are now, so a page an agent keeps editing is always current. [The inyon command](cli.md#blueprints) has every option.

In the app, **Add a folder** does the same: pick the machine, type the folder's full path (starting with `/`, or a drive letter on Windows) and a name.

### Blueprints the hub finds

From 0.22.4 a site an agent made but never added shows up by itself. Every 5 minutes, while the app is open somewhere or a browser takes page notifications, the hub has each machine's `inyon` look in the folders its agent sessions run in, up to 4 folders down, and in their project's `private/plans`. A folder with Blueprint's `.inyon-page.json` next to its `index.html` that isn't listed yet is added, as made by that session's agent. It skips folders starting with a dot, `node_modules`, `target`, `dist`, `build`, `vendor` and `__pycache__`, and doesn't look through `/` or your home folder itself. From 0.22.5 it also skips test folders (`test`, `tests`, `fixtures`, `__fixtures__` and `testdata`), so a sample site that a project's tests use isn't listed as a page. From 0.25 the hub also keeps the tmux session that agent runs in, and follows it by the conversation: rename the tmux session and the page goes with it. A page whose agent has stopped, or one added by hand from a tmux pane, follows a rename the hub sees happen while the machine is connected.

A page you remove stays removed: `pages.json` remembers its folder, and the hub doesn't add it again. Adding that folder yourself brings it back. A machine with an `inyon` from before 0.22.4 isn't looked through.

### In a session

From 0.22.3 a page also shows where you work with the agent that made it. When a reply has the page's `/blueprints/…` link in it (`/pages/…` before 0.25), the page shows as a card under the reply; tap it to open the page. A session's side panel (the **Activity** sheet on a phone) gets a **Pages** tab (**Blueprints** from 0.25) when the session has pages. Before 0.25 those were the ones in its project, and those in folders under the one it runs in, on the same machine. From 0.22.5 it also lists the pages that session added, wherever their folders are.

From 0.25 a session's blueprints are the ones made in its tmux session, the way Claude's artifacts belong to a chat. The ones this conversation made come first, then those that earlier conversations in the same tmux session made. A page whose tmux session isn't known (one added outside tmux, or before 0.25 by a conversation that has ended) shows by its folder, as before. A page made in another tmux session stays out, even in the same folder. The list follows live, so a page the agent adds or moves on shows up as it happens.

- **On a desktop**, the side panel's **Blueprints** tab opens a page right there, beside the chat, with its name, tmux session and machine above it, its parts and notes, **Reload**, **Share…** (from 0.25.5), **Open full view** (from 0.25.3) and **Open in new tab**. The arrow back, **This session's blueprints**, returns to the list.
- **On a phone**, the **Activity** sheet's **Blueprints** tab lists them. From 0.25.3 a page opens in the sheet, over the session, with the same controls; before, it opened full screen.
- **Open full view** takes the page to the Blueprints screen, whose **Back** on a phone returns to the session. A page opened from the Blueprints list always opens there.
- **In the [new app at `/next`](hub.md#the-new-app-at-next)**, the session's header has a **Blueprints** button with how many there are, and a dot when one changed since you opened it. It opens them beside the chat on a desktop, or the page itself when there's only one, and in a sheet on a phone. From 0.25.4 a page opens inside that sheet too, and both places have **Reload**, **Open full view** and **Open in new tab**. From 0.25.6, on a screen 1180 px wide or more, the button opens the **Blueprints** tab of the session's [side panel](hub.md#the-new-app-at-next) instead, and pressing it again hides the panel.

## Blueprints on your other computers

From 0.22 the hub also shows the pages on the computers joined to it, such as a Windows laptop, and on servers it reaches over SSH that have `inyon` installed. Run `inyon blueprints add` on that computer, or use **Add a folder** and pick it, and the page shows under that computer's name. Both the hub and the computer need 0.22 or later; an older computer's pages don't show until you update it.

The computer's own `inyon` reads the files and sends them to the hub, which checks every request by the same rules as for its own pages: no names starting with a dot, nothing a symlink leads to outside the folder. A page whose computer is offline doesn't open until it's back. From 0.22.3, while you have Blueprints open, the computer tells the hub when a page changes (it looks every 2 seconds, and from 0.23.1 slows to every 10 seconds while nothing changes), the hub keeps the files it already fetched until something in that folder changes, and a single file can be up to 64 MB. A computer with an older `inyon` is asked for its list at most every 15 seconds, and sends files of up to 8 MB.

## On a phone

**Blueprints** is the second tab, between **Overview** and **+**. Its badge counts pages that changed since you last opened them. The list is grouped by machine, then by project: the folder's git repository, or the repository's main folder when the site sits in a worktree. From 0.22.5 a page that a session added, or that the hub found in a session's folder, is grouped under that session's name instead, and the heading changes when you rename the session. A page whose session Inyon doesn't know keeps the project's name. The filter matches either. From 0.25 the list is grouped by tmux session first: the heading is the tmux session's name and changes when you rename it, and every site made in that session sits under it, whichever conversation made it. The machine is a small label next to the heading when the list spans more than one machine, or when the machine is offline. Pages with no known session group by project after the sessions. Each card shows the page's name, a bar with how many tasks are done out of how many, what the agent is on now and when that board was last updated. The bar, the line and the time come from the site's `progress.json`, so a page without one shows only its name and when it was added. The hub reads it only when it's a plain file of up to 1 MB, not a symlink. A page you haven't opened since it changed has a dot. From 0.22.4 a task done on a board also comes as a [notification](notifications.md#what-youre-told-about) that opens the page, so you hear "3 of 12 done" without opening the plan.

Tap a card to open the page full screen. The bar on top has:

- **Back**, which returns to the list, or from 0.25 to the session you opened the page from. The phone's own back button does the same, even after you've clicked around inside the page.
- The page's name, and from 0.25 its tmux session under it. From 0.25.3 the machine and the part on screen follow the session's name.
- **⋯** with **Reload**, **Open in browser** (not for a page on a computer paired with the phone directly), which from 0.25 opens the part or note on screen, **Plan**, **Mockups** and **Matrix** when the site has them, the site's [notes](#notes), the other pages on that machine, **Share…** (from 0.25.4) and **Open** the machine. **Reload** opens the page with a new link. Picking a part always loads it, also the one already ticked, which takes you back after the page's own links moved you somewhere else.

Before 0.25.3 the machine and **Notes** had buttons of their own in the bar, which left little room for the name on a narrow phone.

Under the bar, a line says **Sandboxed page: never sign in here**. It stays on screen, so a page can't pass itself off as the app asking for your password.

If the phone loses a hub for a moment (a weak signal, the VPN dropping, the hub restarting), its pages stay on the list, shown as offline, and an open page stays on screen with **Can't reach *hub* now** under the bar. Both catch up when the hub answers again. A hub that answers but refuses the phone, because the phone was forgotten there, is different: its pages leave the list and the app says ***hub* forgot this phone** until you pair it again.

Long-press a card, or use its **⋯**, for **Open**, **Open in browser**, **Share…** (from 0.25.4, see [Share a blueprint](#share-a-blueprint)), **Revoke links**, **Show folder** and **Remove**. **Show folder** lists the folder's path, the machine, the project and which agent added the page.

The Android app lists the pages of every hub you paired, all together, and from 0.24 also those on the computers paired with the phone directly.

### Blueprints on the phone's own computers

A computer paired with the phone over the phone link needs no hub for its pages. The phone asks the computer's own `inyon` for the list and for each file of a page, over the same encrypted link it uses for everything else, and shows the page in the same sandboxed viewer. The rules are the hub's: nothing outside the page's folder, no names starting with a dot, nothing a symlink leads to outside the folder. A page there can't load anything from the internet either.

A few things differ from a page behind a hub:

- There's no **Open in browser** or **Share…**: the page has no address outside the app. **Revoke links** still ends the link on screen.
- The phone asks a computer for one file at a time, so a site with many files takes a moment to open the first time. While a page is open the phone keeps the files it already has until something in that folder changes.
- A single file can be up to 4 MB.
- **Add a folder** offers each computer that's online, next to each hub's own machine.
- The computer needs `inyon` 0.22 or later. With an older one the list says **Update inyon on *machine* to open its pages here.**

## On a desktop

**Blueprints** sits in the sidebar between **Machines** and **Settings**, with the number of pages, or of changed pages when there are any. The screen has the list on the left as a tree of sessions and projects (of machines and projects before 0.25), with a filter (press `/` to jump to it), and the open page on the right. Right-click a row for the same menu as on a phone. Clicking the open page's row again opens it with a new link, as **Reload** does.

Above the page:

| Control | What it does |
|---|---|
| The path | Machine, tmux session (or project) and page, so you know which copy you're looking at |
| **Plan**, **Mockups**, **Matrix** | Jump between a Blueprint site's parts, when it has more than one. A click always loads the part, also the one already selected |
| **Notes** | From 0.22.4, when the site has notes: open one in place of the page. See [Notes](#notes) |
| **Fit**, **Phone**, **Tablet**, **Desktop** | Show the page filling the pane, or at 390 × 844, 820 × 1180 or 1440 × 900, scaled down to fit |
| Reload | Load the page again, with a new link |
| Open in new tab | The page on its own in a browser tab, with a new 12-hour link. From 0.25 it opens the part or note on screen |
| **⋯** | **Share…** (from 0.25.4), **Revoke links**, **Copy folder path**, **Show folder** and **Remove** |

A machine's own page lists its pages too, under **Blueprints on this machine**.

## Notes

From 0.22.4 the Markdown files in a site's `research` folder, where Blueprint keeps the notes a plan is built from, open in the viewer. **Notes** lists them by name; pick one and it takes the page's place, set as a page to read in the app's light or dark. A line under the bar (on a phone) or the **Notes** button (on a desktop) says which note is open, and **Back to Plan**, or any of **Plan**, **Mockups** and **Matrix**, brings the page back. A link from one note to another opens as a note too.

Only files directly in `research` count, ending in `.md` and not starting with a dot, up to 200 of them, and only when `research` is a real folder rather than a symlink. A note is served under the same link and sandbox as the page, so the same checks apply, HTML written in a note shows as text instead of running, and a link that isn't to a web or email address or to the page's own files does nothing. A note over 1 MB is shown as plain text. For a page on another computer, that computer's `inyon` lists its notes, from 0.22.4.

## Links and removing

The app opens each page with a link the hub signs for that page alone. A link lasts 12 hours. The app makes a new one every time you open a page or press **Reload**, and again an hour before it runs out, while the page is on screen or as soon as you come back to it. If the hub doesn't answer then, the app tries again after a minute, then waits twice as long each time, up to 10 minutes, while the page stays on screen. The app counts those 12 hours on its own clock from when the hub answered, so a phone whose clock is off still renews in time. **Open in browser** and **Open in new tab** make a new link each time, so a tab works for 12 hours from when you opened it. Open the page from the app again for a fresh one.

- **Revoke links** ends every link made for that page so far: tabs on other devices, links you copied, [shared links](#share-a-blueprint), and the one on screen, which the app replaces at once.
- **Remove** takes the page off the list, and its links stop working. The folder and its files stay on the machine. The message that confirms it has **Undo** for a few seconds.

Changing the hub's password ends the links of every page, and forgetting a phone ends the links it made.

### Old blueprints are cleaned up

From 0.25 the hub tidies the list by itself. A blueprint goes when both its tmux session and the conversation that made it have ended, and it hasn't changed for 14 days. A change means it was added or its progress board moved. It leaves the list the way **Remove** takes it off: its links stop working, its folder and files stay where they are, and the hub doesn't [find](#blueprints-the-hub-finds) that folder again by itself.

The hub looks once an hour while Inyon is open somewhere. A line over the list names what went, until you dismiss it. Set the days, or turn it off, in [Settings › Blueprints](settings.md#blueprints). **Clean up now** there does it at once.

A blueprint only goes when Inyon can tell its session is over:

- Inyon has to know which session it came from. One added by hand outside tmux stays.
- Its computer has to be connected. A blueprint on a computer that's away stays.
- If a tmux session still has its name or its id, it stays, because that may be the same session, renamed.
- From 0.25.5, a blueprint with a live [shared link](#share-a-blueprint) stays until the link ends or you revoke it, so a link you handed out doesn't stop early.

## Share a blueprint

From 0.25.4 you can hand a blueprint to someone who doesn't use Inyon, such as a product manager or a teammate, with a link of its own. Pick **Share…** in the blueprint's **⋯** menu or the viewer's **⋯**. From 0.25.5 it's also on a blueprint opened in a session's **Blueprints** tab, so you can share it without leaving the session. The sheet asks two things:

| Choice | Options | Default |
|---|---|---|
| Who can open it | **People on your network**, **Anyone with the link** | People on your network |
| Expires after | 1 day, 7 days, 30 days | 7 days |

- **People on your network** makes a link on the hub's own address, the one you have the app open at. It opens only on devices that already reach the hub, such as those on your VPN, and only under the names the hub answers to. Nothing about the hub changes.
- **Anyone with the link** makes a link on the hub's [address for shared links](hub.md#a-public-address-for-shared-blueprints). It stays greyed out, with a line saying where to set that address, until the hub has one. That's a separate step on purpose: nothing is reachable from outside your network until you set an address and point a reverse proxy at it.

**Create link** makes the link and copies it. Keep it then: the hub stores only a fingerprint of each link, so it can't show it again. Under it the sheet lists the blueprint's live links: who each is for, when it ends, how often it was opened and when it was made, with **Revoke** to end one at once. A visit counts as an open when the link's first page loads. [Settings › Blueprints](settings.md#blueprints) lists the live links of every blueprint, with **Revoke all**.

A shared link opens the blueprint read-only, in the same sandbox as in the app, with no sign-in and no cookies. It ends when it runs out, when you revoke it, when you use **Revoke links** on the blueprint, or when the blueprint is removed (from 0.25.5 cleanup leaves a blueprint with a live link alone). Whoever opens it after that sees **Link expired**. A link for your network never opens on the address for shared links, even if someone passes it on.

> **Warning:** A shared link opens every file in the blueprint's folder, not only the page: the research notes, `progress.json`, pictures, anything an agent saved there. Names starting with a dot and files a symlink leads to outside the folder stay hidden, as in the app. Look through the folder before you share it outside your network.

A blueprint on another computer can be shared too, through the hub; that computer has to be online for the link to open. One on a computer paired with the phone alone has no **Share…**, since it has no address outside the app.

## What a page can't do

An agent wrote the page, and an agent can be talked into writing anything, so Inyon treats every page as a stranger's website:

- **It can't act as you.** The page runs in a sandbox, and the browser treats it as a site of its own. It never sees your sign-in, can't call Inyon to read your sessions or type into them, and can't read anything the app keeps on your device.
- **It can't load from the internet.** Scripts, styles, fonts, pictures and data have to be files in its own folder, linked with relative paths. A font from Google Fonts or a script from a CDN won't load, so keep them in the folder.
- **It can't see its folder's private files.** Names starting with a dot, such as `.git` or `.env`, are never served, and neither is anything a symlink leads to outside the folder.
- **It can't keep things.** The browser gives it no cookies and no storage, so a page that tries to save settings gets an error instead.

A page can still run its own scripts, handle its forms in those scripts, open links in a new window and offer files to download, which is what a plan page needs. [Security](security.md#blueprints) has the details.

## What a page can still do

The sandbox keeps a page away from your sign-in. It can't keep a page off the internet:

- **It can reach the internet without you seeing it.** No browser lets Inyon block every way out yet. A page's script can open a WebRTC connection, make the browser look up a name in DNS, move to another address or open a window, and nothing on screen has to change.
- **What it can carry out** is anything the agent that wrote it could read, and anything you type into the page. An agent whose sandbox has no network but can read your disk could copy a key or a token into the page's folder, and the page would send it from your browser.

So treat a page you didn't check like a link from a stranger:

> **Warning:** Never type a password, token or key into a page. Inyon never asks you to sign in inside a page. A page opened in its own tab shows your hub's address in the address bar, because pages are served on the hub's own port. That doesn't make it the hub's sign-in screen. A separate address for pages is planned.

For the same reason, a session's **Preview** tab won't show Inyon's own address. It says **Not shown here**, because a preview of the app could act as you. Open agent-made pages under Blueprints instead.

## When a page won't open

| You see | What to do |
|---|---|
| ***machine* is offline** | The hub's computer is off or out of reach. **Try again** once it's back |
| **Can't reach *hub* now** under the bar, or **The hub is out of reach** | The phone's last check with that hub failed. The page stays as it was and catches up when the hub answers. Check the phone's connection or VPN |
| ***hub* forgot this phone** | The hub refused the phone (it was forgotten on the hub), so its pages left the list. Pair the phone again from the hub |
| **Update inyon on *machine* to open its pages here.** | That computer is paired with the phone directly and runs an `inyon` from before 0.22, which can't serve pages. Run `inyon update` on it |
| **This blueprint is gone** | It was taken off the list on that machine. Add the folder again if you still want it |
| **Couldn't open "*name*"** | The app couldn't get a link from the hub; the reason is under it. **Try again** |
| **Not found** inside the page | The page's folder was moved or deleted, or a link inside the page points at a file that isn't there. `inyon blueprints` on that computer says when a folder is gone; add it again from its new place |
| **~/.inyon/pages.json isn't a page list Inyon can read** | The file isn't valid JSON, isn't a plain file (a named pipe, say) or is bigger than 4 MB. Fix it or delete it, then try again. A symlink to a real list is fine |
| **The hub can't write in ~/.inyon** when adding or removing a page | The hub's user can't write to `~/.inyon` or remove a `pages.json.lock` left behind there. Make sure both belong to the hub's user, then try again |
| **Couldn't revoke the links**, because the hub couldn't write to its data folder | The hub's disk is full or read-only. The old links stay closed only until the hub restarts. Free some space, then revoke again |
| **Link expired** inside the page | An old link, or the page's links were revoked. Press **Reload**, or open the page from the list again |
| **Anyone with the link** is greyed out in **Share…** | The hub has no address for shared links yet. Set one in [Settings › Blueprints](settings.md#blueprints), or with `INYON_SHARE_ORIGIN`, and point a [reverse proxy](hub.md#a-public-address-for-shared-blueprints) at it |
| **This hub can't share blueprints yet. Update it first.** | The page's hub is older than 0.25.4. Update it |
| A shared link opens on your network but not on the share address | It was made for **People on your network**. Make one for **Anyone with the link**. If none opens there, check that the proxy keeps the `Host` header |
| A blank or unstyled page | It loads something from the internet. Copy those files into the folder and link them relatively |
