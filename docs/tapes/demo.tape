# Full navigation + restore demo. Regenerate: vhs docs/tapes/demo.tape
Output docs/demo.gif
Require bun
Set Shell "bash"
Set FontSize 15
Set Width 1280
Set Height 800
Set Padding 16
Set Theme "Catppuccin Mocha"
Set Framerate 24
Set TypingSpeed 90ms

Hide
Type "MOX_CONFIG=docs/demo/config.yaml MOX_DB=docs/demo/mox.db bun --preload @opentui/solid/preload src/index.tsx"
Enter
Sleep 6s
Show

# --- start on INBOX ---
Sleep 1800ms

# --- Inbox -> ALL (g goto, type-to-filter) ---
Type "g"
Sleep 700ms
Type "all"
Sleep 700ms
Enter
Sleep 1600ms
Down@130ms 5
Sleep 900ms

# --- ALL -> Work category ---
Type "g"
Sleep 600ms
Type "work"
Sleep 700ms
Enter
Sleep 1600ms
Down@130ms 3
Sleep 900ms

# --- back to INBOX ---
Type "g"
Sleep 600ms
Type "inbox"
Sleep 700ms
Enter
Sleep 1500ms

# --- mark the top email DONE (e) — it leaves the inbox ---
Type "e"
Sleep 1800ms

# --- find it in ALL (shown with a check) and RESTORE it (u) ---
Type "g"
Sleep 600ms
Type "all"
Sleep 700ms
Enter
Sleep 1600ms
Type "u"
Sleep 1800ms

# --- back to INBOX: restored ---
Type "g"
Sleep 600ms
Type "inbox"
Sleep 700ms
Enter
Sleep 2200ms
