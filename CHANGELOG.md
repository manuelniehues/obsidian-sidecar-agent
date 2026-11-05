# Changelog

## 1.11.0

- Standard tasks: save a recurring job with **Save as standard task** in the new-session dialog (agent, model, effort, first message, current note yes or no). The sliders button then opens a list of your tasks, and one click starts the session. Sort, edit and delete under **Edit standard tasks…** in that list. For Antigravity you can pick "Newest Flash model", so a saved task follows new models.
- New layout: the session list, the Claude and Antigravity buttons and the search moved to the bottom of the panel. The list opens right above the buttons that control it, and the terminal stays on top. Both button rows use equal widths, so their columns line up.
- Fixed: the pulsing icon of an Antigravity session could keep going after the task ended. This happened when Antigravity cancelled a background task itself, and when it compacted the conversation right after an answer.

## 1.10.1

- The microphone button shows a green, pulsing microphone while recording, instead of a red crossed-out one that looked like "microphone off".
## 1.10.0

- Voice input: a microphone button in the action row and the command "Voice input: start/stop recording" (assign a hotkey if you like). Click once to talk, click again to stop; the text lands in the prompt line of the active session and is not sent on its own.
- Claude sessions use Claude Code's own dictation: plugin sessions start with voice mode on (hold space to talk, also works on the keyboard), and the button holds the key for you. Fast, no key needed, part of your Claude account. Can be switched off in the settings.
- Antigravity sessions (or Claude sessions with that setting off) transcribe with the Gemini API. Add a Gemini API key under Settings → Voice input; a free key from Google AI Studio is enough. The key is kept in Obsidian's secret storage on this device. The newest Flash model is used, with a fallback to the next one when a model is overloaded. A vocabulary list helps with names and technical terms.
## 1.9.0

- Vault paths and `[[wikilinks]]` in the terminal are links. A click opens a note (or a PDF, image, canvas …) in a new tab, or focuses the tab that already shows it; other files and folders are shown in Finder, nothing is ever run. Paths may contain spaces and a trailing `:12`; only targets that exist are underlined. Option-click shows a note in Finder instead.
- Scheduled runs of a Claude session (`/loop`, cron jobs, wakeups) show as an alarm clock on its tab; the tooltip lists each run with its time, schedule and prompt. Read from the session file, so it covers runs Claude scheduled by itself too. Jobs end with the Claude process, a restarted session starts without them.
- Pace on the limit bars: a thin mark shows where the use would be with an even pace over the window, and the tooltip adds the expected use at the reset or, if the limit comes first, roughly when it is reached. A bar heading for the limit before its reset turns a muted orange.
## 1.8.1

- The limit bars of the Gemini quotas (Antigravity: Gemini group and Argon) are a subtle blue instead of the accent color. Orange and red from 70 and 90 % stay.
## 1.8.0

- Usage limits as bars in the info line, in the same style as the context chip: "5h" and "week" for Claude and for the Antigravity model group of the session, for Antigravity also "Argon" (the separate Gemini 4 Argon weekly quota). Orange from 70 %, red from 90 %, the tooltip shows group, percentage and reset time. In an Argon session, 5h and week come from the general Gemini group.
## 1.7.2

- Consistent text color in the bottom rows: model and effort switches and the Note, Selection and Stop buttons now use the same muted color as the rest of the info line, full color on hover.
## 1.7.1

- Leaner info line: the session name, agent icon and state dot are gone from it, the active tab already shows all three (rename: right-click the tab).
- The note-context chip (which note goes along with your message) moved from the info line to the action row, between "Selection" and "Stop".
## 1.7.0

- Progress row under the session tabs while an agent works: a bar with "3/7" and the current step from Claude's task list (hover shows all steps: ✓ done, ▶ running, ○ open), plus the time since the job started. Without a task list, or for Antigravity, only the time.
- Current Claude Code versions switch the task list tools off by default. Plugin sessions now get them back (`CLAUDE_CODE_ENABLE_TODO_TOOLS=1`, plugin sessions only), so Claude plans larger jobs in steps. Setting "Task list for the progress row", on by default.
## 1.6.0

- "What's new" after an update: the changes of the new version (all versions since the last one you saw, if you skipped some) appear once in a dialog, with a link to the GitHub release. Taken from the changelog bundled with the plugin, no network access. Can be turned off in the dialog or in the settings; the command "What's new in this version" shows it again. Nothing is shown after a fresh install.
## 1.5.2

- "Reload when idle" re-reads `manifest.json`, so Obsidian shows the new version number after the reload.
## 1.5.1

- While an agent works, its icon in the session tab and in the info line pulses (Claude's star, Antigravity's orbit) instead of a separate pulsing dot. The dots for "waiting for you" and "finished while you were away" stay.
## 1.5.0

- Compact for Antigravity sessions too: click the context chip or use the command (now named "Compact active session"). Antigravity gets a plain `/compact`, because there `/compact <text>` would compact and then answer the text.
- Background tasks: a session whose turn ended while a background task still runs (Claude `run_in_background`, Antigravity's background commands) now counts as working. Both agents continue by themselves when the task finishes, so there is no premature "finished" notification and "reload when idle" waits. Claude reports the tasks through its Stop hook, for Antigravity the plugin matches started and finished task ids in the transcript.
- Fixed: the Antigravity state (working / finished) often never changed, because drawing the info line refreshed the cache the state check compared against.
- "Reload when idle" also waits for an Antigravity session that was just started and is not identified yet.
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
