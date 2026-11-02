# Changelog

## 1.4.0

- Session state on the tabs and in the info line: working (pulsing), waiting for you (permission or question), finished while you were looking elsewhere. Claude reports it through hooks (plugin sessions only), Antigravity through its transcript.
- Notifications when a session finishes or waits for you and you are not looking at it: a notice in Obsidian, a system notification when Obsidian is in the background. Clicking it opens the session. Setting "Notifications".
- New command "Reload plugin when no session is working": waits until no answer is running, then reloads. A reload ends the panel terminals, this keeps it from cutting off an answer. An agent in a panel session can trigger it itself.
- Warning when Claude switches to paid usage credits after a limit: red chip in the info line and a notice.
- Compact from the context chip (now or with a focus), a compact button from 85 %, and a command.
- New filter "This note": the sessions that read or edited the note shown in the editor. The index now records the vault files each session touched (tools, shell commands, `@` mentions), for Claude and Antigravity. The first index run after the update takes a little longer.
- Copying in Claude's fullscreen view: its mouse selection (OSC 52) now reaches the clipboard.
- Antigravity: new conversations are found reliably. agy often stores no working folder (outside git repositories), so the plugin also uses agy's last conversation per folder and checks the first prompt, so two sessions started at once do not swap conversations. Conversations started in the panel stay in the list.
- Full-text search without ripgrep is now case-insensitive for umlauts too.
- Tests for the parsers and hooks, and a pre-release check against the installed Claude Code and the newest local sessions.

## 1.3.0

- Context size for Antigravity sessions in the info line: tokens in the context after the last answer, read from the conversation transcript (`input_tokens + cache_read_tokens`), refreshed every 5 s while the session runs. Shown as an absolute number without bar or percentage, because Antigravity does not report the size of the context window.

## 1.2.1

- Subtler context bar: muted accent tint, thinner bar, no coloured text in the warning range (only above 85 % the text turns red).

## 1.2.0

- Context window fill level for Claude sessions: a small bar with percentage in the info line (orange from 65 %, red from 85 %), tooltip with used and total tokens. The plugin's status line stores the value per session after every answer, so it updates live and stays correct when switching tabs. The terminal status line shows it as well.

## 1.1.5

- Subtler agent colours: the new-session buttons in the toolbar and the active session tab use a lighter tint, a fainter border and a muted text colour.

## 1.1.4

- The panel follows Claude Code to the new session after `/clear` or an in-app `/resume`. Before, the reading view, the tab and "resume after restart" stayed on the old session. A SessionStart hook (plugin sessions only) reports the current session id.

## 1.1.3

- Agent colours in the toolbar and the session tabs: Claude keeps the accent colour, Antigravity uses a cold blue. The Antigravity tab icon is now blue instead of orange.

## 1.1.2

- Session tabs look like the new-session buttons in the toolbar: outlined, the active tab tinted with the accent colour.

## 1.1.1

- Slightly larger session tabs (font, padding and icons).

## 1.1.0

- "Jump to top" button: while Claude Code shows its "Jump to bottom" hint after scrolling up, a button at the top right of the terminal jumps to the start of the conversation (Ctrl+Home).

## 1.0.2

- The note context follows the open note when it or its folder is renamed.

## 1.0.1

- Styles no longer use `!important`.

## 1.0.0

First public release.

- Real terminal sessions for Claude Code and Antigravity in the right sidebar, several in parallel as tabs.
- Session list with quick and full-text search, resume, fork, rename and resume with another model.
- Reading view for Claude sessions with Obsidian Markdown and clickable wikilinks.
- Model and effort per session, usage limits, resume after the usage limit.
- Note context, send note or selection, drag and drop, focus lock.
- English and German interface.
