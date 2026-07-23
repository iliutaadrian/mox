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
Sleep 900ms
Screenshot docs/goto.png
