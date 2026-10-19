---
title: Pages
description: Open the plans and mockups your agents build as pages in the app, on your phone or desktop, each one sandboxed away from your sign-in.
---

From 0.20 a site an agent makes, such as a [Blueprint](skills.md#blueprint) plan with its mockups and progress board, opens inside Inyon under **Pages**. You don't run a server or copy a link around: the agent adds the folder once, and the page is in the app on every device you use.

## How a page gets there

An agent with the Blueprint skill does this on its own when it finishes a site. It runs one command, and you can run the same command for any folder with an `index.html` in it:

```sh
inyon pages add ./private/plans/my-plan --name "My plan"
```

It answers with where the page sits in the app:

```
"My plan" is in Inyon: Pages > abhash-arm > custom-tmux
Open it in the app at /pages/local/my-plan
```

`inyon pages` lists the pages on a computer and `inyon pages rm <slug>` takes one off the list. Adding the same folder again is safe and keeps its place. The folder stays where it is, and the app shows its files as they are now, so a page an agent keeps editing is always current. [The inyon command](cli.md#pages) has every option.

In the app, **Add a folder** does the same: pick the machine, type the folder's full path (starting with `/`, or a drive letter on Windows) and a name.

> **Note:** For now Pages shows sites from the hub's own computer only. On another computer `inyon pages add` still saves the page, and says it can't be shown yet.

## On a phone

**Pages** is the second tab, between **Overview** and **+**. Its badge counts pages that changed since you last opened them. The list is grouped by machine, then by project (the folder's git repository). Each card shows the page's name, a bar with how many tasks are done out of how many, what the agent is on now and when it last changed. The bar and the line come from the site's `progress.json`, so a page without one shows only its name and age. A page you haven't opened since it changed has a dot.

Tap a card to open the page full screen. The bar on top has:

- **Back**, which returns to the list. The phone's own back button does the same, even after you've clicked around inside the page.
- The machine's name, a menu of the other pages on that machine and a way to open the machine.
- **⋯** with **Reload**, **Plan**, **Mockups** and **Matrix** when the site has them, and **Open in browser**.

Long-press a card, or use its **⋯**, for **Open**, **Open in browser**, **Revoke links**, **Show folder** and **Remove**. **Show folder** lists the folder's path, the machine, the project and which agent added the page.

The Android app reaches pages through a hub. With only computers paired directly over the phone link, the tab says **Pages open through a hub**; pair one under **Machines** and its pages appear. With several hubs paired, you see all their pages together.

## On a desktop

**Pages** sits in the sidebar between **Machines** and **Settings**, with the number of pages, or of changed pages when there are any. The screen has the list on the left as a tree of machines and projects, with a filter (press `/` to jump to it), and the open page on the right. Right-click a row for the same menu as on a phone.

Above the page:

| Control | What it does |
|---|---|
| The path | Machine, project and page, so you know which copy you're looking at |
| **Plan**, **Mockups**, **Matrix** | Jump between a Blueprint site's parts, when it has more than one |
| **Fit**, **Phone**, **Tablet**, **Desktop** | Show the page filling the pane, or at 390 × 844, 820 × 1180 or 1440 × 900, scaled down to fit |
| Reload | Load the page again |
| Open in new tab | The page on its own, in a browser tab |
| **⋯** | **Revoke links**, **Copy folder path**, **Show folder** and **Remove** |

A machine's own page lists its pages too, under **Pages on this machine**.

## Links and removing

The app opens each page with a link the hub signs for that page alone. A link lasts 12 hours, and the app makes a new one every time you open a page, and again when you come back to the app with less than an hour left. **Open in browser** and **Open in new tab** use the same kind of link, so a tab left open stops working after 12 hours. Open the page from the app again for a fresh one.

- **Revoke links** ends every link made for that page so far: tabs on other devices, links you copied, and the one on screen, which the app replaces at once.
- **Remove** takes the page off the list, and its links stop working. The folder and its files stay on the machine. The message that confirms it has **Undo** for a few seconds.

Changing the hub's password ends the links of every page, and forgetting a phone ends the links it made.

## What a page can't do

An agent wrote the page, and an agent can be talked into writing anything, so Inyon treats every page as a stranger's website:

- **It can't act as you.** The page runs in a sandbox with an address of its own. It never sees your sign-in, can't call Inyon to read your sessions or type into them, and can't read anything the app keeps on your device.
- **It can't load from the internet.** Scripts, styles, fonts, pictures and data have to be files in its own folder, linked with relative paths. A font from Google Fonts or a script from a CDN won't load, so keep them in the folder.
- **It can't see its folder's private files.** Names starting with a dot, such as `.git` or `.env`, are never served, and neither is anything a symlink leads to outside the folder.
- **It can't keep things.** The browser gives it no cookies and no storage, so a page that tries to save settings gets an error instead.

A page can still run its own scripts, handle its forms in those scripts, open links in a new window and offer files to download, which is what a plan page needs. A form can't send what's typed in it anywhere. [Security](security.md#pages) has the details.

For the same reason, a session's **Preview** tab won't show Inyon's own address. It says **Not shown here**, because a preview of the app could act as you. Open agent-made pages under Pages instead.

## When a page won't open

| You see | What to do |
|---|---|
| ***machine* is offline** | The hub's computer is off or out of reach. **Try again** once it's back |
| **This page is gone** | It was taken off the list on that machine. Add the folder again if you still want it |
| **Couldn't open "*name*"** | The reason is under it. If the folder was moved or deleted, `inyon pages` on that computer says so; add it again from its new place |
| **Link expired** inside the page | An old link, or the page's links were revoked. Reopen the page from the list |
| A blank or unstyled page | It loads something from the internet. Copy those files into the folder and link them relatively |
