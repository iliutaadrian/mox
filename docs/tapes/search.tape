Output docs/tapes/.out.gif
Require bun
Set Shell "bash"
Set FontSize 15
Set Width 1500
Set Height 920
Set Padding 18
Set Theme "Catppuccin Mocha"
Hide
Type "MOX_CONFIG=docs/demo/config.yaml MOX_DB=docs/demo/mox.db bun --preload @opentui/solid/preload src/index.tsx"
Enter
Sleep 6s
Show
Type "g"
Sleep 500ms
Type "all"
Sleep 400ms
Enter
Sleep 1200ms
Type "/"
Sleep 300ms
Type "invoice"
Enter
Sleep 1600ms
Screenshot docs/search.png
